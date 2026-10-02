import { it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../../packages/state-sqlite/src/index.ts';
import { createApplication } from '../../apps/server/src/app.ts';
import { FileStore } from '../../packages/storage-fs/src/index.ts';
import { TextIndex } from '../../packages/retrieval/src/index.ts';
import {
  inspectStorage,
  createBackup,
  verifyBackup,
  restoreBackup,
} from '../../packages/state-sqlite/src/maintenance.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oc-integrity-'));
  roots.push(root);
  const data = join(root, 'data');
  const c = new Catalog(join(data, 'control.sqlite'));
  new FileStore(data);
  new TextIndex(c.db);
  return { root, data, c };
}
for (const [name, sql] of Object.entries({
  table: 'DROP TABLE audit_pending',
  retrieval: 'DROP TABLE retrieval_fts',
  generation: 'DROP TABLE retrieval_generations',
  ledger:
    "DELETE FROM catalog_meta WHERE key='audit_format'; DROP TABLE audit_pending; DROP TABLE audit_events",
  column: 'ALTER TABLE bindings DROP COLUMN source_version',
  marker: "DELETE FROM catalog_meta WHERE key='deployment_mode'",
  unique: 'DROP INDEX one_current_import_filename',
  constraint:
    "DROP INDEX one_active_run; CREATE UNIQUE INDEX one_active_run ON runs(binding_id,kind) WHERE state='running'",
}))
  it(`existing schema2 rejects ${name} damage without changing control bytes`, () => {
    const f = fixture();
    f.c.createProject('Keep evidence');
    f.c.db.exec(sql);
    f.c.close();
    const path = join(f.data, 'control.sqlite'),
      before = readFileSync(path);
    let reopened: Catalog | undefined;
    try {
      expect(() => {
        reopened = new Catalog(path);
      }).toThrow('SCHEMA_INCOMPLETE');
    } finally {
      reopened?.close();
    }
    expect(readFileSync(path)).toEqual(before);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspectStorage(f.data, db).ready).toBe(false);
    } finally {
      db.close();
    }
  });
it('schema2 meta alone is refused without adding tables', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-minimal-'));
  roots.push(root);
  const path = join(root, 'control.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; INSERT INTO catalog_meta VALUES('storage_version','2'),('deployment_mode','private')",
  );
  db.close();
  const before = readFileSync(path);
  let c: Catalog | undefined;
  try {
    expect(() => {
      c = new Catalog(path);
    }).toThrow('SCHEMA_INCOMPLETE');
  } finally {
    c?.close();
  }
  expect(readFileSync(path)).toEqual(before);
});
for (const target of [
  'control.sqlite',
  'control.sqlite.authority.sqlite',
  'parent',
])
  it(`server rejects ${target} link before writing quarantined target`, () => {
    const f = fixture();
    f.c.close();
    writeFileSync(join(f.data, '.restore-incomplete'), 'incomplete');
    const safe = join(f.root, 'safe');
    mkdirSync(safe, { mode: 0o700 });
    if (target === 'parent') symlinkSync(f.data, join(safe, 'nested'));
    else symlinkSync(join(f.data, target), join(safe, target));
    const before = readFileSync(join(f.data, 'control.sqlite'));
    expect(() =>
      createApplication({
        dataRoot: target === 'parent' ? join(safe, 'nested') : safe,
        ownerToken: 'synthetic-integrity-owner-000000000000',
        autoStart: false,
      }),
    ).toThrow('UNSAFE_SYMLINK');
    expect(readFileSync(join(f.data, 'control.sqlite'))).toEqual(before);
  });
