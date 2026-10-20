import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Catalog } from '../../../packages/state-sqlite/src/index.ts';
import { FileStore } from '../../../packages/storage-fs/src/index.ts';
import { StaticRegistry } from '../../../packages/plugin-host/src/index.ts';
import { readLocalText } from '../../../packages/plugin-sdk/src/index.ts';
import { Coordinator } from './coordinator.ts';
import type {
  ProcessorInput,
  ProcessorOutput,
} from '../../../packages/contracts/src/index.ts';
import type { AuditContext } from '../../../packages/contracts/src/audit.ts';
import { safeErrorCode } from '../../../packages/contracts/src/errors.ts';
import { sessionDirectoryDefinition } from '../../../plugins/session-connector/src/directory.ts';
import { jsonlUploadDefinition } from '../../../plugins/session-connector/src/jsonl-upload.ts';
import { jsonlHash } from '../../../plugins/session-connector/src/codex-jsonl.ts';
import type { SessionUpload } from '../../../packages/contracts/src/session-memory.ts';
import {
  sessionJsonlDirectoryDefinition,
  sessionJsonl0161DirectoryDefinition,
} from '../../../plugins/session-connector/src/jsonl-directory.ts';
import {
  AgentTaskSchema,
  AgentResponseSchema,
  agentHash,
  createAgentTask,
  createReviewedAgentDefinition,
  reviewAgentResponse,
  type AgentTask,
  type AgentResponse,
} from '../../../plugins/session-candidates/src/local-agent.ts';

