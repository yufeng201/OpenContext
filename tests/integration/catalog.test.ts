import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  Binding,
  FileEntry,
  Run,
} from '../../packages/contracts/src/index.ts';
import { Catalog } from '../../packages/state-sqlite/src/index.ts';

const open = new Set<Catalog>();
const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opencontext-catalog-'));
  temporaryRoots.push(root);
  const dbPath = join(root, 'state', 'control.sqlite');
  const catalog = new Catalog(dbPath);
  open.add(catalog);
  const project = catalog.createProject('Synthetic project');
  const binding = catalog.createBinding(project.id, {
    name: 'Synthetic repository',
    repoUrl: '/synthetic/repo',
    branch: 'main',
  });
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
    expect(binding.instanceRef).toBe(`git-${binding.id}@1`);
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

  it('rejects a still-open old authority after another process incarnation takes over', () => {
    const { catalog, binding, dbPath } = fixture();
    const old = claim(catalog, binding);
    const replacement = new Catalog(dbPath);
    open.add(replacement);
    expect(() => catalog.claim()).toThrow('LEASE_LOST');
    expect(catalog.heartbeat(old.id, old.fence, old.incarnation)).toBe(false);
    expect(() => catalog.completeNoop(old, null)).toThrow('LEASE_LOST');
    const current = replacement.claim()!;
    expect(current.id).toBe(old.id);
    expect(current.incarnation).not.toBe(old.incarnation);
    replacement.completeNoop(current, null);
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
    const processor = catalog.createBinding(project.id, {
      name: 'Other producer',
      repoUrl: '/synthetic/other',
      branch: 'main',
    });
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
