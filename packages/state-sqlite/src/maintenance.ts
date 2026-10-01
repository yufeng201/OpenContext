import {
  parseBackupManifest,
  type BackupManifest,
} from '@opencontext/contracts/maintenance';
import { DatabaseSync, backup } from 'node:sqlite';
import { validateAuditStorage } from './audit-storage.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  fchmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  basename,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { FileEntry } from '@opencontext/contracts';

export const STORAGE_FORMAT = 1;
export const RESTORE_MARKER = '.restore-incomplete';
export const LIMITS = {
  files: 20_000,
  totalBytes: 512 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
} as const;
const sha = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
function fail(code: string): never {
  throw new Error(code);
}
export function noLinks(path: string): void {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      try {
        lstatSync(current);
        fail('UNSAFE_SYMLINK');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      continue;
    }
    if (
      lstatSync(current).isSymbolicLink() &&
      !(
        (current === '/var' && realpathSync(current) === '/private/var') ||
        (current === '/tmp' && realpathSync(current) === '/private/tmp')
      )
    )
      fail('UNSAFE_SYMLINK');
  }
}
export function assertCompleteRoot(root: string): void {
  noLinks(root);
  if (existsSync(join(root, RESTORE_MARKER))) fail('RESTORE_INCOMPLETE');
  if (
    existsSync(join(root, '.backup-incomplete')) ||
    existsSync(join(root, 'manifest.sha256'))
  )
    fail('BACKUP_IS_NOT_DATA_ROOT');
}
function bytes(path: string, max: number = LIMITS.fileBytes): Buffer {
  noLinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail('UNSAFE_FILE');
    if (stat.size > max) fail('BACKUP_LIMIT');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function sync(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function write(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  sync(dirname(path));
}
export function acquireStoppedLock(root: string): DatabaseSync {
  assertCompleteRoot(root);
  bytes(join(root, 'control.sqlite'));
  const lockPath = join(root, 'control.sqlite.authority.sqlite');
  noLinks(lockPath);
  if (existsSync(lockPath)) bytes(lockPath);
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    return lock;
  } catch {
    lock.close();
    return fail('CATALOG_IN_USE');
  }
}
type Entry = { path: string; bytes: number; sha256: string };
type Manifest = BackupManifest;
function safePath(path: string): boolean {
  return (
    path.length <= 2000 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('%') &&
    path
      .split('/')
      .every(
        (p) =>
          p !== '' && p !== '.' && p !== '..' && /^[a-zA-Z0-9_.-]+$/.test(p),
      ) &&
    (path === 'control.sqlite' ||
      path.startsWith('content/') ||
      path.startsWith('plugin-state/'))
  );
}
function collect(root: string): Entry[] {
  const files: Entry[] = [];
  let total = 0;
  function walk(path: string): void {
    noLinks(path);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) walk(join(path, child));
      return;
    }
    const name = relative(root, path).split(sep).join('/');
    if (!safePath(name)) fail('INVALID_BACKUP_PATH');
    const data = bytes(path);
    total += data.length;
    if (total > LIMITS.totalBytes || files.length >= LIMITS.files)
      fail('BACKUP_LIMIT');
    files.push({ path: name, bytes: data.length, sha256: sha(data) });
  }
  walk(join(root, 'control.sqlite'));
  for (const folder of ['content', 'plugin-state'])
    if (existsSync(join(root, folder))) walk(join(root, folder));
  return files;
}
const requiredTables = [
  'catalog_meta',
  'projects',
  'bindings',
  'runs',
  'commits',
  'revisions',
  'current_files',
  'outbox',
  'reader_tokens',
  'binding_imports',
  'retrieval_fts',
  'retrieval_generations',
];
export type DependencyCheck = { ok: boolean; code: string };
export type StorageInspection = {
  ready: boolean;
  checks: Record<
    'database' | 'migration' | 'storage' | 'pluginState' | 'index',
    DependencyCheck
  >;
  counts: { projects: number; revisions: number; pendingIndex: number };
  mode: 'demo' | 'private' | null;
};
export function inspectStorage(
  root: string,
  db: DatabaseSync,
  restoring = false,
): StorageInspection {
  const result: StorageInspection = {
    ready: false,
    checks: {
      database: { ok: false, code: 'DATABASE_UNAVAILABLE' },
      migration: { ok: false, code: 'SCHEMA_UNSUPPORTED' },
      storage: { ok: false, code: 'STORAGE_UNAVAILABLE' },
      pluginState: { ok: false, code: 'CHECKPOINT_UNAVAILABLE' },
      index: { ok: false, code: 'INDEX_UNAVAILABLE' },
    },
    counts: { projects: 0, revisions: 0, pendingIndex: 0 },
    mode: null,
  };
  try {
    if (
      Number(db.prepare('PRAGMA page_count').get()?.page_count) *
        Number(db.prepare('PRAGMA page_size').get()?.page_size) >
      LIMITS.fileBytes
    )
      fail('DATABASE_LIMIT');
    const check = db.prepare('PRAGMA quick_check').get();
    if (
      !check ||
      Object.values(check)[0] !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      fail('DATABASE_CORRUPT');
    result.checks.database = { ok: true, code: 'OK' };
  } catch (error) {
    if (error instanceof Error && error.message === 'DATABASE_LIMIT')
      result.checks.database.code = 'DATABASE_LIMIT';
    return result;
  }
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    if (requiredTables.some((t) => !tables.has(t))) fail('SCHEMA_UNSUPPORTED');
    const version = db
      .prepare("SELECT value FROM catalog_meta WHERE key='storage_version'")
      .get()?.value;
    if (version !== undefined && version !== String(STORAGE_FORMAT))
      fail('SCHEMA_UNSUPPORTED');
    const auditFormat = db
      .prepare("SELECT value FROM catalog_meta WHERE key='audit_format'")
      .get()?.value;
    if (auditFormat !== undefined && auditFormat !== '2')
      fail('SCHEMA_UNSUPPORTED');
    validateAuditStorage(db);
    for (const [table, column] of [
      ['bindings', 'connector_json'],
      ['bindings', 'processor_json'],
      ['runs', 'execution_json'],
      ['runs', 'skipped_json'],
    ] as const)
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((r) => r.name === column)
      )
        fail('SCHEMA_UNSUPPORTED');
    const mode = db
      .prepare("SELECT value FROM catalog_meta WHERE key='deployment_mode'")
      .get()?.value;
    if (mode !== 'demo' && mode !== 'private') fail('DATA_MODE_UNSUPPORTED');
    result.mode = mode;
    result.checks.migration = {
      ok: true,
      code: version === undefined ? 'LEGACY_COMPATIBLE' : 'OK',
    };
  } catch {
    return result;
  }
  try {
    if (!restoring) assertCompleteRoot(root);
    let checked = 0,
      total = 0;
    const load = (path: string) => {
      const data = bytes(join(root, path));
      if (
        ++checked > LIMITS.files ||
        (total += data.length) > LIMITS.totalBytes
      )
        fail('CHECK_LIMIT_EXCEEDED');
      return data;
    };
    const revisions = db
      .prepare('SELECT entry_json,content_hash FROM revisions')
      .all();
    if (revisions.length > LIMITS.files) fail('CHECK_LIMIT_EXCEEDED');
    result.counts.revisions = revisions.length;
    for (const row of revisions) {
      const f = JSON.parse(String(row.entry_json)) as FileEntry;
      if (
        !/^[a-f0-9]{64}$/.test(f.contentHash) ||
        f.contentHash !== row.content_hash ||
        ![f.fileId, f.revisionId].every((id) => /^[a-zA-Z0-9-]+$/.test(id))
      )
        fail('CORRUPT_REFERENCE');
      const data = load(
        `content/blobs/${f.contentHash.slice(0, 2)}/${f.contentHash}`,
      );
      if (sha(data) !== f.contentHash || data.length !== f.bytes)
        fail('CORRUPT_OBJECT');
      const rev = JSON.parse(
        load(`content/revisions/${f.fileId}/${f.revisionId}.json`).toString(),
      ) as Record<string, unknown>;
      for (const field of [
        'fileId',
        'revisionId',
        'contentHash',
        'bytes',
        'projectId',
        'bindingId',
        'createdAt',
        'sourceVersion',
        'derivedFrom',
      ] as const)
        if (JSON.stringify(rev[field]) !== JSON.stringify(f[field]))
          fail('CORRUPT_REVISION');
    }
    for (const row of db
      .prepare('SELECT project_id,id,manifest_hash FROM commits')
      .all()) {
      if (
        ![row.project_id, row.id].every(
          (id) => typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id),
        )
      )
        fail('CORRUPT_REFERENCE');
      const data = load(
        `content/commits/${String(row.project_id)}/${String(row.id)}.json`,
      );
      if (sha(data) !== row.manifest_hash) fail('CORRUPT_MANIFEST');
      const manifest = JSON.parse(data.toString()) as {
        schemaVersion: string;
        projectId: string;
        commitId: string;
        files: FileEntry[];
      };
      if (
        manifest.schemaVersion !== '1' ||
        manifest.projectId !== row.project_id ||
        manifest.commitId !== row.id ||
        !Array.isArray(manifest.files)
      )
        fail('CORRUPT_MANIFEST');
      for (const f of manifest.files) {
        const r = db
          .prepare(
            'SELECT content_hash FROM revisions WHERE project_id=? AND file_id=? AND revision_id=?',
          )
          .get(f.projectId, f.fileId, f.revisionId);
        if (f.projectId !== row.project_id || r?.content_hash !== f.contentHash)
          fail('CORRUPT_REFERENCE');
      }
    }
    for (const row of db
      .prepare('SELECT content_hash,bytes FROM binding_imports')
      .all()) {
      const h = String(row.content_hash);
      if (!/^[a-f0-9]{64}$/.test(h)) fail('CORRUPT_REFERENCE');
      const data = load(`content/blobs/${h.slice(0, 2)}/${h}`);
      if (sha(data) !== h || data.length !== row.bytes) fail('CORRUPT_OBJECT');
    }
    for (const row of db.prepare('SELECT id,head FROM projects').all()) {
      result.counts.projects++;
      if (
        row.head !== null &&
        !db
          .prepare('SELECT id FROM commits WHERE project_id=? AND id=?')
          .get(row.id!, row.head!)
      )
        fail('CORRUPT_HEAD');
    }
    result.checks.storage = { ok: true, code: 'OK' };
  } catch (error) {
    result.checks.storage = {
      ok: false,
      code:
        error instanceof Error &&
        [
          'RESTORE_INCOMPLETE',
          'CHECK_LIMIT_EXCEEDED',
          'CORRUPT_OBJECT',
          'CORRUPT_REVISION',
          'CORRUPT_MANIFEST',
          'CORRUPT_REFERENCE',
          'CORRUPT_HEAD',
          'UNSAFE_SYMLINK',
          'UNSAFE_FILE',
          'BACKUP_LIMIT',
        ].includes(error.message)
          ? error.message
          : 'OBJECT_MISSING_OR_CORRUPT',
    };
  }
  try {
    const refs = db
      .prepare(
        "SELECT binding_id,entry_json FROM current_files UNION ALL SELECT json_extract(entry_json,'$.bindingId') AS binding_id,entry_json FROM revisions",
      )
      .all();
    if (refs.length > LIMITS.files) fail('CHECK_LIMIT_EXCEEDED');
    for (const row of db
      .prepare(
        "SELECT id,connector_json,source_version FROM bindings WHERE source_version LIKE 'fs1:%'",
      )
      .all()) {
      const connector = JSON.parse(String(row.connector_json)) as {
        ref: string;
      };
      const h = String(row.source_version).slice(4);
      if (
        !/^[a-f0-9]{64}$/.test(h) ||
        sha(
          bytes(
            join(
              root,
              'plugin-state',
              'feishu-chat',
              sha(connector.ref),
              'snapshots',
              h + '.json',
            ),
          ),
        ) !== h
      )
        fail('CHECKPOINT_CORRUPT');
    }
    for (const row of refs) {
      const f = JSON.parse(String(row.entry_json)) as FileEntry;
      if (!f.sourceVersion.startsWith('fs1:')) continue;
      const binding = db
        .prepare('SELECT connector_json FROM bindings WHERE id=?')
        .get(row.binding_id!);
      const connector = JSON.parse(String(binding?.connector_json)) as {
        ref: string;
      };
      const h = f.sourceVersion.slice(4);
      if (!/^[a-f0-9]{64}$/.test(h)) fail('CHECKPOINT_CORRUPT');
      const data = bytes(
        join(
          root,
          'plugin-state',
          'feishu-chat',
          sha(connector.ref),
          'snapshots',
          h + '.json',
        ),
      );
      if (sha(data) !== h) fail('CHECKPOINT_CORRUPT');
    }
    result.checks.pluginState = { ok: true, code: 'OK' };
  } catch {
    result.checks.pluginState = {
      ok: false,
      code: 'CHECKPOINT_MISSING_OR_CORRUPT',
    };
  }
  try {
    const lag = db
      .prepare(
        'SELECT p.id FROM projects p LEFT JOIN retrieval_generations g ON g.project_id=p.id WHERE p.head IS NOT NULL AND (g.commit_id IS NULL OR g.commit_id<>p.head)',
      )
      .all().length;
    const pending = Number(
      db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()
        ?.n,
    );
    if (pending === 0 && lag === 0) {
      const rows = db
        .prepare(
          'SELECT project_id,file_id,revision_id,body FROM retrieval_fts',
        )
        .all();
      if (rows.length > LIMITS.files) fail('CHECK_LIMIT_EXCEEDED');
      const indexed = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        const key = String(row.project_id) + '/' + String(row.file_id);
        if (indexed.has(key)) fail('INDEX_CORRUPT');
        indexed.set(key, row);
        const current = db
          .prepare(
            'SELECT entry_json FROM current_files WHERE project_id=? AND file_id=?',
          )
          .get(row.project_id!, row.file_id!);
        if (!current) fail('INDEX_CORRUPT');
        const f = JSON.parse(String(current.entry_json)) as FileEntry;
        if (
          row.revision_id !== f.revisionId ||
          sha(String(row.body)) !== f.contentHash
        )
          fail('INDEX_CORRUPT');
      }
      for (const row of db
        .prepare('SELECT entry_json FROM current_files WHERE tombstone=0')
        .all()) {
        const f = JSON.parse(String(row.entry_json)) as FileEntry;
        if (
          f.freshness !== 'invalid' &&
          !indexed.has(f.projectId + '/' + f.fileId)
        )
          fail('INDEX_CORRUPT');
      }
    }
    result.counts.pendingIndex = pending + lag;
    result.checks.index = {
      ok: pending === 0 && lag === 0,
      code: pending === 0 && lag === 0 ? 'OK' : 'INDEX_NOT_READY',
    };
  } catch (error) {
    result.checks.index = {
      ok: false,
      code:
        error instanceof Error && error.message === 'INDEX_CORRUPT'
          ? 'INDEX_CORRUPT'
          : 'INDEX_UNAVAILABLE',
    };
  }
  result.ready = Object.values(result.checks).every((c) => c.ok);
  return result;
}
function readOnly(root: string): DatabaseSync {
  return new DatabaseSync(join(root, 'control.sqlite'), { readOnly: true });
}
export async function createBackup(
  dataRoot: string,
  destination: string,
  onProgress?: (copied: number) => void,
): Promise<{ id: string; files: number; bytes: number }> {
  const root = realpathNoLinks(dataRoot);
  noLinks(dirname(resolve(destination)));
  const dest = join(
    realpathSync(dirname(resolve(destination))),
    basename(resolve(destination)),
  );
  noLinks(dirname(dest));
  if (existsSync(dest)) fail('TARGET_EXISTS');
  if (
    relative(root, dest) === '' ||
    (!relative(root, dest).startsWith('..' + sep) &&
      !isAbsolute(relative(root, dest)))
  )
    fail('BACKUP_INSIDE_SOURCE');
  const lock = acquireStoppedLock(root);
  let db: DatabaseSync | undefined;
  try {
    db = readOnly(root);
    if (
      Number(db.prepare('PRAGMA page_count').get()?.page_count) *
        Number(db.prepare('PRAGMA page_size').get()?.page_size) >
      LIMITS.fileBytes
    )
      fail('BACKUP_LIMIT');
    const before = inspectStorage(root, db);
    if (!before.ready) fail('SOURCE_NOT_READY');
    const sourceFiles = collect(root);
    let copied = 0;
    mkdirSync(dest, { mode: 0o700 });
    write(join(dest, '.backup-incomplete'), 'incomplete\n');
    sync(dirname(dest));
    await backup(db, join(dest, 'control.sqlite'));
    const normalized = new DatabaseSync(join(dest, 'control.sqlite'));
    try {
      normalized.exec('PRAGMA journal_mode=DELETE');
    } finally {
      normalized.close();
    }
    const fd = openSync(join(dest, 'control.sqlite'), 'r+');
    try {
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (const folder of ['content', 'plugin-state'])
      if (existsSync(join(root, folder))) {
        function copy(from: string, to: string): void {
          noLinks(from);
          if (lstatSync(from).isDirectory()) {
            mkdirSync(to, { mode: 0o700 });
            for (const n of readdirSync(from)) copy(join(from, n), join(to, n));
            sync(to);
          } else {
            const data = bytes(from);
            const e = sourceFiles.find(
              (e) => e.path === relative(root, from).split(sep).join('/'),
            );
            if (!e || data.length !== e.bytes || sha(data) !== e.sha256)
              fail('SOURCE_CHANGED');
            write(to, data);
            onProgress?.(++copied);
          }
        }
        copy(join(root, folder), join(dest, folder));
      }
    const files = collect(dest);
    const manifest: Manifest = {
      format: 'opencontext-backup',
      version: 1,
      complete: true,
      id: randomUUID(),
      storageVersion: STORAGE_FORMAT,
      mode: before.mode!,
      createdAt: new Date().toISOString(),
      heads: db
        .prepare('SELECT id,head FROM projects ORDER BY id')
        .all() as Manifest['heads'],
      files,
    };
    parseBackupManifest(manifest);
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
    if (manifestBytes.length > LIMITS.manifestBytes) fail('BACKUP_LIMIT');
    write(join(dest, 'manifest.json'), manifestBytes);
    write(join(dest, 'manifest.sha256'), sha(manifestBytes) + '\n');
    const copy = readOnly(dest);
    try {
      if (!inspectStorage(dest, copy, true).ready) fail('SNAPSHOT_NOT_READY');
    } finally {
      copy.close();
    }
    unlinkSync(join(dest, '.backup-incomplete'));
    sync(dest);
    sync(dirname(dest));
    return {
      id: manifest.id,
      files: files.length,
      bytes: files.reduce((n, e) => n + e.bytes, 0),
    };
  } finally {
    db?.close();
    lock.close();
  }
}
export function verifyBackup(snapshot: string): Manifest {
  const root = realpathNoLinks(snapshot);
  if (existsSync(join(root, '.backup-incomplete'))) fail('BACKUP_INCOMPLETE');
  const raw = bytes(join(root, 'manifest.json'), LIMITS.manifestBytes);
  if (bytes(join(root, 'manifest.sha256'), 128).toString().trim() !== sha(raw))
    fail('MANIFEST_HASH_MISMATCH');
  let m: Manifest;
  try {
    m = parseBackupManifest(JSON.parse(raw.toString()));
  } catch {
    return fail('INVALID_MANIFEST');
  }
  if (
    m.format !== 'opencontext-backup' ||
    m.version !== 1 ||
    m.storageVersion !== STORAGE_FORMAT ||
    m.complete !== true ||
    !['demo', 'private'].includes(m.mode) ||
    typeof m.id !== 'string' ||
    !Array.isArray(m.files) ||
    !Array.isArray(m.heads) ||
    m.files.length > LIMITS.files
  )
    fail('UNSUPPORTED_BACKUP');
  let total = 0;
  const names = new Set<string>();
  for (const e of m.files) {
    if (
      !e ||
      typeof e.path !== 'string' ||
      !safePath(e.path) ||
      names.has(e.path)
    )
      fail('INVALID_BACKUP_PATH');
    names.add(e.path);
    if (
      !Number.isSafeInteger(e.bytes) ||
      e.bytes < 0 ||
      e.bytes > LIMITS.fileBytes ||
      typeof e.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(e.sha256) ||
      (total += e.bytes) > LIMITS.totalBytes
    )
      fail('BACKUP_LIMIT');
    const data = bytes(join(root, e.path));
    if (data.length !== e.bytes || sha(data) !== e.sha256)
      fail('BACKUP_HASH_MISMATCH');
  }
  const actual = collect(root);
  if (actual.length !== names.size || actual.some((e) => !names.has(e.path)))
    fail('BACKUP_FILE_SET_MISMATCH');
  if (
    readdirSync(root).some(
      (n) =>
        ![
          'control.sqlite',
          'content',
          'plugin-state',
          'manifest.json',
          'manifest.sha256',
        ].includes(n),
    )
  )
    fail('UNEXPECTED_BACKUP_FILE');
  const db = readOnly(root);
  try {
    const inspection = inspectStorage(root, db, true);
    if (!inspection.ready || inspection.mode !== m.mode)
      fail('SNAPSHOT_NOT_READY');
    const heads = db.prepare('SELECT id,head FROM projects ORDER BY id').all();
    if (JSON.stringify(heads) !== JSON.stringify(m.heads))
      fail('HEAD_MISMATCH');
  } finally {
    db.close();
  }
  return m;
}
function realpathNoLinks(path: string): string {
  noLinks(path);
  return realpathSync(path);
}
export function restoreBackup(
  snapshot: string,
  destination: string,
  onProgress?: (copied: number) => void,
): { id: string; files: number; mode: string } {
  const root = realpathNoLinks(snapshot);
  noLinks(dirname(resolve(destination)));
  const dest = join(
    realpathSync(dirname(resolve(destination))),
    basename(resolve(destination)),
  );
  const rel = relative(root, dest);
  if (rel === '' || (!rel.startsWith('..' + sep) && !isAbsolute(rel)))
    fail('RESTORE_INSIDE_BACKUP');
  noLinks(dest);
  if (existsSync(dest)) fail('TARGET_EXISTS');
  const manifest = verifyBackup(root);
  mkdirSync(dest, { mode: 0o700 });
  write(join(dest, RESTORE_MARKER), 'incomplete\n');
  sync(dirname(dest));
  // A failure leaves this new destination quarantined. Never remove/overwrite it.
  let copied = 0;
  for (const e of manifest.files) {
    const data = bytes(join(root, e.path));
    if (data.length !== e.bytes || sha(data) !== e.sha256)
      fail('BACKUP_CHANGED');
    write(join(dest, e.path), data);
    onProgress?.(++copied);
  }
  const db = readOnly(dest);
  try {
    const result = inspectStorage(dest, db, true);
    if (!result.ready) fail('RESTORE_NOT_READY');
  } finally {
    db.close();
  }
  const privateDb = new DatabaseSync(join(dest, 'control.sqlite'));
  try {
    privateDb.exec(
      'BEGIN IMMEDIATE; UPDATE reader_tokens SET revoked=1; COMMIT;',
    );
  } finally {
    privateDb.close();
  }
  const controlFd = openSync(join(dest, 'control.sqlite'), 'r');
  try {
    fsyncSync(controlFd);
  } finally {
    closeSync(controlFd);
  }
  function syncTree(path: string): void {
    noLinks(path);
    if (!lstatSync(path).isDirectory()) return;
    for (const name of readdirSync(path)) syncTree(join(path, name));
    sync(path);
  }
  // Persist newly created nested directory entries before releasing quarantine.
  syncTree(dest);
  unlinkSync(join(dest, RESTORE_MARKER));
  sync(dest);
  sync(dirname(dest));
  return { id: manifest.id, files: manifest.files.length, mode: manifest.mode };
}
