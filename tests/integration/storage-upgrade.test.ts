import { it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../../packages/state-sqlite/src/index.ts';
import { FileStore } from '../../packages/storage-fs/src/index.ts';
import { TextIndex } from '../../packages/retrieval/src/index.ts';
import {
  createBackup,
  verifyBackup,
  restoreBackup,
  upgradeBackup,
  inspectStorage,
} from '../../packages/state-sqlite/src/maintenance.ts';
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oc-upgrade-'));
  roots.push(root);
  const source = join(root, 'source'),
    snapshot = join(root, 'snapshot');
  const catalog = new Catalog(join(source, 'control.sqlite'));
  new FileStore(source);
  new TextIndex(catalog.db);
  const project = catalog.createProject('Synthetic upgrade');
  const reader = catalog.createReaderToken(project.id);
  catalog.setAuditReadGap(true);
  catalog.db.exec(
    "UPDATE catalog_meta SET value='1' WHERE key='storage_version'",
  );
  catalog.close();
  await createBackup(source, snapshot);
  return { root, source, snapshot, project, reader };
}
const version = (db: DatabaseSync) =>
  db.prepare("SELECT value FROM catalog_meta WHERE key='storage_version'").get()
    ?.value;
it('schema1 and unknown/current-future versions refuse startup writes with unchanged control bytes', async () => {
  const f = await fixture();
  const file = join(f.source, 'control.sqlite');
  for (const marker of ['1', '99']) {
    const db = new DatabaseSync(file);
    db.prepare(
      "UPDATE catalog_meta SET value=? WHERE key='storage_version'",
    ).run(marker);
    db.close();
    const before = readFileSync(file);
    expect(() => new Catalog(file)).toThrow(
      marker === '1' ? 'UPGRADE_REQUIRED' : 'SCHEMA_UNSUPPORTED',
    );
    expect(readFileSync(file)).toEqual(before);
  }
});
it('verified snapshot upgrade is new-only, preserves original and committed records, revokes readers and retains gap', async () => {
  const f = await fixture(),
    dest = join(f.root, 'next');
  const before = readFileSync(join(f.source, 'control.sqlite'));
  expect(verifyBackup(f.snapshot).storageVersion).toBe(1);
  upgradeBackup(f.snapshot, dest);
  expect(readFileSync(join(f.source, 'control.sqlite'))).toEqual(before);
  const next = new Catalog(join(dest, 'control.sqlite'));
  try {
    expect(version(next.db)).toBe('2');
    expect(next.getProject(f.project.id)?.id).toBe(f.project.id);
    expect(
      next.authenticate(
        f.reader.token,
        'synthetic-owner-000000000000000000000',
      ),
    ).toBe(null);
    expect(next.auditReadGap()).toBe(true);
    expect(next.pendingAuditEvents().map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'project.create',
        'token.create',
        'storage.upgrade',
      ]),
    );
    expect(
      next.pendingAuditEvents().filter((e) => e.action === 'storage.upgrade'),
    ).toHaveLength(1);
    expect(inspectStorage(dest, next.db).ready).toBe(true);
  } finally {
    next.close();
  }
  expect(() => upgradeBackup(f.snapshot, dest)).toThrow('TARGET_EXISTS');
});
it('migration failure rolls back marker and audit intent and leaves only a new quarantined destination', async () => {
  const f = await fixture(),
    dest = join(f.root, 'failed');
  expect(() =>
    upgradeBackup(f.snapshot, dest, (phase) => {
      if (phase === 'before-commit') throw new Error('synthetic fault');
    }),
  ).toThrow('synthetic fault');
  expect(existsSync(join(dest, '.restore-incomplete'))).toBe(true);
  const db = new DatabaseSync(join(dest, 'control.sqlite'), { readOnly: true });
  try {
    expect(version(db)).toBe('1');
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM audit_pending WHERE json_extract(event_json,'$.action')='storage.upgrade'",
        )
        .get()?.n,
    ).toBe(0);
  } finally {
    db.close();
  }
  expect(() => new Catalog(join(dest, 'control.sqlite'))).toThrow(
    'RESTORE_INCOMPLETE',
  );
  expect(verifyBackup(f.snapshot).complete).toBe(true);
});
it('real process interruption before and after migration commit keeps destination quarantined and snapshot recoverable', async () => {
  const f = await fixture();
  for (const phase of ['before-commit', 'after-commit'] as const) {
    const dest = join(f.root, phase);
    const module = pathToFileURL(
      join(process.cwd(), 'packages/state-sqlite/src/maintenance.ts'),
    ).href;
    const code = `import {upgradeBackup} from ${JSON.stringify(module)}; upgradeBackup(${JSON.stringify(f.snapshot)},${JSON.stringify(dest)},phase=>{if(phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL')});`;
    const result = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', code],
        { stdio: 'ignore', env: { PATH: process.env['PATH'] } },
      );
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('child deadline'));
      }, 5000);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    expect(result.signal).toBe('SIGKILL');
    expect(existsSync(join(dest, '.restore-incomplete'))).toBe(true);
    const db = new DatabaseSync(join(dest, 'control.sqlite'), {
      readOnly: true,
    });
    try {
      expect(version(db)).toBe(phase === 'before-commit' ? '1' : '2');
    } finally {
      db.close();
    }
    expect(() => new Catalog(join(dest, 'control.sqlite'))).toThrow(
      'RESTORE_INCOMPLETE',
    );
    expect(verifyBackup(f.snapshot).complete).toBe(true);
  }
  const retry = join(f.root, 'retry');
  upgradeBackup(f.snapshot, retry);
  expect(existsSync(join(retry, '.restore-incomplete'))).toBe(false);
});
it('rollback restores the original schema into a distinct directory and cannot accidentally start with the new writer', async () => {
  const f = await fixture();
  upgradeBackup(f.snapshot, join(f.root, 'next'));
  const rollback = join(f.root, 'rollback');
  restoreBackup(f.snapshot, rollback);
  const db = new DatabaseSync(join(rollback, 'control.sqlite'), {
    readOnly: true,
  });
  try {
    expect(version(db)).toBe('1');
    expect(
      db
        .prepare('SELECT revoked FROM reader_tokens WHERE id=?')
        .get(f.reader.id)?.revoked,
    ).toBe(1);
    expect(
      db
        .prepare("SELECT value FROM catalog_meta WHERE key='audit_read_gap'")
        .get()?.value,
    ).toBe('1');
    expect(inspectStorage(rollback, db).ready).toBe(true);
  } finally {
    db.close();
  }
  expect(() => new Catalog(join(rollback, 'control.sqlite'))).toThrow(
    'UPGRADE_REQUIRED',
  );
});

it('manifest/schema mismatch rejects and already-current snapshots cannot be accidentally downgraded', async () => {
  const f = await fixture();
  const manifest = JSON.parse(
    readFileSync(join(f.snapshot, 'manifest.json'), 'utf8'),
  );
  manifest.storageVersion = 2;
  const raw = JSON.stringify(manifest) + '\n';
  writeFileSync(join(f.snapshot, 'manifest.json'), raw);
  writeFileSync(
    join(f.snapshot, 'manifest.sha256'),
    createHash('sha256').update(raw).digest('hex') + '\n',
  );
  expect(() => verifyBackup(f.snapshot)).toThrow('SCHEMA_UNSUPPORTED');
  const current = new Catalog(join(f.root, 'current', 'control.sqlite'));
  new FileStore(join(f.root, 'current'));
  new TextIndex(current.db);
  current.close();
  const snapshot = join(f.root, 'current-snapshot');
  await createBackup(join(f.root, 'current'), snapshot);
  expect(() => upgradeBackup(snapshot, join(f.root, 'not-created'))).toThrow(
    'NO_UPGRADE_REQUIRED',
  );
  expect(existsSync(join(f.root, 'not-created'))).toBe(false);
});
