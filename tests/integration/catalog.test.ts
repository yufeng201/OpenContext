import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  Binding,
  FileEntry,
  ImportedObjectRef,
  PreparedBinding,
  Run,
} from '../../packages/contracts/src/index.ts';
import { Catalog } from '../../packages/state-sqlite/src/index.ts';

const open = new Set<Catalog>();
const temporaryRoots: string[] = [];
const catalogModule = new URL(
  '../../packages/state-sqlite/src/index.ts',
  import.meta.url,
).href;

function preparedBinding(name = 'Synthetic connector'): PreparedBinding {
  return {
    name,
    connector: {
      ref: `connector-${randomUUID()}@1`,
      packageRef: 'test.connector@1.0.0',
      packageDigest: 'c'.repeat(64),
      configHash: 'd'.repeat(64),
      capability: 'connector',
      config: { fixture: true },
    },
    processor: {
      ref: `processor-${randomUUID()}@1`,
      packageRef: 'test.processor@1.0.0',
      packageDigest: 'e'.repeat(64),
      configHash: 'f'.repeat(64),
      capability: 'processor',
      config: { heading: 'Synthetic output' },
    },
  };
}

function imported(
  filename = 'conversation.json',
  overrides: Partial<ImportedObjectRef> = {},
): ImportedObjectRef {
  return {
    id: randomUUID(),
    filename,
    contentHash: 'a'.repeat(64),
    bytes: 30,
    ...overrides,
  };
}

async function childMessage(
  child: ChildProcess,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('CHILD_START_TIMEOUT')),
      5000,
    );
    child.once('message', (message) => {
      clearTimeout(timeout);
      resolve(message as Record<string, unknown>);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`CHILD_EXIT_${code}`));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opencontext-catalog-'));
  temporaryRoots.push(root);
  const dbPath = join(root, 'state', 'control.sqlite');
  const catalog = new Catalog(dbPath);
  open.add(catalog);
  const project = catalog.createProject('Synthetic project');
  const binding = catalog.createBinding(project.id, preparedBinding());
  return { catalog, project, binding, dbPath };
}

function claim(
  catalog: Catalog,
  binding: Binding,
  kind: Run['kind'] = 'sync',
): Run {
  catalog.enqueue(binding.id, kind);
  const run = catalog.claim();
  expect(run).not.toBeNull();
  return run!;
}

function file(binding: Binding, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    fileId: randomUUID(),
    revisionId: randomUUID(),
    contentHash: 'a'.repeat(64),
    bytes: 10,
    projectId: binding.projectId,
    bindingId: binding.id,
    logicalPath: `sources/${binding.id}/README.md`,
    slotKey: 'README.md',
    collection: 'sources',
    ownership: 'source_managed',
    freshness: 'fresh',
    tombstone: false,
    sourceVersion: 'git-sha-1',
    createdAt: new Date().toISOString(),
    derivedFrom: [],
    ...overrides,
  };
}

function publish(
  catalog: Catalog,
  run: Run,
  files: FileEntry[],
  commitId = randomUUID(),
  expectedHead: string | null = null,
) {
  const input = {
    projectId: run.projectId,
    expectedHead,
    commitId,
    manifestHash: 'b'.repeat(64),
    files,
    run,
    sourceVersion: 'git-sha-1',
  };
  catalog.publish(input);
  return input;
}

