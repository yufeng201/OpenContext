import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Binding,
  CreateBindingInput,
  FileEntry,
  Principal,
  Project,
  Run,
} from '@opencontext/contracts';

type Row = Record<string, string | number | bigint | null | Uint8Array>;
type PublishInput = {
  projectId: string;
  expectedHead: string | null;
  commitId: string;
  manifestHash: string;
  files: FileEntry[];
  run: Run;
  sourceVersion?: string;
};

const LEASE_MS = 90_000;
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error('CORRUPT_STATE');
  return value;
}

function nullable(row: Row, key: string): string | null {
  return row[key] === null ? null : str(row, key);
}

/** One local authority. Plugins never receive this object or its database. */
export class Catalog {
  readonly db: DatabaseSync;
  readonly incarnation = randomUUID();

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
        head TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bindings (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, instance_ref TEXT NOT NULL UNIQUE,
        package_ref TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        source_version TEXT, last_error TEXT, UNIQUE(project_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, binding_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('sync','process')),
        state TEXT NOT NULL CHECK(state IN ('queued','running','published','failed','superseded')),
        fence TEXT NOT NULL DEFAULT '0' CHECK(length(fence)>0 AND fence NOT GLOB '*[^0-9]*'),
        incarnation TEXT NOT NULL, lease_until INTEGER,
        input_commit TEXT, result_commit TEXT, error TEXT, created_at TEXT NOT NULL,
        skipped_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(skipped_json)),
        FOREIGN KEY(project_id,binding_id) REFERENCES bindings(project_id,id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run
        ON runs(binding_id,kind) WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS commits (
        project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
        parent_id TEXT, manifest_hash TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        created_at TEXT NOT NULL, PRIMARY KEY(project_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revisions (
        project_id TEXT NOT NULL, file_id TEXT NOT NULL, revision_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
        first_commit TEXT NOT NULL, PRIMARY KEY(project_id,file_id,revision_id),
        FOREIGN KEY(project_id,first_commit) REFERENCES commits(project_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS current_files (
        project_id TEXT NOT NULL, file_id TEXT NOT NULL, revision_id TEXT NOT NULL,
        binding_id TEXT NOT NULL, logical_path TEXT NOT NULL,
        tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)),
        entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
        PRIMARY KEY(project_id,file_id),
        FOREIGN KEY(project_id,binding_id) REFERENCES bindings(project_id,id),
        FOREIGN KEY(project_id,file_id,revision_id) REFERENCES revisions(project_id,file_id,revision_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_path
        ON current_files(project_id,logical_path) WHERE tombstone=0;
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
        commit_id TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
        UNIQUE(project_id,commit_id),
        FOREIGN KEY(project_id,commit_id) REFERENCES commits(project_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reader_tokens (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
      ) STRICT;
    `);
    this.transaction(() => {
      if (
        !this.db
          .prepare('PRAGMA table_info(runs)')
          .all()
          .some((column) => column.name === 'skipped_json')
      ) {
        this.db.exec(
          "ALTER TABLE runs ADD COLUMN skipped_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(skipped_json))",
        );
      }
      this.db
        .prepare(
          "INSERT INTO catalog_meta(key,value) VALUES('incarnation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(this.incarnation);
      // A recovered process cannot reuse a previous server's lease, even when a
      // restored backup contains the same fencing counter.
      this.db
        .prepare(
          "UPDATE runs SET state='queued', lease_until=NULL WHERE state='running'",
        )
        .run();
    });
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    let started = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      started = true;
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      if (started) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Certain SQLite failures roll the transaction back automatically;
          // retain the original error rather than hiding it with ROLLBACK.
        }
      }
      if (
        error instanceof Error &&
        'errcode' in error &&
        typeof error.errcode === 'number' &&
        [5, 6].includes(error.errcode & 255)
      ) {
        throw new Error('BUSY', { cause: error });
      }
      throw error;
    }
  }

  private assertAuthority(): void {
    const row = this.db
      .prepare("SELECT value FROM catalog_meta WHERE key='incarnation'")
      .get();
    if (!row || row.value !== this.incarnation) throw new Error('LEASE_LOST');
  }

  createProject(name: string): Project {
    this.assertAuthority();
    const project: Project = {
      id: randomUUID(),
      name,
      head: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)')
      .run(project.id, name, project.createdAt);
    return project;
  }

  listProjects(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY created_at,id')
      .all()
      .map((row) => this.project(row));
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return row ? this.project(row) : null;
  }

  private project(row: Row): Project {
    return {
      id: str(row, 'id'),
      name: str(row, 'name'),
      head: nullable(row, 'head'),
      createdAt: str(row, 'created_at'),
    };
  }

  createBinding(projectId: string, input: CreateBindingInput): Binding {
    this.assertAuthority();
    if (!this.getProject(projectId)) throw new Error('NOT_FOUND');
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO bindings(id,project_id,name,instance_ref,package_ref,config_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        projectId,
        input.name,
        `git-${id}@1`,
        'org.opencontext.repo@0.1.0',
        JSON.stringify({ repoUrl: input.repoUrl, branch: input.branch }),
      );
    return this.getBinding(id)!;
  }

  getBinding(id: string): Binding | null {
    const row = this.db.prepare('SELECT * FROM bindings WHERE id=?').get(id);
    return row ? this.binding(row) : null;
  }

  listBindings(projectId: string): Binding[] {
    return this.db
      .prepare('SELECT * FROM bindings WHERE project_id=? ORDER BY id')
      .all(projectId)
      .map((row) => this.binding(row));
  }

  private binding(row: Row): Binding {
    return {
      id: str(row, 'id'),
      projectId: str(row, 'project_id'),
      name: str(row, 'name'),
      instanceRef: str(row, 'instance_ref'),
      packageRef: str(row, 'package_ref'),
      config: JSON.parse(str(row, 'config_json')) as Binding['config'],
      active: row.active === 1,
      sourceVersion: nullable(row, 'source_version'),
      lastError: nullable(row, 'last_error'),
    };
  }

  createReaderToken(projectId: string): { id: string; token: string } {
    this.assertAuthority();
    if (!this.getProject(projectId)) throw new Error('NOT_FOUND');
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO reader_tokens(id,token_hash,project_id) VALUES(?,?,?)',
      )
      .run(id, digest(token), projectId);
    return { id, token };
  }

  revokeToken(id: string): void {
    this.assertAuthority();
    this.db.prepare('UPDATE reader_tokens SET revoked=1 WHERE id=?').run(id);
  }

  authenticate(token: string, ownerToken: string): Principal | null {
    if (!token || token.length > 4096) return null;
    const hash = digest(token);
    if (
      ownerToken &&
      timingSafeEqual(
        Buffer.from(hash, 'hex'),
        Buffer.from(digest(ownerToken), 'hex'),
      )
    ) {
      return { id: 'owner', role: 'owner', projectId: null };
    }
    const row = this.db
      .prepare(
        'SELECT id,project_id FROM reader_tokens WHERE token_hash=? AND revoked=0',
      )
      .get(hash);
    return row
      ? {
          id: str(row, 'id'),
          role: 'reader',
          projectId: str(row, 'project_id'),
        }
      : null;
  }

  enqueue(bindingId: string, kind: Run['kind']): Run {
    return this.transaction(() => {
      this.assertAuthority();
      const binding = this.getBinding(bindingId);
      if (!binding) throw new Error('NOT_FOUND');
      if (!binding.active) throw new Error('BINDING_REVOKED');
      const existing = this.db
        .prepare(
          "SELECT * FROM runs WHERE binding_id=? AND kind=? AND state IN ('queued','running')",
        )
        .get(bindingId, kind);
      if (existing) return this.run(existing);
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO runs(id,project_id,binding_id,kind,state,incarnation,input_commit,created_at) VALUES(?,?,?,?,'queued',?,?,?)",
        )
        .run(
          id,
          binding.projectId,
          bindingId,
          kind,
          this.incarnation,
          this.head(binding.projectId),
          new Date().toISOString(),
        );
      return this.getRun(id)!;
    });
  }

  listRuns(projectId: string): Run[] {
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC,id',
      )
      .all(projectId)
      .map((row) => this.run(row));
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    return row ? this.run(row) : null;
  }

  private run(row: Row): Run {
    return {
      id: str(row, 'id'),
      projectId: str(row, 'project_id'),
      bindingId: str(row, 'binding_id'),
      kind: str(row, 'kind') as Run['kind'],
      state: str(row, 'state') as Run['state'],
      fence: str(row, 'fence'),
      incarnation: str(row, 'incarnation'),
      inputCommit: nullable(row, 'input_commit'),
      resultCommit: nullable(row, 'result_commit'),
      error: nullable(row, 'error'),
      createdAt: str(row, 'created_at'),
      skipped: JSON.parse(str(row, 'skipped_json')) as {
        path: string;
        reason: string;
      }[],
    };
  }

  claim(): Run | null {
    return this.transaction(() => {
      this.assertAuthority();
      const now = Date.now();
      const row = this.db
        .prepare(
          "SELECT r.* FROM runs r JOIN bindings b ON b.id=r.binding_id WHERE b.active=1 AND (r.state='queued' OR (r.state='running' AND r.lease_until<=?)) ORDER BY r.created_at,r.id LIMIT 1",
        )
        .get(now);
      if (!row) return null;
      const id = str(row, 'id');
      const fence = (BigInt(str(row, 'fence')) + 1n).toString();
      this.db
        .prepare(
          "UPDATE runs SET state='running',fence=?,incarnation=?,lease_until=?,error=NULL WHERE id=?",
        )
        .run(fence, this.incarnation, now + LEASE_MS, id);
      return this.getRun(id)!;
    });
  }

  heartbeat(id: string, fence: string, incarnation: string): boolean {
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT value FROM catalog_meta WHERE key='incarnation'")
        .get();
      if (
        current?.value !== this.incarnation ||
        incarnation !== this.incarnation
      )
        return false;
      const now = Date.now();
      return (
        this.db
          .prepare(
            "UPDATE runs SET lease_until=? WHERE id=? AND state='running' AND fence=? AND incarnation=? AND lease_until>? AND binding_id IN (SELECT id FROM bindings WHERE active=1)",
          )
          .run(now + LEASE_MS, id, fence, incarnation, now).changes === 1
      );
    });
  }

  private activeAttempt(candidate: Run): Run {
    this.assertAuthority();
    const row = this.db
      .prepare('SELECT * FROM runs WHERE id=?')
      .get(candidate.id);
    if (
      !row ||
      row.project_id !== candidate.projectId ||
      row.binding_id !== candidate.bindingId ||
      row.kind !== candidate.kind
    )
      throw new Error('NOT_FOUND');
    if (!this.getBinding(candidate.bindingId)?.active)
      throw new Error('BINDING_REVOKED');
    if (
      row.state !== 'running' ||
      row.fence !== candidate.fence ||
      row.incarnation !== candidate.incarnation ||
      candidate.incarnation !== this.incarnation ||
      typeof row.lease_until !== 'number' ||
      row.lease_until <= Date.now()
    )
      throw new Error('LEASE_LOST');
    return this.run(row);
  }

  failRun(run: Run, error: string): void {
    this.transaction(() => {
      this.activeAttempt(run);
      this.db
        .prepare('UPDATE runs SET state=?,error=?,lease_until=NULL WHERE id=?')
        .run(
          error === 'INPUT_CHANGED' ? 'superseded' : 'failed',
          error.slice(0, 2000),
          run.id,
        );
      this.db
        .prepare('UPDATE bindings SET last_error=? WHERE id=?')
        .run(error.slice(0, 2000), run.bindingId);
    });
  }

  setRunSkipped(run: Run, skipped: { path: string; reason: string }[]): void {
    this.transaction(() => {
      this.activeAttempt(run);
      this.db
        .prepare('UPDATE runs SET skipped_json=? WHERE id=?')
        .run(JSON.stringify(skipped), run.id);
    });
  }

  head(projectId: string): string | null {
    const project = this.getProject(projectId);
    if (!project) throw new Error('NOT_FOUND');
    return project.head;
  }

  manifestHash(projectId: string, commitId: string): string {
    const row = this.db
      .prepare('SELECT manifest_hash FROM commits WHERE project_id=? AND id=?')
      .get(projectId, commitId);
    if (!row) throw new Error('NOT_FOUND');
    return str(row, 'manifest_hash');
  }

  currentFiles(projectId: string): FileEntry[] {
    return this.db
      .prepare(
        'SELECT entry_json FROM current_files WHERE project_id=? ORDER BY logical_path,file_id',
      )
      .all(projectId)
      .map((row) => JSON.parse(str(row, 'entry_json')) as FileEntry);
  }

  getRevision(
    projectId: string,
    fileId: string,
    revisionId: string,
  ): FileEntry | null {
    const row = this.db
      .prepare(
        'SELECT entry_json FROM revisions WHERE project_id=? AND file_id=? AND revision_id=?',
      )
      .get(projectId, fileId, revisionId);
    return row ? (JSON.parse(str(row, 'entry_json')) as FileEntry) : null;
  }

  getRevisionCommit(
    projectId: string,
    fileId: string,
    revisionId: string,
  ): string | null {
    const row = this.db
      .prepare(
        'SELECT first_commit FROM revisions WHERE project_id=? AND file_id=? AND revision_id=?',
      )
      .get(projectId, fileId, revisionId);
    return row ? str(row, 'first_commit') : null;
  }

  private alreadyPublished(run: Run, resultCommit: string | null): boolean {
    const current = this.getRun(run.id);
    if (current?.state !== 'published') return false;
    if (
      current.projectId !== run.projectId ||
      current.bindingId !== run.bindingId ||
      current.fence !== run.fence ||
      current.incarnation !== run.incarnation ||
      current.resultCommit !== resultCommit
    )
      throw new Error('LEASE_LOST');
    return true;
  }

  publish(input: PublishInput): void {
    this.transaction(() => {
      if (input.projectId !== input.run.projectId) throw new Error('NOT_FOUND');
      if (this.alreadyPublished(input.run, input.commitId)) return;
      this.activeAttempt(input.run);
      if (this.head(input.projectId) !== input.expectedHead)
        throw new Error('HEAD_MOVED');
      if (!/^[a-f0-9]{64}$/.test(input.manifestHash))
        throw new Error('INVALID_MANIFEST');
      const proposed = new Map(input.files.map((file) => [file.fileId, file]));
      for (const file of input.files) {
        if (
          file.freshness !== 'invalid' &&
          file.derivedFrom.some((dependency) => {
            const source = proposed.get(dependency.fileId);
            return (
              !source || source.freshness === 'invalid' || source.tombstone
            );
          })
        )
          throw new Error('INPUT_INVALID');
      }
      this.db
        .prepare(
          'INSERT INTO commits(project_id,id,parent_id,manifest_hash,run_id,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          input.projectId,
          input.commitId,
          input.expectedHead,
          input.manifestHash,
          input.run.id,
          new Date().toISOString(),
        );
      this.db
        .prepare('DELETE FROM current_files WHERE project_id=?')
        .run(input.projectId);
      const insertRevision = this.db.prepare(
        'INSERT OR IGNORE INTO revisions(project_id,file_id,revision_id,content_hash,entry_json,first_commit) VALUES(?,?,?,?,?,?)',
      );
      const insertCurrent = this.db.prepare(
        'INSERT INTO current_files(project_id,file_id,revision_id,binding_id,logical_path,tombstone,entry_json) VALUES(?,?,?,?,?,?,?)',
      );
      for (const file of input.files) {
        if (file.projectId !== input.projectId)
          throw new Error('PROJECT_MISMATCH');
        const binding = this.getBinding(file.bindingId);
        if (!binding || binding.projectId !== input.projectId)
          throw new Error('PROJECT_MISMATCH');
        if (!binding.active && file.freshness !== 'invalid')
          throw new Error('BINDING_REVOKED');
        const existing = this.getRevision(
          input.projectId,
          file.fileId,
          file.revisionId,
        );
        if (
          existing &&
          (existing.contentHash !== file.contentHash ||
            existing.bytes !== file.bytes ||
            existing.bindingId !== file.bindingId)
        )
          throw new Error('REVISION_COLLISION');
        const json = JSON.stringify(file);
        insertRevision.run(
          input.projectId,
          file.fileId,
          file.revisionId,
          file.contentHash,
          json,
          input.commitId,
        );
        insertCurrent.run(
          input.projectId,
          file.fileId,
          file.revisionId,
          file.bindingId,
          file.logicalPath,
          Number(file.tombstone),
          json,
        );
      }
      this.activeAttempt(input.run);
      const changed = this.db
        .prepare('UPDATE projects SET head=? WHERE id=? AND head IS ?')
        .run(input.commitId, input.projectId, input.expectedHead);
      if (changed.changes !== 1) throw new Error('HEAD_MOVED');
      this.finish(input.run, input.commitId, input.sourceVersion);
      this.db
        .prepare('INSERT INTO outbox(project_id,commit_id) VALUES(?,?)')
        .run(input.projectId, input.commitId);
    });
  }

  private finish(
    run: Run,
    resultCommit: string | null,
    sourceVersion?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE runs SET state='published',result_commit=?,lease_until=NULL,error=NULL WHERE id=?",
      )
      .run(resultCommit, run.id);
    if (run.kind === 'sync' && sourceVersion !== undefined) {
      this.db
        .prepare(
          'UPDATE bindings SET source_version=?,last_error=NULL WHERE id=?',
        )
        .run(sourceVersion, run.bindingId);
    } else {
      this.db
        .prepare('UPDATE bindings SET last_error=NULL WHERE id=?')
        .run(run.bindingId);
    }
  }

  completeNoop(run: Run, head: string | null, sourceVersion?: string): void {
    this.transaction(() => {
      if (this.alreadyPublished(run, head)) return;
      this.activeAttempt(run);
      if (this.head(run.projectId) !== head) throw new Error('HEAD_MOVED');
      this.finish(run, head, sourceVersion);
    });
  }

  pendingOutbox(): { id: number; projectId: string; commitId: string }[] {
    return this.db
      .prepare(
        'SELECT id,project_id,commit_id FROM outbox WHERE acknowledged=0 ORDER BY id',
      )
      .all()
      .map((row) => ({
        id: Number(row.id),
        projectId: str(row, 'project_id'),
        commitId: str(row, 'commit_id'),
      }));
  }

  ackOutbox(id: number): void {
    this.assertAuthority();
    this.db.prepare('UPDATE outbox SET acknowledged=1 WHERE id=?').run(id);
  }

  revokeBinding(id: string): void {
    this.transaction(() => {
      this.assertAuthority();
      const binding = this.getBinding(id);
      if (!binding) throw new Error('NOT_FOUND');
      this.db.prepare('UPDATE bindings SET active=0 WHERE id=?').run(id);
      this.db
        .prepare(
          "UPDATE runs SET state='failed',lease_until=NULL,error='BINDING_REVOKED' WHERE binding_id=? AND state IN ('queued','running')",
        )
        .run(id);
      const files = this.currentFiles(binding.projectId);
      const invalid = new Set(
        files
          .filter(
            (file) => file.bindingId === id || file.freshness === 'invalid',
          )
          .map((file) => file.fileId),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const file of files) {
          if (
            !invalid.has(file.fileId) &&
            file.derivedFrom.some((dependency) =>
              invalid.has(dependency.fileId),
            )
          ) {
            invalid.add(file.fileId);
            changed = true;
          }
        }
      }
      const update = this.db.prepare(
        'UPDATE current_files SET entry_json=? WHERE project_id=? AND file_id=?',
      );
      for (const file of files) {
        if (invalid.has(file.fileId))
          update.run(
            JSON.stringify({ ...file, freshness: 'invalid' }),
            binding.projectId,
            file.fileId,
          );
      }
    });
  }
}