for (const damage of [
  'head',
  'current-row',
  'revision-row',
  'first-commit',
  'parent',
] as const)
  it(`valid hashes with inconsistent ${damage} fail inspection, backup, verification and restore`, async () => {
    const f = fixture(),
      s = new FileStore(f.data),
      p = f.c.createProject('Head'),
      now = new Date().toISOString();
    const file = {
      fileId: 'file1',
      revisionId: 'rev1',
      ...s.putText('old snapshot'),
      projectId: p.id,
      bindingId: 'binding1',
      slotKey: 'source',
      logicalPath: 'sources/x.txt',
      collection: 'sources' as const,
      ownership: 'source_managed' as const,
      freshness: 'fresh' as const,
      tombstone: false,
      sourceVersion: 'git1:synthetic',
      createdAt: now,
      derivedFrom: [],
    };
    s.revision(file);
    f.c.db
      .prepare(
        'INSERT INTO bindings(id,project_id,name,instance_ref,package_ref,config_json) VALUES(?,?,?,?,?,?)',
      )
      .run('binding1', p.id, 'Binding', 'synthetic@1', 'synthetic@1', '{}');
    for (const [id, files, parent] of [
      ['commit1', [file], null],
      ['commit2', [], 'commit1'],
    ] as const) {
      f.c.db
        .prepare(
          'INSERT INTO runs(id,project_id,binding_id,kind,state,incarnation,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          'run-' + id,
          p.id,
          'binding1',
          'sync',
          'published',
          f.c.incarnation,
          now,
        );
      const hash = s.manifest(p.id, id, parent, [...files]);
      f.c.db
        .prepare(
          'INSERT INTO commits(project_id,id,parent_id,manifest_hash,run_id,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(p.id, id, parent, hash, 'run-' + id, now);
    }
    f.c.db
      .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?)')
      .run(
        p.id,
        file.fileId,
        file.revisionId,
        file.contentHash,
        JSON.stringify(file),
        'commit1',
      );
    f.c.db
      .prepare('INSERT INTO current_files VALUES(?,?,?,?,?,?,?)')
      .run(
        p.id,
        file.fileId,
        file.revisionId,
        file.bindingId,
        file.logicalPath,
        0,
        JSON.stringify(file),
      );
    f.c.db
      .prepare('UPDATE projects SET head=? WHERE id=?')
      .run('commit1', p.id);
    new TextIndex(f.c.db).replaceProject(p.id, 'commit1', [
      { file, text: 'old snapshot' },
    ]);
    f.c.close();
    const snapshot = join(f.root, 'snapshot');
    await createBackup(f.data, snapshot);
    for (const path of [
      join(f.data, 'control.sqlite'),
      join(snapshot, 'control.sqlite'),
    ]) {
      const db = new DatabaseSync(path);
      if (damage === 'head') {
        db.prepare('UPDATE projects SET head=? WHERE id=?').run(
          'commit2',
          p.id,
        );
        db.prepare(
          'UPDATE retrieval_generations SET commit_id=? WHERE project_id=?',
        ).run('commit2', p.id);
      } else if (damage === 'current-row')
        db.prepare('UPDATE current_files SET logical_path=?').run(
          'sources/conflicting.txt',
        );
      else if (damage === 'revision-row')
        db.prepare('UPDATE revisions SET entry_json=?').run(
          JSON.stringify({ ...file, fileId: 'anotherfile' }),
        );
      else if (damage === 'first-commit')
        db.prepare('UPDATE revisions SET first_commit=?').run('commit2');
      else
        db.prepare('UPDATE commits SET parent_id=? WHERE id=?').run(
          'commit2',
          'commit1',
        );
      db.close();
    }
    const db = new DatabaseSync(join(f.data, 'control.sqlite'), {
      readOnly: true,
    });
    try {
      expect(inspectStorage(f.data, db).checks.storage.code).toBe(
        damage === 'head'
          ? 'CORRUPT_HEAD'
          : damage === 'parent'
            ? 'CORRUPT_MANIFEST'
            : 'CORRUPT_REFERENCE',
      );
    } finally {
      db.close();
    }
    await expect(
      createBackup(f.data, join(f.root, 'bad-snapshot')),
    ).rejects.toThrow('SOURCE_NOT_READY');
    const { createHash } = await import('node:crypto');
    const hash = (b: Uint8Array) =>
      createHash('sha256').update(b).digest('hex');
    const manifest = JSON.parse(
      readFileSync(join(snapshot, 'manifest.json'), 'utf8'),
    );
    const entry = manifest.files.find(
      (e: { path: string }) => e.path === 'control.sqlite',
    );
    const bytes = readFileSync(join(snapshot, 'control.sqlite'));
    entry.bytes = bytes.length;
    entry.sha256 = hash(bytes);
    if (damage === 'head') manifest.heads[0].head = 'commit2';
    const body = JSON.stringify(manifest, null, 2) + '\n';
    writeFileSync(join(snapshot, 'manifest.json'), body);
    writeFileSync(
      join(snapshot, 'manifest.sha256'),
      hash(Buffer.from(body)) + '\n',
    );
    expect(() => verifyBackup(snapshot)).toThrow('SNAPSHOT_NOT_READY');
    expect(() => restoreBackup(snapshot, join(f.root, 'restored'))).toThrow(
      'SNAPSHOT_NOT_READY',
    );
    expect(existsSync(join(f.root, 'restored'))).toBe(false);
  });

it('an existing empty database is refused; a genuinely new database initializes and reopens', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-empty-db-'));
  roots.push(root);
  const path = join(root, 'control.sqlite');
  writeFileSync(path, '');
  expect(() => new Catalog(path)).toThrow('SCHEMA_INCOMPLETE');
  expect(readFileSync(path).length).toBe(0);
  const fresh = join(root, 'new', 'control.sqlite');
  const c = new Catalog(fresh);
  c.createProject('Fresh');
  c.close();
  const reopened = new Catalog(fresh);
  try {
    expect(reopened.listProjects()[0]?.name).toBe('Fresh');
  } finally {
    reopened.close();
  }
});
