import {
  parseAuditEvent,
  auditRef,
  type AuditEvent,
  type AuditContext,
} from '@opencontext/contracts/audit';
import { safeErrorCode } from '@opencontext/contracts/errors';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Binding,
  ExecutionLock,
  FileEntry,
  ImportedObjectRef,
  PluginInstanceLock,
  PreparedBinding,
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
export type CatalogOptions = { mode: 'demo' | 'private' };

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

function diagnostic(row: Row, key: string): string | null {
  const value = nullable(row, key);
  return value === null
    ? null
    : safeErrorCode(new Error(value), 'PROCESSING_FAILED');
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    [5, 6].includes(error.errcode & 255)
  );
}

function canonicalDatabasePath(dbPath: string): string {
  const absolute = resolve(dbPath);
  mkdirSync(dirname(absolute), { recursive: true });
  return existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
}

function checkedBinding(input: PreparedBinding): PreparedBinding {
  if (
    !input ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 80
  )
    throw new Error('INVALID_BINDING');
  const checked = (
    lock: PluginInstanceLock,
    capability: PluginInstanceLock['capability'],
  ): PluginInstanceLock => {
    if (
      !lock ||
      lock.capability !== capability ||
      typeof lock.ref !== 'string' ||
      !lock.ref ||
      lock.ref.length > 200 ||
      typeof lock.packageRef !== 'string' ||
      !lock.packageRef ||
      lock.packageRef.length > 200 ||
      typeof lock.packageDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(lock.packageDigest) ||
      typeof lock.configHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(lock.configHash) ||
      !lock.config ||
      typeof lock.config !== 'object' ||
      Array.isArray(lock.config)
    )
      throw new Error('INVALID_PLUGIN_LOCK');
    // The host owns package/config schema and digest verification. Persist only
    // a JSON value copy here so the caller cannot mutate an installed binding.
    try {
      return JSON.parse(
        JSON.stringify(
          {
            ref: lock.ref,
            packageRef: lock.packageRef,
            packageDigest: lock.packageDigest,
            configHash: lock.configHash,
            capability,
            config: lock.config,
          },
          (_key, value: unknown) => {
            if (
              typeof value === 'undefined' ||
              typeof value === 'function' ||
              typeof value === 'symbol' ||
              typeof value === 'bigint' ||
              (typeof value === 'number' && !Number.isFinite(value))
            )
              throw new Error('INVALID_PLUGIN_LOCK');
            return value;
          },
        ),
      ) as PluginInstanceLock;
    } catch {
      throw new Error('INVALID_PLUGIN_LOCK');
    }
  };
  return {
    name: input.name,
    connector: checked(input.connector, 'connector'),
    processor: checked(input.processor, 'processor'),
  };
}

/** One local authority. Plugins never receive this object or its database. */
export class Catalog {
  readonly db: DatabaseSync;
  readonly incarnation = randomUUID();
  private authorityLock: DatabaseSync | undefined;
  private databaseClosed = false;

