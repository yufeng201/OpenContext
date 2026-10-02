import { safeErrorCode } from '@opencontext/contracts/errors';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  Binding,
  ConnectorOutput,
  FileEntry,
  ProcessorOutput,
  Run,
  ImportedObjectRef,
} from '@opencontext/contracts';
import {
  safeRelativePath,
  mergeOwnedSnapshot,
  equalSnapshot,
} from '@opencontext/core';
import { FileStore } from '@opencontext/storage-fs';
import { Catalog } from '@opencontext/state-sqlite';
import { TextIndex } from '@opencontext/retrieval';
import { StaticRegistry } from '@opencontext/plugin-host';

export class Coordinator {
  readonly catalog: Catalog;
  readonly store: FileStore;
  readonly index: TextIndex;
  private readonly dataRoot: string;
  private readonly localRoot: string | undefined;
  private readonly registry: StaticRegistry;
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly abort = new AbortController();
  lastIndexError: string | null = null;
  lastWorkerError: string | null = null;

  private readonly audit:
    | ((run: Run, result: 'success' | 'failed', code: string) => void)
    | undefined;
  constructor(
    catalog: Catalog,
    store: FileStore,
    dataRoot: string,
    registry: StaticRegistry,
    allowedLocalRepoRoot?: string,
    audit?: (run: Run, result: 'success' | 'failed', code: string) => void,
  ) {
    this.audit = audit;
    this.catalog = catalog;
    this.store = store;
    this.dataRoot = dataRoot;
    this.registry = registry;
    this.localRoot = allowedLocalRepoRoot;
    this.index = new TextIndex(catalog.db);
  }
  start(): void {
    this.timer = setInterval(() => {
      void this.drain().catch(() => {
        this.lastWorkerError = 'SCHEDULER_FAILED';
      });
    }, 100);
    this.timer.unref();
    void this.drain().catch(() => {
      this.lastWorkerError = 'SCHEDULER_FAILED';
    });
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.active;
  }
  drain(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.work().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async work(): Promise<void> {
    this.reindex();
    while (!this.abort.signal.aborted) {
      const run = this.catalog.claim();
      if (!run) break;
      try {
        await this.execute(run);
        const completed = this.catalog.getRun(run.id);
        this.audit?.(
          run,
          completed?.state === 'published' ? 'success' : 'failed',
          completed?.error ??
            (completed?.state === 'published' ? 'OK' : 'PROCESSING_FAILED'),
        );
      } catch (error) {
        if (!this.abort.signal.aborted) {
          // Persist stable diagnostics, not raw process output or URLs/tokens.
          const code = safeErrorCode(error, 'PROCESSING_FAILED');
          try {
            this.catalog.failRun(run, code);
            this.audit?.(run, 'failed', code);
          } catch {
            /* revoked/lost lease already has a newer owner */
          }
        }
      }
      this.reindex();
    }
  }
  reindex(): void {
    for (const event of this.catalog.pendingOutbox()) {
      try {
        const head = this.catalog.head(event.projectId);
        if (head === event.commitId) {
          const docs = this.catalog
            .currentFiles(event.projectId)
            .filter((file) => !file.tombstone && file.freshness !== 'invalid')
            .map((file) => ({
              file,
              text: this.store.readText(file.contentHash),
            }));
          this.index.replaceProject(event.projectId, event.commitId, docs);
        }
        this.catalog.ackOutbox(event.id);
        this.lastIndexError = null;
      } catch {
        this.lastIndexError = 'INDEX_REBUILD_FAILED';
        break;
      }
    }
  }
  private async execute(run: Run): Promise<void> {
    const binding = this.catalog.getBinding(run.bindingId);
    if (!binding?.active) throw new Error('BINDING_REVOKED');
    const execution = run.execution;
    if (!execution) throw new Error('LEGACY_RUN_REQUIRES_RETRY');
    const capability = run.kind === 'sync' ? 'connector' : 'processor';
    this.registry.resolve(execution.instance, capability);
    const allowedImports = new Map(
      execution.imports.map((ref) => [ref.id, JSON.stringify(ref)]),
    );
    const base = this.catalog.currentFiles(run.projectId);
    const workDir = resolve(this.dataRoot, 'staging', run.id + '-' + run.fence);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const attemptAbort = new AbortController();
    const context = {
      signal: AbortSignal.any([this.abort.signal, attemptAbort.signal]),
      workDir,
      ...(this.localRoot ? { allowedLocalRepoRoot: this.localRoot } : {}),
      readImport: async (ref: ImportedObjectRef): Promise<string> => {
        if (attemptAbort.signal.aborted || this.abort.signal.aborted)
          throw new Error('CANCELLED');
        if (!this.catalog.getBinding(binding.id)?.active)
          throw new Error('BINDING_REVOKED');
        if (allowedImports.get(ref.id) !== JSON.stringify(ref))
          throw new Error('IMPORT_ACCESS_DENIED');
        return this.store.readText(ref.contentHash);
      },
    };
    const heartbeat = setInterval(() => {
      try {
        if (!this.catalog.heartbeat(run.id, run.fence, run.incarnation))
          attemptAbort.abort();
      } catch {
        attemptAbort.abort();
      }
    }, 10_000);
    heartbeat.unref();
    try {
      let desired: FileEntry[], sourceVersion: string | undefined;
      if (run.kind === 'sync') {
        const output = await this.registry.invokeConnector(
          execution.instance,
          {
            config: execution.instance.config,
            imports: execution.imports,
            previousVersion: binding.sourceVersion,
            maxFiles: 500,
            maxBytes: 10_485_760,
          },
          context,
        );
        this.catalog.setRunSkipped(run, output.skipped);
        desired = this.sourceEntries(binding, output, base);
        sourceVersion = output.sourceVersion;
      } else {
        if (!run.inputCommit) throw new Error('NO_FORMAL_INPUT');
        // Retry is pinned to the enqueue-time source snapshot. An intervening
        // unrelated commit can be rebased without rerunning this processor.
        const snapshot = this.store.readManifest(
          run.projectId,
          run.inputCommit,
          this.catalog.manifestHash(run.projectId, run.inputCommit),
        );
        const inputs = snapshot.files.filter(
          (file) =>
            file.bindingId === binding.id &&
            file.collection === 'sources' &&
            !file.tombstone &&
            file.freshness === 'fresh',
        );
        this.verifyInputs(inputs, base, binding.id);
        const output = await this.registry.invokeProcessor(
          execution.instance,
          {
            config: execution.instance.config,
            projectId: run.projectId,
            bindingId: binding.id,
            inputCommitId: run.inputCommit,
            files: inputs.map((file) => ({
              file,
              text: this.store.readText(file.contentHash),
            })),
          },
          context,
        );
        desired = this.processorEntries(binding, output, base, run.inputCommit);
      }
      for (let retry = 0; retry < 3; retry++) {
        const head = this.catalog.head(run.projectId);
        const current = this.catalog.currentFiles(run.projectId);
        if (run.kind === 'process') {
          const snapshot = this.store.readManifest(
            run.projectId,
            run.inputCommit!,
            this.catalog.manifestHash(run.projectId, run.inputCommit!),
          );
          this.verifyInputs(
            snapshot.files.filter(
              (file) =>
                file.bindingId === binding.id &&
                file.collection === 'sources' &&
                !file.tombstone &&
                file.freshness === 'fresh',
            ),
            current,
            binding.id,
          );
        }
        const collection = run.kind === 'sync' ? 'sources' : 'derived';
        const before = base.filter(
          (file) =>
            file.bindingId === binding.id &&
            (file.collection === collection ||
              file.ownership === 'human_owned'),
        );
        const after = current.filter(
          (file) =>
            file.bindingId === binding.id &&
            (file.collection === collection ||
              file.ownership === 'human_owned'),
        );
        if (!equalSnapshot(before, after)) throw new Error('OUTPUT_CONFLICT');
        const next = mergeOwnedSnapshot(
          current,
          desired,
          binding.id,
          collection,
        );
        if (equalSnapshot(current, next)) {
          this.catalog.completeNoop(run, head, sourceVersion);
          return;
        }
        for (const file of next) this.store.revision(file);
        const commitId = randomUUID();
        const manifestHash = this.store.manifest(
          run.projectId,
          commitId,
          head,
          next,
        );
        try {
          this.catalog.publish({
            projectId: run.projectId,
            expectedHead: head,
            commitId,
            manifestHash,
            files: next,
            run,
            ...(sourceVersion ? { sourceVersion } : {}),
          });
          return;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'HEAD_MOVED')
            throw error;
        }
      }
      throw new Error('HEAD_MOVED');
    } finally {
      clearInterval(heartbeat);
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  private verifyInputs(
    inputs: FileEntry[],
    current: FileEntry[],
    bindingId: string,
  ): void {
    const sources = current.filter(
      (file) =>
        file.bindingId === bindingId &&
        file.collection === 'sources' &&
        !file.tombstone &&
        file.freshness === 'fresh',
    );
    if (
      inputs.length !== sources.length ||
      inputs.some(
        (file) =>
          !sources.some(
            (now) =>
              now.fileId === file.fileId &&
              now.revisionId === file.revisionId &&
              now.logicalPath === file.logicalPath,
          ),
      )
    )
      throw new Error('INPUT_CHANGED');
  }
  private entry(
    binding: Binding,
    slotKey: string,
    relativePath: string,
    text: string,
    collection: 'sources' | 'derived',
    sourceVersion: string,
    dependencies: FileEntry['derivedFrom'],
    old?: FileEntry,
  ): FileEntry {
    safeRelativePath(relativePath);
    const object = this.store.putText(text);
    const reusable =
      old &&
      old.contentHash === object.contentHash &&
      JSON.stringify(old.derivedFrom) === JSON.stringify(dependencies);
    return {
      fileId: old?.fileId ?? randomUUID(),
      revisionId: reusable ? old.revisionId : randomUUID(),
      ...object,
      projectId: binding.projectId,
      bindingId: binding.id,
      slotKey,
      logicalPath: collection + '/' + binding.id + '/' + relativePath,
      collection,
      ownership: collection === 'sources' ? 'source_managed' : 'generated',
      freshness: 'fresh',
      tombstone: false,
      sourceVersion: reusable ? old.sourceVersion : sourceVersion,
      createdAt: reusable ? old.createdAt : new Date().toISOString(),
      derivedFrom: dependencies,
    };
  }
  private sourceEntries(
    binding: Binding,
    output: ConnectorOutput,
    base: FileEntry[],
  ): FileEntry[] {
    if (!output.complete) throw new Error('INCOMPLETE_OUTPUT');
    const previous = base.filter(
      (file) =>
        file.bindingId === binding.id &&
        file.collection === 'sources' &&
        !file.tombstone,
    );
    return output.files.map((item) => {
      const rename = output.renames.find((r) => r.to === item.relativePath);
      const old = previous.find(
        (file) => file.slotKey === (rename?.from ?? item.relativePath),
      );
      return this.entry(
        binding,
        item.relativePath,
        item.relativePath,
        item.content,
        'sources',
        output.sourceVersion,
        [],
        old,
      );
    });
  }
  private processorEntries(
    binding: Binding,
    output: ProcessorOutput,
    base: FileEntry[],
    commitId: string,
  ): FileEntry[] {
    if (!output.complete || output.mode !== 'full')
      throw new Error('INCOMPLETE_OUTPUT');
    return output.outputs.map((item) => {
      const old = base.find(
        (file) =>
          file.bindingId === binding.id &&
          file.slotKey === item.slotKey &&
          (file.collection === 'derived' || file.ownership === 'human_owned'),
      );
      return this.entry(
        binding,
        item.slotKey,
        item.relativePath,
        item.content,
        'derived',
        commitId,
        item.derivedFrom,
        old,
      );
    });
  }
}