afterEach(() => {
  for (const catalog of open) catalog.close();
  open.clear();
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('SQLite authority with synthetic local data', () => {
  it('validates and persists generic package/config locks without treating legacy aliases as authority', () => {
    const { catalog, project } = fixture();
    const prepared = preparedBinding('Conversation imports');
    const binding = catalog.createBinding(project.id, prepared);
    const original = JSON.parse(JSON.stringify(prepared)) as PreparedBinding;
    prepared.connector.config.fixture = false;
    binding.connector!.config.fixture = 'caller mutation';
    catalog.db
      .prepare(
        'UPDATE bindings SET instance_ref=?,package_ref=?,config_json=? WHERE id=?',
      )
      .run('legacy-ignored@1', 'legacy.ignored@0.0.0', '{}', binding.id);
    const stored = catalog.getBinding(binding.id)!;
    expect(stored.connector).toEqual(original.connector);
    expect(stored.processor).toEqual(original.processor);
    expect(stored.instanceRef).toBe(original.connector.ref);
    expect(stored.packageRef).toBe(original.connector.packageRef);
    expect(stored.config).toEqual(original.connector.config);
    expect(() =>
      catalog.createBinding(project.id, { ...preparedBinding(), name: ' ' }),
    ).toThrow('INVALID_BINDING');
    const wrongCapability = preparedBinding();
    wrongCapability.connector.capability = 'processor';
    expect(() => catalog.createBinding(project.id, wrongCapability)).toThrow(
      'INVALID_PLUGIN_LOCK',
    );
    const invalidHash = preparedBinding();
    invalidHash.processor.configHash = 'unverified';
    expect(() => catalog.createBinding(project.id, invalidHash)).toThrow(
      'INVALID_PLUGIN_LOCK',
    );
    expect(catalog.listBindings(project.id)).toHaveLength(2);
  });

  it('freezes executable package/config/import snapshots at enqueue and retains them after restart', () => {
    const { catalog, binding, dbPath } = fixture();
    const initial = imported();
    catalog.putImport(binding.id, initial);
    const queued = catalog.enqueue(binding.id, 'sync');
    expect(queued.execution).toEqual({
      instance: binding.connector,
      imports: [initial],
    });
    const frozen = catalog.getRun(queued.id)!.execution;
    queued.execution!.instance.config.fixture = 'mutated returned object';
    queued.execution!.imports.length = 0;
    const replacement = imported(initial.filename, {
      contentHash: 'b'.repeat(64),
    });
    catalog.putImport(binding.id, replacement, initial.id);
    expect(catalog.getRun(queued.id)?.execution).toEqual(frozen);
    expect(catalog.enqueue(binding.id, 'sync').id).toBe(queued.id);
    catalog.close();
    open.delete(catalog);
    const recovered = new Catalog(dbPath);
    open.add(recovered);
    expect(recovered.getRun(queued.id)?.execution).toEqual(frozen);
    expect(recovered.listImports(binding.id)).toEqual([replacement]);
    expect(
      recovered.db
        .prepare(
          'SELECT active FROM binding_imports WHERE binding_id=? AND id=?',
        )
        .get(binding.id, initial.id)?.active,
    ).toBe(0);
  });

  it.each(['add', 'replace', 'delete'] as const)(
    'rejects source publication/noop after an import %s using the durable run snapshot',
    (change) => {
      const { catalog, project, binding } = fixture();
      const initial = imported();
      catalog.putImport(binding.id, initial);
      const run = claim(catalog, binding);
      if (change === 'add')
        catalog.putImport(binding.id, imported('second.json'));
      if (change === 'replace')
        catalog.putImport(
          binding.id,
          imported(initial.filename, { contentHash: 'b'.repeat(64) }),
          initial.id,
        );
      if (change === 'delete') catalog.removeImport(binding.id, initial.id);
      // Supplying the current set in the caller's Run must not overwrite the
      // enqueue-time lock already stored in the authority database.
      run.execution!.imports = catalog.listImports(binding.id);
      expect(() => publish(catalog, run, [file(binding)])).toThrow(
        'INPUT_CHANGED',
      );
      expect(() => catalog.completeNoop(run, null, 'unpublished-sha')).toThrow(
        'INPUT_CHANGED',
      );
      expect(catalog.head(project.id)).toBeNull();
      expect(catalog.pendingOutbox()).toEqual([]);
      expect(catalog.getBinding(binding.id)?.sourceVersion).toBeNull();
      expect(catalog.getRun(run.id)?.execution?.imports).toEqual([initial]);
      catalog.failRun(run, 'INPUT_CHANGED');
      expect(catalog.getRun(run.id)?.state).toBe('superseded');
      const replacement = catalog.enqueue(binding.id, 'sync');
      expect(replacement.id).not.toBe(run.id);
      expect(replacement.execution?.imports).toEqual(
        catalog.listImports(binding.id),
      );
    },
  );

  it('pins processor configuration and input commit while allowing unrelated import changes', () => {
    const { catalog, binding } = fixture();
    const initial = publish(catalog, claim(catalog, binding), [file(binding)]);
    const process = claim(catalog, binding, 'process');
    expect(process.execution?.instance).toEqual(binding.processor);
    expect(process.inputCommit).toBe(initial.commitId);
    catalog.putImport(binding.id, imported());
    catalog.completeNoop(process, initial.commitId);
    expect(catalog.getRun(process.id)?.state).toBe('published');
    expect(catalog.getRun(process.id)?.inputCommit).toBe(initial.commitId);
    expect(catalog.getRun(process.id)?.execution?.imports).toEqual([]);
  });

  it('uses compare-and-swap import replacement and preserves the current object on conflicts/stale deletes', () => {
    const { catalog, binding } = fixture();
    const initial = imported();
    expect(catalog.putImport(binding.id, initial)).toEqual(initial);
    expect(
      catalog.putImport(binding.id, imported(initial.filename), 'stale-client'),
    ).toEqual(initial);
    const replacement = imported(initial.filename, {
      contentHash: 'b'.repeat(64),
    });
    expect(() => catalog.putImport(binding.id, replacement)).toThrow(
      'IMPORT_CONFLICT',
    );
    expect(() =>
      catalog.putImport(binding.id, replacement, 'stale-client'),
    ).toThrow('IMPORT_CONFLICT');
    expect(catalog.listImports(binding.id)).toEqual([initial]);
    expect(catalog.putImport(binding.id, replacement, initial.id)).toEqual(
      replacement,
    );
    expect(() => catalog.removeImport(binding.id, initial.id)).toThrow(
      'NOT_FOUND',
    );
    expect(catalog.listImports(binding.id)).toEqual([replacement]);
    expect(() =>
      catalog.putImport(
        binding.id,
        { ...replacement, contentHash: 'c'.repeat(64) },
        replacement.id,
      ),
    ).toThrow('IMPORT_ID_COLLISION');
    expect(catalog.listImports(binding.id)).toEqual([replacement]);
    catalog.removeImport(binding.id, replacement.id);
    expect(catalog.listImports(binding.id)).toEqual([]);
  });

  it('enforces per-binding import count/byte limits inside the replacement transaction', () => {
    const { catalog, project, binding } = fixture();
    for (let index = 0; index < 32; index++)
      catalog.putImport(binding.id, imported(`${index}.json`));
    expect(() =>
      catalog.putImport(binding.id, imported('overflow.json')),
    ).toThrow('IMPORT_LIMIT');
    const current = catalog.listImports(binding.id)[0]!;
    const replacement = imported(current.filename, {
      contentHash: 'b'.repeat(64),
    });
    catalog.putImport(binding.id, replacement, current.id);
    expect(catalog.listImports(binding.id)).toHaveLength(32);
    const other = catalog.createBinding(
      project.id,
      preparedBinding('Byte limit fixture'),
    );
    const large = imported('large.json', { bytes: 10 * 1024 * 1024 });
    catalog.putImport(other.id, large);
    expect(() =>
      catalog.putImport(other.id, imported('overflow.json', { bytes: 1 })),
    ).toThrow('IMPORT_LIMIT');
    expect(catalog.listImports(other.id)).toEqual([large]);
    catalog.putImport(
      other.id,
      imported('large.json', { contentHash: 'b'.repeat(64), bytes: 1 }),
      large.id,
    );
    catalog.putImport(other.id, imported('next.json'));
    expect(catalog.listImports(other.id)).toHaveLength(2);
  });

  it('isolates imported object references by binding and rejects revoked access', () => {
    const { catalog, project, binding } = fixture();
    const other = catalog.createBinding(
      project.id,
      preparedBinding('Other binding'),
    );
    const item = imported();
    catalog.putImport(binding.id, item);
    expect(catalog.listImports(other.id)).toEqual([]);
    expect(() => catalog.removeImport(other.id, item.id)).toThrow('NOT_FOUND');
    expect(() =>
      catalog.putImport(binding.id, imported('../escape.json')),
    ).toThrow('INVALID_IMPORT');
    expect(() => catalog.putImport('missing-binding', imported())).toThrow(
      'NOT_FOUND',
    );
    catalog.revokeBinding(binding.id);
    expect(() => catalog.listImports(binding.id)).toThrow('BINDING_REVOKED');
    expect(() => catalog.putImport(binding.id, imported())).toThrow(
      'BINDING_REVOKED',
    );
    expect(() => catalog.removeImport(binding.id, item.id)).toThrow(
      'BINDING_REVOKED',
    );
  });

  it('migrates legacy bindings only through the resolver and permanently fails unpinned legacy runs', () => {
    const { catalog, binding, dbPath } = fixture();
    const running = claim(catalog, binding);
    const queued = catalog.enqueue(binding.id, 'process');
    catalog.db.exec(
      'ALTER TABLE bindings DROP COLUMN connector_json; ALTER TABLE bindings DROP COLUMN processor_json; ALTER TABLE runs DROP COLUMN execution_json;',
    );
    catalog.close();
    open.delete(catalog);
    const migrated = new Catalog(dbPath);
    open.add(migrated);
    const legacy = migrated.getBinding(binding.id)!;
    expect(legacy.connector).toBeNull();
    expect(legacy.processor).toBeNull();
    expect(legacy.packageRef).toBe('test.connector@1.0.0');
    for (const old of [running, queued]) {
      expect(migrated.getRun(old.id)?.state).toBe('failed');
      expect(migrated.getRun(old.id)?.error).toBe('LEGACY_RUN_REQUIRES_RETRY');
      expect(migrated.getRun(old.id)?.execution).toBeNull();
    }
    expect(migrated.claim()).toBeNull();
    expect(() => migrated.enqueue(binding.id, 'sync')).toThrow(
      'LEGACY_BINDING_REQUIRES_MIGRATION',
    );
    const replacement = preparedBinding('Explicit migration');
    migrated.migrateLegacyBindings((old) => {
      expect(old.id).toBe(binding.id);
      expect(old.config).toEqual({ fixture: true });
      return replacement;
    });
    expect(migrated.getBinding(binding.id)?.connector).toEqual(
      replacement.connector,
    );
    expect(migrated.getBinding(binding.id)?.processor).toEqual(
      replacement.processor,
    );
    migrated.migrateLegacyBindings(() => {
      throw new Error('ALREADY_MIGRATED');
    });
    const newRun = migrated.enqueue(binding.id, 'sync');
    expect(newRun.execution?.instance).toEqual(replacement.connector);
    expect(migrated.getRun(running.id)?.state).toBe('failed');
    expect(migrated.getRun(queued.id)?.execution).toBeNull();
  });

  it('rolls back an entire legacy binding migration when a resolver fails', () => {
    const { catalog, project, binding } = fixture();
    const other = catalog.createBinding(
      project.id,
      preparedBinding('Second legacy binding'),
    );
    catalog.db.exec(
      'UPDATE bindings SET connector_json=NULL,processor_json=NULL',
    );
    let count = 0;
    expect(() =>
      catalog.migrateLegacyBindings(() => {
        if (++count === 2) throw new Error('SYNTHETIC_RESOLVER_FAILURE');
        return preparedBinding('Proposed migration');
      }),
    ).toThrow('SYNTHETIC_RESOLVER_FAILURE');
    expect(catalog.getBinding(binding.id)?.connector).toBeNull();
    expect(catalog.getBinding(other.id)?.connector).toBeNull();
  });

  it('uses durable local settings and deduplicates active work per binding/kind', () => {
    const { catalog, project, binding } = fixture();
    expect(catalog.db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe(
      'wal',
    );
    expect(catalog.db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2);
    expect(catalog.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(
      1,
    );
    const first = catalog.enqueue(binding.id, 'sync');
    expect(catalog.enqueue(binding.id, 'sync').id).toBe(first.id);
    const run = catalog.claim()!;
    expect(run.fence).toBe('1');
    expect(catalog.enqueue(binding.id, 'sync').id).toBe(run.id);
    expect(catalog.enqueue(binding.id, 'process').kind).toBe('process');
    expect(catalog.listRuns(project.id)).toHaveLength(2);
    const lease = catalog.db
      .prepare('SELECT lease_until FROM runs WHERE id=?')
      .get(run.id)?.lease_until;
    expect(Number(lease) - Date.now()).toBeGreaterThan(60_000);
    expect(binding.instanceRef).toBe(binding.connector?.ref);
    expect(binding.packageRef).toBe('test.connector@1.0.0');
  });

  it('stores only hashed reader tokens with current project scope and revocation', () => {
    const { catalog, project } = fixture();
    const second = catalog.createProject('Other project');
    const credentials = catalog.createReaderToken(project.id);
    const owner = 'synthetic-owner-token-never-persisted';
    expect(catalog.authenticate(owner, owner)).toEqual({
      id: 'owner',
      role: 'owner',
      projectId: null,
    });
    expect(catalog.authenticate(credentials.token, owner)?.projectId).toBe(
      project.id,
    );
    expect(catalog.authenticate(credentials.token, owner)?.projectId).not.toBe(
      second.id,
    );
    expect(catalog.authenticate('incorrect', owner)).toBeNull();
    expect(catalog.authenticate('', '')).toBeNull();
    const row = catalog.db.prepare('SELECT * FROM reader_tokens').get();
    expect(JSON.stringify(row)).not.toContain(credentials.token);
    expect(String(row?.token_hash)).toMatch(/^[a-f0-9]{64}$/);
    catalog.revokeToken(credentials.id);
    expect(catalog.authenticate(credentials.token, owner)).toBeNull();
  });

  it('atomically publishes the snapshot, cursor, run receipt and one outbox record', () => {
    const { catalog, project, binding } = fixture();
    const run = claim(catalog, binding);
    const source = file(binding);
    const input = publish(catalog, run, [source]);
    expect(catalog.head(project.id)).toBe(input.commitId);
    expect(catalog.currentFiles(project.id)).toEqual([source]);
    expect(
      catalog.getRevision(project.id, source.fileId, source.revisionId),
    ).toEqual(source);
    expect(
      catalog.getRevisionCommit(project.id, source.fileId, source.revisionId),
    ).toBe(input.commitId);
    expect(catalog.getBinding(binding.id)?.sourceVersion).toBe('git-sha-1');
    expect(catalog.getRun(run.id)?.resultCommit).toBe(input.commitId);
    catalog.publish(input);
    expect(catalog.pendingOutbox()).toHaveLength(1);
    catalog.ackOutbox(catalog.pendingOutbox()[0]!.id);
    expect(catalog.pendingOutbox()).toHaveLength(0);
    expect(
      catalog.getRevision(
        'different-project',
        source.fileId,
        source.revisionId,
      ),
    ).toBeNull();
  });

  it('rolls back every visible record when outbox insertion fails', () => {
    const { catalog, project, binding } = fixture();
    const run = claim(catalog, binding);
    const source = file(binding);
    catalog.db.exec(
      "CREATE TRIGGER simulated_outbox_failure BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAILURE'); END;",
    );
    expect(() => publish(catalog, run, [source])).toThrow('SYNTHETIC_FAILURE');
    expect(catalog.head(project.id)).toBeNull();
    expect(catalog.currentFiles(project.id)).toEqual([]);
    expect(
      catalog.getRevision(project.id, source.fileId, source.revisionId),
    ).toBeNull();
    expect(catalog.getRun(run.id)?.state).toBe('running');
    expect(catalog.getBinding(binding.id)?.sourceVersion).toBeNull();
    expect(
      catalog.db.prepare('SELECT count(*) AS n FROM commits').get()?.n,
    ).toBe(0);
    expect(catalog.pendingOutbox()).toEqual([]);
    catalog.db.exec('DROP TRIGGER simulated_outbox_failure');
    publish(catalog, run, [source]);
    expect(catalog.pendingOutbox()).toHaveLength(1);
  });

  it('rejects moved heads and permits a rebased manifest without rerunning the attempt', () => {
    const { catalog, project, binding } = fixture();
    const first = claim(catalog, binding, 'sync');
    const second = claim(catalog, binding, 'process');
    const source = file(binding);
    const committed = publish(catalog, first, [source]);
    expect(() => publish(catalog, second, [source])).toThrow('HEAD_MOVED');
    expect(catalog.getRun(second.id)?.state).toBe('running');
    expect(catalog.pendingOutbox()).toHaveLength(1);
    const proposed = file(binding, {
      logicalPath: `derived/${binding.id}/overview.md`,
      slotKey: 'overview',
      collection: 'derived',
      ownership: 'generated',
      derivedFrom: [{ fileId: source.fileId, revisionId: source.revisionId }],
    });
    const rebased = publish(
      catalog,
      second,
      [source, proposed],
      randomUUID(),
      committed.commitId,
    );
    expect(catalog.head(project.id)).toBe(rebased.commitId);
    expect(catalog.pendingOutbox()).toHaveLength(2);
  });

  it('preserves immutable revision metadata across rename and rejects hash collisions', () => {
    const { catalog, project, binding } = fixture();
    const source = file(binding);
    const first = publish(catalog, claim(catalog, binding), [source]);
    const rename = {
      ...source,
      logicalPath: `sources/${binding.id}/RENAMED.md`,
    };
    const second = publish(
      catalog,
      claim(catalog, binding),
      [rename],
      randomUUID(),
      first.commitId,
    );
    expect(catalog.currentFiles(project.id)[0]?.logicalPath).toBe(
      rename.logicalPath,
    );
    expect(
      catalog.getRevision(project.id, source.fileId, source.revisionId)
        ?.logicalPath,
    ).toBe(source.logicalPath);
    expect(
      catalog.getRevisionCommit(project.id, source.fileId, source.revisionId),
    ).toBe(first.commitId);
    const run = claim(catalog, binding);
    expect(() =>
      publish(
        catalog,
        run,
        [{ ...rename, contentHash: 'c'.repeat(64) }],
        randomUUID(),
        second.commitId,
      ),
    ).toThrow('REVISION_COLLISION');
    expect(catalog.head(project.id)).toBe(second.commitId);
  });

  it('cannot heartbeat, fail or publish using an expired/replaced attempt', () => {
    const { catalog, binding } = fixture();
    const old = claim(catalog, binding);
    catalog.db
      .prepare('UPDATE runs SET lease_until=? WHERE id=?')
      .run(Date.now() - 1, old.id);
    expect(catalog.heartbeat(old.id, old.fence, old.incarnation)).toBe(false);
    const current = catalog.claim()!;
    expect(current.id).toBe(old.id);
    expect(BigInt(current.fence)).toBe(BigInt(old.fence) + 1n);
    expect(() => publish(catalog, old, [file(binding)])).toThrow('LEASE_LOST');
    expect(() => catalog.failRun(old, 'late failure')).toThrow('LEASE_LOST');
    expect(catalog.heartbeat(old.id, old.fence, old.incarnation)).toBe(false);
    expect(
      catalog.heartbeat(current.id, current.fence, current.incarnation),
    ).toBe(true);
    publish(catalog, current, [file(binding)]);
  });

  it('keeps fencing counters exact beyond JavaScript safe integers', () => {
    const { catalog, binding } = fixture();
    const queued = catalog.enqueue(binding.id, 'sync');
    catalog.db
      .prepare('UPDATE runs SET fence=? WHERE id=?')
      .run('9007199254740993', queued.id);
    expect(catalog.claim()?.fence).toBe('9007199254740994');
  });

  it('reports a contended short transaction as BUSY without changing the queued work', () => {
    const { catalog, binding, dbPath } = fixture();
    const run = catalog.enqueue(binding.id, 'sync');
    const competingWriter = new DatabaseSync(dbPath);
    catalog.db.exec('PRAGMA busy_timeout=0');
    try {
      competingWriter.exec('BEGIN IMMEDIATE');
      expect(() => catalog.claim()).toThrow('BUSY');
      expect(catalog.getRun(run.id)?.state).toBe('queued');
      competingWriter.exec('ROLLBACK');
      expect(catalog.claim()?.id).toBe(run.id);
    } finally {
      competingWriter.close();
    }
  });

  it('rejects a second active Catalog before changing authority or running work', () => {
    const { catalog, binding, dbPath } = fixture();
    const old = claim(catalog, binding);
    expect(() => {
      const second = new Catalog(dbPath);
      open.add(second);
    }).toThrow('CATALOG_IN_USE');
    expect(catalog.getRun(old.id)?.state).toBe('running');
    expect(catalog.heartbeat(old.id, old.fence, old.incarnation)).toBe(true);
    catalog.completeNoop(old, null);
  });

  it('rejects a competing OS process without changing the existing authority', () => {
    const { catalog, binding, dbPath } = fixture();
    const running = claim(catalog, binding);
    const attempt = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { Catalog } from ${JSON.stringify(catalogModule)};
      try { const catalog = new Catalog(process.argv[1]); catalog.close(); process.exitCode = 0; }
      catch (error) { process.stdout.write(error.message); process.exitCode = 2; }
    `,
        dbPath,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(attempt.error).toBeUndefined();
    expect(attempt.status).toBe(2);
    expect(attempt.stdout).toBe('CATALOG_IN_USE');
    expect(catalog.getRun(running.id)?.incarnation).toBe(catalog.incarnation);
    expect(
      catalog.heartbeat(running.id, running.fence, running.incarnation),
    ).toBe(true);
  });

  it('releases OS authority after SIGKILL and recovers a real child process attempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencontext-authority-process-'));
    temporaryRoots.push(root);
    const dbPath = join(root, 'control.sqlite');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { Catalog } from ${JSON.stringify(catalogModule)};
      const catalog = new Catalog(process.argv[1]);
      const project = catalog.createProject('Synthetic crash');
      const binding = catalog.createBinding(project.id, ${JSON.stringify(preparedBinding('Child-process synthetic connector'))});
      catalog.enqueue(binding.id, 'sync');
      const run = catalog.claim();
      process.send({run});
      setInterval(() => { catalog.heartbeat(run.id, run.fence, run.incarnation); }, 1000);
    `,
        dbPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    try {
      const message = await childMessage(child);
      const abandoned = message.run as Run;
      expect(() => {
        const unexpected = new Catalog(dbPath);
        open.add(unexpected);
      }).toThrow('CATALOG_IN_USE');
      await stopChild(child);
      const recovered = new Catalog(dbPath);
      open.add(recovered);
      expect(recovered.getRun(abandoned.id)?.state).toBe('queued');
      expect(recovered.incarnation).not.toBe(abandoned.incarnation);
      const newAttempt = recovered.claim()!;
      expect(BigInt(newAttempt.fence)).toBe(BigInt(abandoned.fence) + 1n);
      expect(
        recovered.heartbeat(
          abandoned.id,
          abandoned.fence,
          abandoned.incarnation,
        ),
      ).toBe(false);
      recovered.completeNoop(newAttempt, null);
    } finally {
      await stopChild(child);
    }
  });

  it('persists demo mode and rejects private reuse before changing incarnation or queues', () => {
    const root = mkdtempSync(join(tmpdir(), 'opencontext-data-mode-'));
    temporaryRoots.push(root);
    const dbPath = join(root, 'control.sqlite');
    const demo = new Catalog(dbPath, { mode: 'demo' });
    open.add(demo);
    const project = demo.createProject('Synthetic demo');
    const binding = demo.createBinding(project.id, preparedBinding());
    const run = claim(demo, binding);
    expect(
      demo.db
        .prepare("SELECT value FROM catalog_meta WHERE key='deployment_mode'")
        .get()?.value,
    ).toBe('demo');
    demo.close();
    open.delete(demo);
    expect(() => {
      const wrong = new Catalog(dbPath);
      open.add(wrong);
    }).toThrow('DATA_MODE_MISMATCH');
    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare("SELECT value FROM catalog_meta WHERE key='incarnation'")
          .get()?.value,
      ).toBe(run.incarnation);
      expect(
        inspection.prepare('SELECT state FROM runs WHERE id=?').get(run.id)
          ?.state,
      ).toBe('running');
    } finally {
      inspection.close();
    }
    const resumed = new Catalog(dbPath, { mode: 'demo' });
    open.add(resumed);
    expect(resumed.getRun(run.id)?.state).toBe('queued');
  });

  it('treats legacy databases as private and refuses demo before any migration', () => {
    const { catalog, binding, dbPath } = fixture();
    const run = claim(catalog, binding);
    catalog.db.exec(
      "DELETE FROM catalog_meta WHERE key='deployment_mode'; ALTER TABLE runs DROP COLUMN skipped_json;",
    );
    catalog.close();
    open.delete(catalog);
    expect(() => {
      const wrong = new Catalog(dbPath, { mode: 'demo' });
      open.add(wrong);
    }).toThrow('DATA_MODE_MISMATCH');
    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        inspection
          .prepare('PRAGMA table_info(runs)')
          .all()
          .some((column) => column.name === 'skipped_json'),
      ).toBe(false);
      expect(
        inspection
          .prepare("SELECT value FROM catalog_meta WHERE key='incarnation'")
          .get()?.value,
      ).toBe(run.incarnation);
      expect(
        inspection.prepare('SELECT state FROM runs WHERE id=?').get(run.id)
          ?.state,
      ).toBe('running');
    } finally {
      inspection.close();
    }
    const resumed = new Catalog(dbPath);
    open.add(resumed);
    expect(
      resumed.db
        .prepare("SELECT value FROM catalog_meta WHERE key='deployment_mode'")
        .get()?.value,
    ).toBe('private');
    expect(resumed.getRun(run.id)?.state).toBe('queued');
  });

  it('closes idempotently and permits independent in-memory authorities', () => {
    const a = new Catalog(':memory:');
    const b = new Catalog(':memory:', { mode: 'demo' });
    open.add(a);
    open.add(b);
    a.createProject('Memory A');
    expect(b.listProjects()).toEqual([]);
    a.close();
    open.delete(a);
    expect(() => a.close()).not.toThrow();
    b.close();
    open.delete(b);
  });

  it('uses the same lifetime authority for a symlink alias and retains the lock file', () => {
    const { catalog, dbPath } = fixture();
    const alias = `${dbPath}.alias`;
    symlinkSync(dbPath, alias);
    expect(() => new Catalog(alias)).toThrow('CATALOG_IN_USE');
    expect(existsSync(`${dbPath}.authority.sqlite`)).toBe(true);
    catalog.close();
    open.delete(catalog);
    expect(() => catalog.close()).not.toThrow();
    expect(existsSync(`${dbPath}.authority.sqlite`)).toBe(true);
    const reopened = new Catalog(alias);
    open.add(reopened);
    expect(() => new Catalog(dbPath)).toThrow('CATALOG_IN_USE');
  });

  it('releases authority when construction fails while reading a corrupt control database', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'opencontext-constructor-failure-'),
    );
    temporaryRoots.push(root);
    const dbPath = join(root, 'control.sqlite');
    writeFileSync(dbPath, 'synthetic invalid SQLite bytes');
    expect(() => new Catalog(dbPath)).toThrow();
    const lock = new DatabaseSync(`${dbPath}.authority.sqlite`);
    try {
      expect(() => lock.exec('BEGIN EXCLUSIVE')).not.toThrow();
    } finally {
      lock.close();
    }
    // The failed instance owns no active connection. Replace only its synthetic
    // corrupt control data; retain the authority file throughout recovery.
    rmSync(dbPath);
    const repaired = new Catalog(dbPath, { mode: 'demo' });
    open.add(repaired);
    expect(
      repaired.db
        .prepare("SELECT value FROM catalog_meta WHERE key='deployment_mode'")
        .get()?.value,
    ).toBe('demo');
  });

  it('recovers running work with a new incarnation and retains committed state/outbox', () => {
    const { catalog, project, binding, dbPath } = fixture();
    const initial = publish(catalog, claim(catalog, binding), [file(binding)]);
    const abandoned = claim(catalog, binding);
    const credentials = catalog.createReaderToken(project.id);
    catalog.revokeToken(credentials.id);
    catalog.close();
    open.delete(catalog);
    const recovered = new Catalog(dbPath);
    open.add(recovered);
    expect(recovered.incarnation).not.toBe(abandoned.incarnation);
    expect(recovered.getRun(abandoned.id)?.state).toBe('queued');
    expect(recovered.head(project.id)).toBe(initial.commitId);
    expect(recovered.pendingOutbox()).toHaveLength(1);
    expect(recovered.authenticate(credentials.token, 'other-owner')).toBeNull();
    expect(
      recovered.heartbeat(abandoned.id, abandoned.fence, abandoned.incarnation),
    ).toBe(false);
    const newAttempt = recovered.claim()!;
    expect(BigInt(newAttempt.fence)).toBe(BigInt(abandoned.fence) + 1n);
    expect(() => recovered.completeNoop(abandoned, initial.commitId)).toThrow(
      'LEASE_LOST',
    );
    recovered.completeNoop(newAttempt, initial.commitId);
  });

  it('does not add commits/events for a valid no-op but still advances the durable source cursor', () => {
    const { catalog, project, binding } = fixture();
    const run = claim(catalog, binding);
    expect(() => catalog.completeNoop(run, 'not-current', 'new-sha')).toThrow(
      'HEAD_MOVED',
    );
    expect(catalog.getBinding(binding.id)?.sourceVersion).toBeNull();
    catalog.completeNoop(run, null, 'new-sha');
    catalog.completeNoop(run, null, 'new-sha');
    expect(catalog.head(project.id)).toBeNull();
    expect(catalog.getRun(run.id)?.state).toBe('published');
    expect(catalog.getBinding(binding.id)?.sourceVersion).toBe('new-sha');
    expect(catalog.pendingOutbox()).toEqual([]);
    expect(
      catalog.db.prepare('SELECT count(*) AS n FROM commits').get()?.n,
    ).toBe(0);
  });

  it('keeps skipped-file diagnostics across failure/restart and rejects stale report writes', () => {
    const { catalog, binding, dbPath } = fixture();
    const old = claim(catalog, binding);
    catalog.setRunSkipped(old, [
      { path: 'large.txt', reason: 'MAX_FILE_BYTES' },
    ]);
    catalog.db.prepare('UPDATE runs SET lease_until=0 WHERE id=?').run(old.id);
    const current = catalog.claim()!;
    expect(() =>
      catalog.setRunSkipped(old, [{ path: 'stale.txt', reason: 'OLD_WORKER' }]),
    ).toThrow('LEASE_LOST');
    const skipped = [{ path: 'binary.png', reason: 'BINARY_UNSUPPORTED' }];
    catalog.setRunSkipped(current, skipped);
    catalog.failRun(current, 'SYNTHETIC_FAILURE');
    catalog.close();
    open.delete(catalog);
    const recovered = new Catalog(dbPath);
    open.add(recovered);
    expect(recovered.getRun(current.id)?.state).toBe('failed');
    expect(recovered.getRun(current.id)?.skipped).toEqual(skipped);
  });

  it('adds the skipped diagnostics column to an existing pre-diagnostics database', () => {
    const { catalog, binding, dbPath } = fixture();
    const queued = catalog.enqueue(binding.id, 'sync');
    catalog.db.exec('ALTER TABLE runs DROP COLUMN skipped_json');
    catalog.close();
    open.delete(catalog);
    const migrated = new Catalog(dbPath);
    open.add(migrated);
    expect(migrated.getRun(queued.id)?.skipped).toEqual([]);
    expect(migrated.claim()?.id).toBe(queued.id);
  });

  it('revokes source and transitive derived reads without rewriting historical revisions', () => {
    const { catalog, project, binding } = fixture();
    const processor = catalog.createBinding(
      project.id,
      preparedBinding('Other producer'),
    );
    const source = file(binding);
    const derived = file(processor, {
      logicalPath: 'derived/first.md',
      collection: 'derived',
      ownership: 'generated',
      derivedFrom: [{ fileId: source.fileId, revisionId: source.revisionId }],
    });
    const downstream = file(processor, {
      logicalPath: 'derived/second.md',
      slotKey: 'second',
      collection: 'derived',
      ownership: 'generated',
      derivedFrom: [{ fileId: derived.fileId, revisionId: derived.revisionId }],
    });
    const unrelated = file(processor, {
      logicalPath: 'sources/other.md',
      slotKey: 'other',
    });
    const initial = publish(catalog, claim(catalog, binding), [
      source,
      derived,
      downstream,
      unrelated,
    ]);
    const old = claim(catalog, binding);
    catalog.enqueue(binding.id, 'process');
    catalog.revokeBinding(binding.id);
    const current = catalog.currentFiles(project.id);
    expect(
      current.filter((entry) => entry.freshness === 'invalid'),
    ).toHaveLength(3);
    expect(
      current.find((entry) => entry.fileId === unrelated.fileId)?.freshness,
    ).toBe('fresh');
    expect(
      catalog.getRevision(project.id, source.fileId, source.revisionId)
        ?.freshness,
    ).toBe('fresh');
    expect(catalog.getRun(old.id)?.state).toBe('failed');
    expect(() => catalog.enqueue(binding.id, 'sync')).toThrow(
      'BINDING_REVOKED',
    );
    expect(() => catalog.completeNoop(old, initial.commitId)).toThrow(
      'BINDING_REVOKED',
    );
    expect(catalog.heartbeat(old.id, old.fence, old.incarnation)).toBe(false);
    const otherAttempt = claim(catalog, processor);
    const resurrected = current.map((entry) =>
      entry.fileId === derived.fileId
        ? { ...entry, freshness: 'fresh' as const }
        : entry,
    );
    expect(() =>
      publish(
        catalog,
        otherAttempt,
        resurrected,
        randomUUID(),
        initial.commitId,
      ),
    ).toThrow('INPUT_INVALID');
  });

  it('rolls back cross-project and duplicate-path proposals', () => {
    const { catalog, project, binding } = fixture();
    const other = catalog.createProject('Other');
    const run = claim(catalog, binding);
    expect(() =>
      publish(catalog, run, [file(binding, { projectId: other.id })]),
    ).toThrow('PROJECT_MISMATCH');
    expect(() =>
      publish(catalog, run, [file(binding), file(binding)]),
    ).toThrow();
    expect(catalog.head(project.id)).toBeNull();
    expect(catalog.currentFiles(project.id)).toEqual([]);
    expect(catalog.pendingOutbox()).toEqual([]);
  });
});