  constructor(dbPath: string, options: CatalogOptions = { mode: 'private' }) {
    if (options.mode !== 'demo' && options.mode !== 'private')
      throw new Error('INVALID_DATA_MODE');
    const path = dbPath === ':memory:' ? dbPath : canonicalDatabasePath(dbPath);
    // This separate connection holds the SQLite OS lock for the entire Catalog
    // lifetime. Control-db transactions remain short and independent. Never
    // unlink this file to "recover" authority: process death releases its lock.
    if (path !== ':memory:') {
      const authority = new DatabaseSync(`${path}.authority.sqlite`);
      try {
        authority.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
        this.authorityLock = authority;
      } catch (error) {
        authority.close();
        if (isBusy(error)) throw new Error('CATALOG_IN_USE', { cause: error });
        throw error;
      }
    }
    let control: DatabaseSync | undefined;
    try {
      this.db = control = new DatabaseSync(path);
      // Inspect before any control-db PRAGMA that writes, schema migration,
      // incarnation replacement, or abandoned-run recovery. Legacy databases
      // are private regardless of whether they contain projects or user files.
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      const savedVersion = tables.some((table) => table.name === 'catalog_meta')
        ? this.db
            .prepare(
              "SELECT value FROM catalog_meta WHERE key='storage_version'",
            )
            .get()?.value
        : undefined;
      if (savedVersion !== undefined && savedVersion !== '1')
        throw new Error('SCHEMA_UNSUPPORTED');
      const auditFormat = tables.some((table) => table.name === 'catalog_meta')
        ? this.db
            .prepare("SELECT value FROM catalog_meta WHERE key='audit_format'")
            .get()?.value
        : undefined;
      if (auditFormat !== undefined && auditFormat !== '2')
        throw new Error('SCHEMA_UNSUPPORTED');
      const savedMode = tables.some((table) => table.name === 'catalog_meta')
        ? this.db
            .prepare(
              "SELECT value FROM catalog_meta WHERE key='deployment_mode'",
            )
            .get()?.value
        : undefined;
      const mode = savedMode ?? (tables.length > 0 ? 'private' : options.mode);
      if (mode !== options.mode) throw new Error('DATA_MODE_MISMATCH');
      this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, delivered_at TEXT,
        event_json TEXT NOT NULL CHECK(json_valid(event_json))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_time ON audit_events(time);
      CREATE UNIQUE INDEX IF NOT EXISTS audit_event_id ON audit_events(json_extract(event_json,'$.id'));
      CREATE TABLE IF NOT EXISTS audit_pending (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK(json_valid(event_json) AND length(event_json)<=2048)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
        head TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bindings (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, instance_ref TEXT NOT NULL UNIQUE,
        package_ref TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)),
        connector_json TEXT CHECK(connector_json IS NULL OR json_valid(connector_json)),
        processor_json TEXT CHECK(processor_json IS NULL OR json_valid(processor_json)),
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
        execution_json TEXT CHECK(execution_json IS NULL OR json_valid(execution_json)),
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
      CREATE TABLE IF NOT EXISTS binding_imports (
        binding_id TEXT NOT NULL REFERENCES bindings(id), id TEXT NOT NULL,
        filename TEXT NOT NULL, content_hash TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes>=0),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        PRIMARY KEY(binding_id,id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_current_import_filename
        ON binding_imports(binding_id,filename) WHERE active=1;
    `);
      if (
        !this.db
          .prepare('PRAGMA table_info(audit_events)')
          .all()
          .some((column) => column.name === 'delivered_at')
      )
        this.db.exec('ALTER TABLE audit_events ADD COLUMN delivered_at TEXT');
      this.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO catalog_meta(key,value) VALUES('deployment_mode',?) ON CONFLICT(key) DO NOTHING",
          )
          .run(options.mode);
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
        const bindingColumns = this.db
          .prepare('PRAGMA table_info(bindings)')
          .all();
        for (const column of ['connector_json', 'processor_json']) {
          if (!bindingColumns.some((item) => item.name === column)) {
            // The interpolated identifier is exclusively this fixed internal list.
            this.db.exec(
              `ALTER TABLE bindings ADD COLUMN ${column} TEXT CHECK(${column} IS NULL OR json_valid(${column}))`,
            );
          }
        }
        if (
          !this.db
            .prepare('PRAGMA table_info(runs)')
            .all()
            .some((column) => column.name === 'execution_json')
        ) {
          this.db.exec(
            'ALTER TABLE runs ADD COLUMN execution_json TEXT CHECK(execution_json IS NULL OR json_valid(execution_json))',
          );
        }
        this.db
          .prepare(
            "INSERT INTO catalog_meta(key,value) VALUES('storage_version','1') ON CONFLICT(key) DO NOTHING",
          )
          .run();
        this.db
          .prepare(
            "INSERT INTO catalog_meta(key,value) VALUES('audit_format','2') ON CONFLICT(key) DO NOTHING",
          )
          .run();
        this.rejectLegacyRuns();
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
    } catch (error) {
      try {
        control?.close();
      } finally {
        this.releaseAuthority();
      }
      throw error;
    }
  }

  close(): void {
    if (!this.databaseClosed) {
      this.db.close();
      this.databaseClosed = true;
    }
    this.releaseAuthority();
  }

  private releaseAuthority(): void {
    if (this.authorityLock) {
      // Closing the SQLite connection rolls back BEGIN EXCLUSIVE and releases
      // OS locks. The file remains in place for all future processes.
      this.authorityLock.close();
      this.authorityLock = undefined;
    }
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
      if (isBusy(error)) {
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

  createProject(name: string, audit?: AuditContext): Project {
    return this.transaction(() => {
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
      this.criticalAudit('project.create', { projectId: project.id }, audit);
      return project;
    });
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

  createBinding(
    projectId: string,
    input: PreparedBinding,
    audit?: AuditContext,
  ): Binding {
    return this.transaction(() => {
      this.assertAuthority();
      if (!this.getProject(projectId)) throw new Error('NOT_FOUND');
      const prepared = checkedBinding(input);
      const id = randomUUID();
      this.db
        .prepare(
          'INSERT INTO bindings(id,project_id,name,instance_ref,package_ref,config_json,connector_json,processor_json) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          projectId,
          prepared.name,
          prepared.connector.ref,
          prepared.connector.packageRef,
          JSON.stringify(prepared.connector.config),
          JSON.stringify(prepared.connector),
          JSON.stringify(prepared.processor),
        );
      this.criticalAudit('source.create', { projectId, bindingId: id }, audit);
      return this.getBinding(id)!;
    });
  }

  /** Composition-root resolver is synchronous and must perform no network I/O. */
  migrateLegacyBindings(resolver: (binding: Binding) => PreparedBinding): void {
    this.transaction(() => {
      this.assertAuthority();
      this.rejectLegacyRuns();
      const legacy = this.db
        .prepare(
          'SELECT * FROM bindings WHERE connector_json IS NULL OR processor_json IS NULL ORDER BY id',
        )
        .all();
      for (const row of legacy) {
        const prepared = checkedBinding(resolver(this.binding(row)));
        this.db
          .prepare(
            'UPDATE bindings SET name=?,instance_ref=?,package_ref=?,config_json=?,connector_json=?,processor_json=? WHERE id=?',
          )
          .run(
            prepared.name,
            prepared.connector.ref,
            prepared.connector.packageRef,
            JSON.stringify(prepared.connector.config),
            JSON.stringify(prepared.connector),
            JSON.stringify(prepared.processor),
            str(row, 'id'),
          );
      }
    });
  }

  private rejectLegacyRuns(): void {
    this.db
      .prepare(
        "UPDATE runs SET state='failed',error='LEGACY_RUN_REQUIRES_RETRY',lease_until=NULL WHERE state IN ('queued','running') AND execution_json IS NULL",
      )
      .run();
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
    const connector =
      row.connector_json === null
        ? null
        : (JSON.parse(str(row, 'connector_json')) as PluginInstanceLock);
    const processor =
      row.processor_json === null
        ? null
        : (JSON.parse(str(row, 'processor_json')) as PluginInstanceLock);
    return {
      id: str(row, 'id'),
      projectId: str(row, 'project_id'),
      name: str(row, 'name'),
      instanceRef: connector?.ref ?? str(row, 'instance_ref'),
      packageRef: connector?.packageRef ?? str(row, 'package_ref'),
      config:
        connector?.config ??
        (JSON.parse(str(row, 'config_json')) as Binding['config']),
      connector,
      processor,
      active: row.active === 1,
      sourceVersion: nullable(row, 'source_version'),
      lastError: diagnostic(row, 'last_error'),
    };
  }

  private activeBinding(id: string): Binding {
    const binding = this.getBinding(id);
    if (!binding) throw new Error('NOT_FOUND');
    if (!binding.active) throw new Error('BINDING_REVOKED');
    return binding;
  }

  putImport(
    bindingId: string,
    object: ImportedObjectRef,
    expectedObjectId: string | null = null,
    audit?: AuditContext,
  ): ImportedObjectRef {
    return this.transaction(() => {
      this.assertAuthority();
      this.activeBinding(bindingId);
      if (
        !object ||
        typeof object.id !== 'string' ||
        !object.id ||
        object.id.length > 120 ||
        typeof object.filename !== 'string' ||
        !object.filename ||
        object.filename.length > 255 ||
        /[/\\\0]/.test(object.filename) ||
        ['.', '..'].includes(object.filename) ||
        typeof object.contentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(object.contentHash) ||
        !Number.isSafeInteger(object.bytes) ||
        object.bytes < 0
      )
        throw new Error('INVALID_IMPORT');
      const current = this.listImports(bindingId).find(
        (item) => item.filename === object.filename,
      );
      if (current?.contentHash === object.contentHash) {
        if (current.bytes !== object.bytes) throw new Error('INVALID_IMPORT');
        return current;
      }
      if ((current?.id ?? null) !== expectedObjectId)
        throw new Error('IMPORT_CONFLICT');
      const totals = this.db
        .prepare(
          'SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM binding_imports WHERE binding_id=? AND active=1 AND filename<>?',
        )
        .get(bindingId, object.filename)!;
      if (
        Number(totals.count) + 1 > 32 ||
        Number(totals.bytes) + object.bytes > 10 * 1024 * 1024
      )
        throw new Error('IMPORT_LIMIT');
      const old = this.db
        .prepare(
          'SELECT filename,content_hash,bytes FROM binding_imports WHERE binding_id=? AND id=?',
        )
        .get(bindingId, object.id);
      if (
        old &&
        (old.filename !== object.filename ||
          old.content_hash !== object.contentHash ||
          old.bytes !== object.bytes)
      )
        throw new Error('IMPORT_ID_COLLISION');
      // Retain replaced/removed object metadata; frozen runs continue to refer
      // to the original blob. Only the current filename selector changes.
      this.db
        .prepare(
          'UPDATE binding_imports SET active=0 WHERE binding_id=? AND filename=?',
        )
        .run(bindingId, object.filename);
      this.db
        .prepare(
          'INSERT INTO binding_imports(binding_id,id,filename,content_hash,bytes) VALUES(?,?,?,?,?) ON CONFLICT(binding_id,id) DO UPDATE SET active=1',
        )
        .run(
          bindingId,
          object.id,
          object.filename,
          object.contentHash,
          object.bytes,
        );
      this.criticalAudit(
        'import.create',
        {
          projectId: this.getBinding(bindingId)!.projectId,
          bindingId,
          objectId: object.id,
        },
        audit,
      );
      return {
        id: object.id,
        filename: object.filename,
        contentHash: object.contentHash,
        bytes: object.bytes,
      };
    });
  }

  listImports(bindingId: string): ImportedObjectRef[] {
    this.activeBinding(bindingId);
    return this.db
      .prepare(
        'SELECT id,filename,content_hash,bytes FROM binding_imports WHERE binding_id=? AND active=1 ORDER BY filename,id',
      )
      .all(bindingId)
      .map((row) => ({
        id: str(row, 'id'),
        filename: str(row, 'filename'),
        contentHash: str(row, 'content_hash'),
        bytes: Number(row.bytes),
      }));
  }

  removeImport(bindingId: string, id: string, audit?: AuditContext): void {
    this.transaction(() => {
      this.assertAuthority();
      this.activeBinding(bindingId);
      const removed = this.db
        .prepare(
          'UPDATE binding_imports SET active=0 WHERE binding_id=? AND id=? AND active=1',
        )
        .run(bindingId, id);
      if (removed.changes !== 1) throw new Error('NOT_FOUND');
      this.criticalAudit(
        'import.delete',
        {
          projectId: this.getBinding(bindingId)!.projectId,
          bindingId,
          objectId: id,
        },
        audit,
      );
    });
  }

  createReaderToken(
    projectId: string,
    audit?: AuditContext,
  ): { id: string; token: string } {
    return this.transaction(() => {
      this.assertAuthority();
      if (!this.getProject(projectId)) throw new Error('NOT_FOUND');
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      this.db
        .prepare(
          'INSERT INTO reader_tokens(id,token_hash,project_id) VALUES(?,?,?)',
        )
        .run(id, digest(token), projectId);
      this.criticalAudit('token.create', { projectId, tokenId: id }, audit);
      return { id, token };
    });
  }

  private criticalAudit(
    action: string,
    input: Record<string, unknown>,
    context?: AuditContext,
    jobId: string | null = null,
  ): void {
    try {
      if (this.auditPending().pending >= 10000)
        throw new Error('AUDIT_QUEUE_FULL');
      const event = parseAuditEvent({
        id: randomUUID(),
        time: new Date().toISOString(),
        actor: context?.actor ?? { id: 'system', role: 'system' },
        action,
        target: {
          projectId: auditRef(input['projectId']),
          bindingId: auditRef(input['bindingId']),
          fileId: null,
          revisionId: null,
          objectId: auditRef(input['objectId']),
          tokenId: auditRef(input['tokenId']),
          commitId: auditRef(input['commitId']),
        },
        result: 'success',
        code: 'OK',
        requestId:
          context?.requestId ?? (jobId ? this.auditRequestForJob(jobId) : null),
        jobId,
        guarantee: 'committed',
      });
      this.db
        .prepare(
          'INSERT INTO audit_pending(id,created_at,event_json) VALUES(?,?,?)',
        )
        .run(event.id, event.time, JSON.stringify(event));
      context?.onRecorded?.(event.id);
    } catch (error) {
      if (error instanceof Error && error.message === 'AUDIT_QUEUE_FULL')
        throw error;
      throw new Error('AUDIT_UNAVAILABLE', { cause: error });
    }
  }
  pendingAuditEvents(limit = 100): AuditEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('INVALID_AUDIT_EVENT');
    return this.db
      .prepare(
        'SELECT event_json FROM audit_pending ORDER BY created_at,id LIMIT ?',
      )
      .all(limit)
      .map((row) => parseAuditEvent(JSON.parse(str(row, 'event_json'))));
  }
  auditPending() {
    const row = this.db
      .prepare(
        'SELECT count(*) AS n,min(created_at) AS oldest FROM audit_pending',
      )
      .get()!;
    return {
      pending: Number(row['n']),
      maxPending: 10000,
      oldest: row['oldest'] as string | null,
    };
  }
  private insertAudit(event: AuditEvent): void {
    const json = JSON.stringify(parseAuditEvent(event));
    const existing = this.db
      .prepare(
        "SELECT event_json FROM audit_events WHERE json_extract(event_json,'$.id')=?",
      )
      .get(event.id);
    if (existing) {
      if (
        JSON.stringify(
          parseAuditEvent(JSON.parse(str(existing, 'event_json'))),
        ) !== json
      )
        throw new Error('AUDIT_CONFLICT');
      return;
    }
    this.db
      .prepare(
        'INSERT INTO audit_events(time,delivered_at,event_json) VALUES(?,?,?)',
      )
      .run(event.time, new Date().toISOString(), json);
  }
  private pruneAudit(): void {
    this.db
      .prepare('DELETE FROM audit_events WHERE COALESCE(delivered_at,time) < ?')
      .run(new Date(Date.now() - 30 * 86400000).toISOString());
    this.db.exec(
      'DELETE FROM audit_events WHERE sequence <= COALESCE((SELECT sequence FROM audit_events ORDER BY sequence DESC LIMIT 1 OFFSET 10000), -1)',
    );
  }
  appendAudit(event: AuditEvent): void {
    this.transaction(() => {
      this.assertAuthority();
      this.insertAudit(event);
      this.pruneAudit();
    });
  }
  deliverAuditBatch(limit = 100): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('INVALID_AUDIT_EVENT');
    return this.transaction(() => {
      this.assertAuthority();
      const pending = this.db
        .prepare(
          'SELECT id,event_json FROM audit_pending ORDER BY created_at,id LIMIT ?',
        )
        .all(limit);
      for (const row of pending) {
        const event = parseAuditEvent(JSON.parse(str(row, 'event_json')));
        if (event.id !== row['id'] || event.guarantee !== 'committed')
          throw new Error('AUDIT_CONFLICT');
        this.insertAudit(event);
        this.db.prepare('DELETE FROM audit_pending WHERE id=?').run(event.id);
      }
      this.pruneAudit();
      return pending.length;
    });
  }
  auditEvents(after = 0, limit = 100, until?: number) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (until !== undefined && (!Number.isSafeInteger(until) || until < 0))
    )
      throw new Error('INVALID_AUDIT_EVENT');
    const snapshotSequence =
      until ??
      Number(
        this.db
          .prepare(
            'SELECT COALESCE(MAX(sequence),0) AS sequence FROM audit_events',
          )
          .get()?.['sequence'],
      );
    const events = this.db
      .prepare(
        'SELECT sequence,event_json FROM audit_events WHERE sequence > ? AND sequence <= ? AND COALESCE(delivered_at,time) >= ? ORDER BY sequence LIMIT ?',
      )
      .all(
        after,
        snapshotSequence,
        new Date(Date.now() - 30 * 86400000).toISOString(),
        limit,
      )
      .map((row) => ({
        sequence: Number(row['sequence']),
        ...parseAuditEvent(JSON.parse(str(row, 'event_json'))),
      }));
    const oldest = this.db
      .prepare(
        'SELECT MIN(sequence) AS sequence FROM audit_events WHERE COALESCE(delivered_at,time) >= ?',
      )
      .get(new Date(Date.now() - 30 * 86400000).toISOString());
    return {
      events,
      oldestSequence: oldest?.['sequence'] ?? null,
      nextCursor: events.at(-1)?.sequence ?? after,
      snapshotSequence,
      retention: { maxEvents: 10000, maxDays: 30 },
      tamperEvident: false,
    };
  }
  auditRequestForJob(jobId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT json_extract(event_json,'$.requestId') AS request_id FROM (SELECT event_json FROM audit_pending UNION ALL SELECT event_json FROM audit_events) WHERE json_extract(event_json,'$.jobId')=? AND json_extract(event_json,'$.action')='task.enqueue' LIMIT 1",
      )
      .get(jobId);
    return row ? nullable(row, 'request_id') : null;
  }

  revokeToken(id: string, audit?: AuditContext): void {
    this.transaction(() => {
      this.assertAuthority();
      const row = this.db
        .prepare('SELECT project_id,revoked FROM reader_tokens WHERE id=?')
        .get(id);
      const changed = this.db
        .prepare('UPDATE reader_tokens SET revoked=1 WHERE id=? AND revoked=0')
        .run(id);
      if (changed.changes)
        this.criticalAudit(
          'token.revoke',
          { tokenId: id, projectId: row?.['project_id'] },
          audit,
        );
    });
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

  enqueue(bindingId: string, kind: Run['kind'], audit?: AuditContext): Run {
    return this.transaction(() => {
      this.assertAuthority();
      const binding = this.activeBinding(bindingId);
      const instance = kind === 'sync' ? binding.connector : binding.processor;
      if (!instance) throw new Error('LEGACY_BINDING_REQUIRES_MIGRATION');
      this.rejectLegacyRuns();
      const existing = this.db
        .prepare(
          "SELECT * FROM runs WHERE binding_id=? AND kind=? AND state IN ('queued','running')",
        )
        .get(bindingId, kind);
      if (existing) return this.run(existing);
      const queued = Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM runs WHERE state IN ('queued','running')",
          )
          .get()?.n,
      );
      if (queued >= 100) throw new Error('QUEUE_FULL');
      const execution: ExecutionLock = {
        instance,
        imports: this.listImports(bindingId),
      };
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO runs(id,project_id,binding_id,kind,state,incarnation,input_commit,created_at,execution_json) VALUES(?,?,?,?,'queued',?,?,?,?)",
        )
        .run(
          id,
          binding.projectId,
          bindingId,
          kind,
          this.incarnation,
          this.head(binding.projectId),
          new Date().toISOString(),
          JSON.stringify(execution),
        );
      this.criticalAudit(
        'task.enqueue',
        { projectId: binding.projectId, bindingId },
        audit,
        id,
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
      error: diagnostic(row, 'error'),
      createdAt: str(row, 'created_at'),
      skipped: JSON.parse(str(row, 'skipped_json')) as {
        path: string;
        reason: string;
      }[],
      execution:
        row.execution_json === null
          ? null
          : (JSON.parse(str(row, 'execution_json')) as ExecutionLock),
    };
  }

  claim(): Run | null {
    return this.transaction(() => {
      this.assertAuthority();
      this.rejectLegacyRuns();
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

  private assertSyncInputs(run: Run): void {
    if (!run.execution) throw new Error('LEGACY_RUN_REQUIRES_RETRY');
    if (
      run.kind === 'sync' &&
      JSON.stringify(this.listImports(run.bindingId)) !==
        JSON.stringify(run.execution.imports)
    )
      throw new Error('INPUT_CHANGED');
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
      this.assertSyncInputs(this.activeAttempt(input.run));
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
      this.criticalAudit(
        'content.publish',
        {
          projectId: input.projectId,
          bindingId: input.run.bindingId,
          commitId: input.commitId,
        },
        undefined,
        input.run.id,
      );
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
      this.assertSyncInputs(this.activeAttempt(run));
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

  revokeBinding(id: string, audit?: AuditContext): void {
    this.transaction(() => {
      this.assertAuthority();
      const binding = this.getBinding(id);
      if (!binding) throw new Error('NOT_FOUND');
      if (!binding.active) return;
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
      this.criticalAudit(
        'source.revoke',
        { projectId: binding.projectId, bindingId: id },
        audit,
      );
    });
  }
}