export const SessionMemoryConfigSchema = Type.Object(
  {
    enabled: Type.Boolean({ default: false }),
    format: Type.Optional(
      Type.Union([
        Type.Literal('v1'),
        Type.Literal('codex-jsonl-0.159.2'),
        Type.Literal('codex-jsonl-0.161.0'),
      ]),
    ),
    dataRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    directory: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    inputMode: Type.Optional(
      Type.Union([Type.Literal('directory'), Type.Literal('upload')]),
    ),
    projectScope: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);
export type SessionMemoryConfig = Static<typeof SessionMemoryConfigSchema>;
export const memoryVersion = (config: SessionMemoryConfig) =>
  config.format === 'codex-jsonl-0.161.0' ? '0.161.0' : '0.159.2';
export const memoryConnector = (config: SessionMemoryConfig) =>
  config.inputMode === 'upload'
    ? jsonlUploadDefinition(memoryVersion(config))
    : config.format === 'codex-jsonl-0.161.0'
      ? sessionJsonl0161DirectoryDefinition
      : config.format === 'codex-jsonl-0.159.2'
        ? sessionJsonlDirectoryDefinition
        : sessionDirectoryDefinition;
export const memoryBindingConfig = (config: SessionMemoryConfig) => ({
  enabled: true,
  ...(config.inputMode === 'upload' ? {} : { directory: config.directory }),
  projectScope: config.projectScope,
});
const nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
  Type.Union([schema, Type.Null()]);
export const MemoryStateSchema = Type.Object(
  {
    schema: Type.Literal('opencontext.session-memory-state/v1'),
    configHash: Type.String(),
    projectId: Type.String(),
    bindingId: Type.String(),
    processedVersion: nullable(Type.String()),
    taskVersion: nullable(Type.String()),
    task: Type.Union([AgentTaskSchema, Type.Null()]),
    response: Type.Union([AgentResponseSchema, Type.Null()]),
    reviewHash: nullable(Type.String()),
    runId: nullable(Type.String()),
    error: nullable(Type.String()),
    status: Type.Union(
      [
        'idle',
        'pending',
        'review',
        'failed',
        'cancelled',
        'publishing',
        'published',
      ].map((s) => Type.Literal(s)),
    ),
  },
  { additionalProperties: false },
);
type State = Static<typeof MemoryStateSchema>;
export type MemoryApproval = {
  task: AgentTask;
  response: AgentResponse;
  reviewHash: string;
};
export type MemoryHost = {
  catalog: Catalog;
  store: FileStore;
  registry: StaticRegistry;
  coordinator: Coordinator;
  setApproval(value: MemoryApproval | undefined): void;
  audit?: AuditContext;
};
export type MemoryArgument =
  | string
  | {
      response?: unknown;
      taskId?: string;
      reviewHash?: string;
      upload?: SessionUpload;
      expectedUploadHash?: string | null;
      expectedUploadId?: string | null;
    };
export type MemoryCommand =
  'sync' | 'status' | 'submit' | 'approve' | 'retry' | 'cancel' | 'upload';

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (
    realpathSync(path) !== resolve(path) ||
    (statSync(path).mode & 0o077) !== 0
  )
    throw new Error('ROOT_PERMISSIONS_UNSAFE');
}
function atomicText(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(resolve(path, '..'), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function atomic(path: string, value: unknown): void {
  atomicText(path, JSON.stringify(value, null, 2) + '\n');
}
export function memoryPreview(output: ProcessorOutput): string {
  return (
    `# Local Agent publication review\n\nReview SHA-256: ${agentHash(output)}\n\n${output.outputs.length} candidates. Approval replaces the prior generated set for this binding; an empty set removes prior generated candidates. This does not install or approve system rules.\n\n` +
    output.outputs
      .map((item) => `---\n\nFile: ${item.relativePath}\n\n${item.content}`)
      .join('\n')
  );
}

export function memoryInput(
  state: Pick<State, 'projectId' | 'bindingId'>,
  catalog: Catalog,
  store: FileStore,
): ProcessorInput {
  const head = catalog.head(state.projectId);
  if (!head) throw new Error('NO_FORMAL_INPUT');
  return {
    projectId: state.projectId,
    bindingId: state.bindingId,
    inputCommitId: head,
    files: catalog
      .currentFiles(state.projectId)
      .filter(
        (f) =>
          f.bindingId === state.bindingId &&
          f.collection === 'sources' &&
          !f.tombstone &&
          f.freshness === 'fresh',
      )
      .map((file) => ({ file, text: store.readText(file.contentHash) })),
  };
}

/** Offline filesystem-operator authority, like admin.ts. Never accepts reader credentials. */
export async function sessionMemory(
  config: unknown,
  command: MemoryCommand,
  argument?: MemoryArgument,
  signal = new AbortController().signal,
  host?: MemoryHost,
): Promise<{
  status: State['status'] | 'disabled';
  projectId?: string;
  bindingId?: string;
  sourceVersion?: string | null;
  processedVersion?: string | null;
  taskId?: string | null;
  taskPath?: string;
  previewPath?: string;
  reviewHash?: string | null;
  error?: string | null;
}> {
  if (!Value.Check(SessionMemoryConfigSchema, config))
    throw new Error('INVALID_CONFIG');
  if (!config.enabled) return { status: 'disabled' };
  signal.throwIfAborted();
  const { dataRoot, directory } = config;
  if (config.inputMode === 'upload') {
    if (
      directory !== undefined ||
      !config.format?.startsWith('codex-jsonl-') ||
      !isAbsolute(dataRoot)
    )
      throw new Error('INVALID_CONFIG');
  } else if (
    !directory ||
    ![dataRoot, directory].every(isAbsolute) ||
    resolve(dataRoot) === resolve(directory) ||
    resolve(dataRoot).startsWith(resolve(directory) + sep) ||
    resolve(directory).startsWith(resolve(dataRoot) + sep)
  )
    throw new Error('INVALID_PATH');
  // Do not silently initialize a mixed directory or follow links into another data root.
  if (existsSync(dataRoot) && realpathSync(dataRoot) !== resolve(dataRoot))
    throw new Error('UNSAFE_SYMLINK');
  privateDirectory(dataRoot);
  const catalog =
    host?.catalog ??
    new Catalog(resolve(dataRoot, 'control.sqlite'), {
      mode: 'private',
    });
  let coordinator: Coordinator | undefined;
  try {
    const stateRoot = resolve(dataRoot, 'plugin-state', 'session-memory');
    privateDirectory(resolve(dataRoot, 'plugin-state'));
    privateDirectory(stateRoot);
    const statePath = resolve(stateRoot, 'state.json');
    const taskPath = resolve(stateRoot, 'task.json');
    const previewPath = resolve(stateRoot, 'review.md');
    const store = host?.store ?? new FileStore(dataRoot);
    let approval:
      | { task: AgentTask; response: AgentResponse; reviewHash: string }
      | undefined;
    const registry =
      host?.registry ??
      new StaticRegistry([
        memoryConnector(config),
        createReviewedAgentDefinition(() => approval),
      ]);
    coordinator =
      host?.coordinator ?? new Coordinator(catalog, store, dataRoot, registry);
    const worker = coordinator;
    const abort = () => {
      if (!host) void worker.stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      let state: State;
      if (existsSync(statePath)) {
        const value: unknown = JSON.parse(readLocalText(statePath, 16_777_216));
        if (!Value.Check(MemoryStateSchema, value))
          throw new Error('CHECKPOINT_CORRUPT');
        state = value;
        if (state.configHash !== agentHash(config))
          throw new Error('INVALID_CONFIG');
      } else {
        if (!['sync', 'upload'].includes(command))
          throw new Error('CHECKPOINT_MISSING');
        // Reconcile a crash between binding creation and checkpoint persistence.
        const matches = catalog
          .listProjects()
          .flatMap((p) => catalog.listBindings(p.id))
          .filter(
            (b) =>
              b.connector?.packageRef ===
              `${memoryConnector(config).manifest.id}@0.1.0`,
          );
        if (matches.length > 1) throw new Error('CHECKPOINT_CORRUPT');
        let binding = matches[0];
        if (
          binding &&
          JSON.stringify(binding.config) !==
            JSON.stringify(memoryBindingConfig(config))
        )
          throw new Error('CHECKPOINT_CORRUPT');
        if (!binding) {
          const project = catalog.createProject(
            'Local session memory',
            host?.audit,
          );
          binding = catalog.createBinding(
            project.id,
            {
              name: 'Selected Codex exports',
              connector: await registry.prepare(
                {
                  packageRef: `${memoryConnector(config).manifest.id}@0.1.0`,
                  config: memoryBindingConfig(config),
                },
                'connector',
                {},
              ),
              processor: await registry.prepare(
                {
                  packageRef: 'org.opencontext.reviewed-session-agent@0.1.0',
                  config: {},
                },
                'processor',
                {},
              ),
            },
            host?.audit,
          );
        }
        state = {
          schema: 'opencontext.session-memory-state/v1',
          configHash: agentHash(config),
          projectId: binding.projectId,
          bindingId: binding.id,
          processedVersion: null,
          taskVersion: null,
          task: null,
          response: null,
          reviewHash: null,
          runId: null,
          error: null,
          status: 'idle',
        };
        atomic(statePath, state);
      }
      const binding = catalog.getBinding(state.bindingId);
      if (!binding?.active || binding.projectId !== state.projectId)
        throw new Error('BINDING_REVOKED');
      const save = () => atomic(statePath, state);
      const context = { signal, workDir: stateRoot };
      const input = () => memoryInput(state, catalog, store);
      const prepare = async () => {
        state.task = await createAgentTask(input(), context);
        state.taskVersion = catalog.getBinding(state.bindingId)!.sourceVersion;
        state.status = 'pending';
        state.response = null;
        state.reviewHash = null;
        state.runId = null;
        state.error = null;
        save();
        atomic(taskPath, state.task);
        atomic(resolve(stateRoot, 'response-schema.json'), AgentResponseSchema);
      };
      const sync = async () => {
        const run = catalog.enqueue(state.bindingId, 'sync', host?.audit);
        await worker.drain();
        signal.throwIfAborted();
        const done = catalog.getRun(run.id)!;
        if (done.state !== 'published')
          throw new Error(done.error ?? 'PROCESSING_FAILED');
      };
      // A published host run is authoritative if the process died before saving its cursor.
      if (state.status === 'publishing') {
        const run = state.runId ? catalog.getRun(state.runId) : null;
        if (run?.state === 'published') {
          state.status = 'published';
          state.processedVersion = state.taskVersion;
        } else {
          state.status = 'failed';
          state.error = 'PROCESSING_FAILED';
        }
        save();
      }
      if (
        argument &&
        typeof argument === 'object' &&
        command !== 'upload' &&
        argument.taskId !== state.task?.taskId
      )
        throw new Error('INPUT_CHANGED');
      const result = () => ({
        status: state.status,
        projectId: state.projectId,
        bindingId: state.bindingId,
        sourceVersion: catalog.getBinding(state.bindingId)!.sourceVersion,
        processedVersion: state.processedVersion,
        taskId: state.task?.taskId ?? null,
        taskPath,
        previewPath,
        reviewHash: state.reviewHash,
        error: state.error,
      });
      // Reconcile first, then recognize the durable publication on the very first retry.
      if (command === 'approve' && state.status === 'published') {
        const requestedHash =
          typeof argument === 'string' ? argument : argument?.reviewHash;
        if (!state.task || !requestedHash || requestedHash !== state.reviewHash)
          throw new Error('POLICY_DENIED');
        if (
          catalog.getBinding(state.bindingId)!.sourceVersion !==
          state.taskVersion
        )
          throw new Error('INPUT_CHANGED');
        return result();
      }
      const priorResponse = state.status === 'review' ? state.response : null;
      try {
        if (command === 'sync' || command === 'upload') {
          if (command === 'upload') {
            if (
              config.inputMode !== 'upload' ||
              typeof argument !== 'object' ||
              !argument.upload
            )
              throw new Error('POLICY_DENIED');
            const content = JSON.stringify(argument.upload);
            const binding = catalog.getBinding(state.bindingId)!;
            await registry.validateImport(binding.connector!, content, {
              signal,
            });
            const old = catalog.listImports(state.bindingId)[0];
            if (old?.contentHash !== jsonlHash(content)) {
              if (
                (old?.contentHash ?? null) !== argument.expectedUploadHash ||
                (old?.id ?? null) !== argument.expectedUploadId
              )
                throw new Error('IMPORT_CONFLICT');
              signal.throwIfAborted();
              const object = store.putText(content);
              catalog.putImport(
                state.bindingId,
                {
                  id: randomUUID(),
                  filename: 'selected-session-upload.json',
                  ...object,
                },
                old?.id ?? null,
                host?.audit,
              );
            }
          }
          await sync();
          const version = catalog.getBinding(state.bindingId)!.sourceVersion;
          if (state.taskVersion !== version || !state.task) await prepare();
          else if (state.status === 'pending') {
            atomic(taskPath, state.task);
            atomic(
              resolve(stateRoot, 'response-schema.json'),
              AgentResponseSchema,
            );
          }
        } else if (command === 'retry') {
          if (!['failed', 'cancelled'].includes(state.status))
            throw new Error('POLICY_DENIED');
          await sync();
          await prepare();
        } else if (command === 'cancel') {
          if (state.status === 'published') throw new Error('POLICY_DENIED');
          state.status = 'cancelled';
          state.response = null;
          state.reviewHash = null;
          state.error = 'CANCELLED';
          save();
        } else if (command === 'submit') {
          if (
            !argument ||
            !state.task ||
            !['pending', 'review'].includes(state.status)
          )
            throw new Error('POLICY_DENIED');
          const response: unknown =
            typeof argument === 'string'
              ? JSON.parse(readLocalText(argument, 4_194_304))
              : argument.response;
          const output = await reviewAgentResponse(
            state.task,
            input(),
            response,
            context,
          );
          state.response = response as AgentResponse;
          state.reviewHash = agentHash(output);
          state.status = 'review';
          state.error = null;
          atomicText(previewPath, memoryPreview(output));
          save();
        } else if (command === 'approve') {
          const requestedHash =
            typeof argument === 'string' ? argument : argument?.reviewHash;
          if (
            !argument ||
            state.status !== 'review' ||
            !state.task ||
            !state.response ||
            requestedHash !== state.reviewHash
          )
            throw new Error('POLICY_DENIED');
          const output = await reviewAgentResponse(
            state.task,
            input(),
            state.response,
            context,
          );
          if (
            agentHash(output) !== requestedHash ||
            readLocalText(previewPath, 8_388_608) !== memoryPreview(output)
          )
            throw new Error('INPUT_CHANGED');
          approval = {
            task: state.task,
            response: state.response,
            reviewHash: requestedHash!,
          };
          host?.setApproval(approval);
          state.status = 'publishing';
          save();
          const run = catalog.enqueue(state.bindingId, 'process', host?.audit);
          state.runId = run.id;
          save();
          await worker.drain();
          const done = catalog.getRun(run.id)!;
          if (done.state !== 'published') {
            signal.throwIfAborted();
            throw new Error(done.error ?? 'PROCESSING_FAILED');
          }
          // Publication is the commit point. A later cancellation cannot undo it.
          state.status = 'published';
          state.processedVersion = state.taskVersion;
          state.error = null;
          save();
        }
      } catch (error) {
        // Refused approval/cancel actions do not destroy a valid outstanding review.
        // A malformed replacement is not permission to erase an already valid review.
        // Revalidate the previous response so actual source changes still fail closed.
        let refusedReplacement = false;
        if (
          command === 'submit' &&
          priorResponse !== null &&
          state.response === priorResponse &&
          state.status === 'review' &&
          state.task &&
          state.response &&
          !signal.aborted
        ) {
          try {
            const priorInput = input();
            const previous = await reviewAgentResponse(
              state.task,
              priorInput,
              state.response,
              context,
            );
            const currentBinding = catalog.getBinding(state.bindingId);
            refusedReplacement =
              currentBinding?.active === true &&
              currentBinding.projectId === state.projectId &&
              currentBinding.sourceVersion === state.taskVersion &&
              catalog.head(state.projectId) === priorInput.inputCommitId &&
              agentHash(previous) === state.reviewHash &&
              readLocalText(previewPath, 8_388_608) === memoryPreview(previous);
          } catch {
            /* The previous review is no longer safe to retain. */
          }
        }
        if (
          !refusedReplacement &&
          !(error instanceof Error && error.message === 'POLICY_DENIED')
        ) {
          if (
            state.status === 'publishing' &&
            state.runId &&
            catalog.getRun(state.runId)?.state === 'published'
          ) {
            state.status = 'published';
            state.processedVersion = state.taskVersion;
            state.error = null;
          } else {
            state.status = signal.aborted ? 'cancelled' : 'failed';
            state.error = signal.aborted
              ? 'CANCELLED'
              : safeErrorCode(error, 'PROCESSING_FAILED');
            state.reviewHash = null;
            state.response = null;
          }
          save();
        }
        throw error;
      }
      return result();
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } finally {
    host?.setApproval(undefined);
    if (!host) {
      await coordinator?.stop();
      catalog.close();
    }
  }
}
