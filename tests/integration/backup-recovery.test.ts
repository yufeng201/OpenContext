import { it, expect } from 'vitest';
import { OpenContextClient } from '../../packages/http-client/src/index.ts';
import { FileStore, hash } from '../../packages/storage-fs/src/index.ts';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  cpSync,
  symlinkSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createApplication } from '../../apps/server/src/app.ts';
import {
  createBackup,
  verifyBackup,
  restoreBackup,
  RESTORE_MARKER,
  LIMITS,
  inspectStorage,
} from '../../packages/state-sqlite/src/maintenance.ts';
import {
  feishuApiFixture,
  feishuFixtureConfig,
} from '../fixtures/feishu-api.ts';
import type {
  Binding,
  Project,
  ReadResult,
} from '../../packages/contracts/src/index.ts';
const token = 'synthetic-backup-owner-token-00000000000';
const headers = { authorization: 'Bearer ' + token };
const sha = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-backup-test-')),
    data = join(root, 'data'),
    repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd: repo,
        env: {
          PATH: process.env['PATH'],
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdio: 'ignore',
      },
    );
  git('init', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Fixture\nbackup-fixed-needle\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  let app = createApplication({
    dataRoot: data,
    ownerToken: token,
    allowedLocalRepoRoot: root,
    autoStart: false,
    feishu: feishuApiFixture(),
  });
  const project = (
    await app.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Backup fixture' },
    })
  ).json<Project>();
  const binding = (
    await app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/bindings`,
      headers,
      payload: { name: 'Repository', repoUrl: repo, branch: 'main' },
    })
  ).json<Binding>();
  async function run(bindingId: string) {
    const r = await app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/bindings/${bindingId}/sync`,
      headers,
    });
    expect(r.statusCode).toBe(202);
    await app.coordinator.drain();
    expect(app.catalog.listRuns(project.id)[0]?.state).toBe('published');
  }
  await run(binding.id);
  const file = app.catalog.currentFiles(project.id)[0]!;
  const head = app.catalog.head(project.id);
  const reader = app.catalog.createReaderToken(project.id);
  const revoked = app.catalog.createReaderToken(project.id);
  app.catalog.revokeToken(revoked.id);
  const other = app.catalog.createProject('Other');
  return {
    root,
    data,
    repo,
    git,
    project,
    binding,
    file,
    head,
    reader,
    revoked,
    other,
    run,
    get app() {
      return app;
    },
    async stop() {
      await app.app.close();
    },
    async reopen(target = data) {
      app = createApplication({
        dataRoot: target,
        ownerToken: token,
        allowedLocalRepoRoot: root,
        autoStart: false,
        feishu: feishuApiFixture(),
      });
    },
    async cleanup() {
      await app.app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function mutateManifest(
  snapshot: string,
  change: (value: Record<string, unknown>) => void,
) {
  const path = join(snapshot, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(m);
  const raw = JSON.stringify(m) + '\n';
  writeFileSync(path, raw);
  writeFileSync(join(snapshot, 'manifest.sha256'), sha(raw) + '\n');
}
it('stopped snapshot restores historical fixed citations, head/search, reader scope/revoke and Feishu checkpoint', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.repo, 'README.md'), '# Fixture\nbackup-new-needle\n');
    f.git('add', '.');
    f.git('commit', '-m', 'update');
    await f.run(f.binding.id);
    const feishu = (
      await f.app.app.inject({
        method: 'POST',
        url: `/api/projects/${f.project.id}/bindings`,
        headers,
        payload: {
          name: 'Synthetic chat',
          connector: {
            packageRef: 'org.opencontext.feishu-chat@0.1.0',
            config: feishuFixtureConfig,
          },
          processor: {
            packageRef: 'org.opencontext.feishu-chat-analysis@0.1.0',
            config: {},
          },
        },
      })
    ).json<Binding>();
    expect(feishu.id).toBeTruthy();
    await f.run(feishu.id);
    const beforeHead = f.app.catalog.head(f.project.id);
    const readUrl =
      `/api/projects/${f.project.id}/read?` +
      new URLSearchParams({
        fileId: f.file.fileId,
        revisionId: f.file.revisionId,
      });
    const fixed = (
      await f.app.app.inject({ url: readUrl, headers })
    ).json<ReadResult>();
    expect(fixed.text).toContain('backup-fixed-needle');
    const snapshot = join(f.root, 'snapshot');
    await expect(createBackup(f.data, snapshot)).rejects.toThrow(
      'CATALOG_IN_USE',
    );
    expect(existsSync(snapshot)).toBe(false);
    await f.stop();
    const result = await createBackup(f.data, snapshot);
    expect(result.files).toBeGreaterThan(3);
    const manifest = verifyBackup(snapshot);
    expect(
      manifest.files.some((e) =>
        e.path.startsWith('plugin-state/feishu-chat/'),
      ),
    ).toBe(true);
    const restored = join(f.root, 'restored');
    restoreBackup(snapshot, restored);
    expect(existsSync(join(restored, RESTORE_MARKER))).toBe(false);
    expect(statSync(restored).mode & 0o777).toBe(0o700);
    await f.reopen(restored);
    expect(f.app.catalog.head(f.project.id)).toBe(beforeHead);
    expect(
      (
        await f.app.app.inject({
          url: readUrl,
          headers: { authorization: 'Bearer ' + f.reader.token },
        })
      ).statusCode,
    ).toBe(401);
    const restoredReader = f.app.catalog.createReaderToken(f.project.id);
    const readerHeaders = { authorization: 'Bearer ' + restoredReader.token };
    expect(
      (await f.app.app.inject({ url: readUrl, headers: readerHeaders })).json(),
    ).toEqual(fixed);
    const search = (
      await f.app.app.inject({
        method: 'POST',
        url: `/api/projects/${f.project.id}/search`,
        headers: readerHeaders,
        payload: { query: 'backup-new-needle', mode: 'grep' },
      })
    ).json();
    expect(search.hits[0].file.fileId).toBe(f.file.fileId);
    expect(
      (
        await f.app.app.inject({
          url: `/api/projects/${f.other.id}/tree`,
          headers: readerHeaders,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: readerHeaders,
          payload: { name: 'Denied' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.app.inject({
          url: '/api/projects',
          headers: { authorization: 'Bearer ' + f.revoked.token },
        })
      ).statusCode,
    ).toBe(401);
    const ready = await f.app.app.inject({ url: '/api/readiness', headers });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().ready).toBe(true);
    expect(ready.json().checks.pluginState.ok).toBe(true);
    expect(ready.headers['x-request-id']).toBe(ready.json().requestId);
    f.app.catalog.revokeBinding(f.binding.id);
    expect(
      (await f.app.app.inject({ url: readUrl, headers: readerHeaders }))
        .statusCode,
    ).toBe(404);
  } finally {
    await f.cleanup();
  }
});
it('backup and restore interruptions stay quarantined and never overwrite any existing directory', async () => {
  const f = await fixture();
  try {
    await f.stop();
    const incomplete = join(f.root, 'interrupted');
    await expect(
      createBackup(f.data, incomplete, () => {
        throw new Error('INTERRUPTED');
      }),
    ).rejects.toThrow('INTERRUPTED');
    expect(existsSync(join(incomplete, '.backup-incomplete'))).toBe(true);
    expect(() => verifyBackup(incomplete)).toThrow('BACKUP_INCOMPLETE');
    expect(() =>
      createApplication({ dataRoot: incomplete, ownerToken: token }),
    ).toThrow('BACKUP_IS_NOT_DATA_ROOT');
    const good = join(f.root, 'snapshot');
    await createBackup(f.data, good);
    const restored = join(f.root, 'partial-restored');
    expect(() =>
      restoreBackup(good, restored, () => {
        throw new Error('INTERRUPTED');
      }),
    ).toThrow('INTERRUPTED');
    expect(existsSync(join(restored, RESTORE_MARKER))).toBe(true);
    expect(() =>
      createApplication({ dataRoot: restored, ownerToken: token }),
    ).toThrow('RESTORE_INCOMPLETE');
    expect(() => restoreBackup(good, restored)).toThrow('TARGET_EXISTS');
    const existing = join(f.root, 'existing');
    mkdirSync(existing);
    writeFileSync(join(existing, 'keep.txt'), 'keep');
    expect(() => restoreBackup(good, existing)).toThrow('TARGET_EXISTS');
    expect(readFileSync(join(existing, 'keep.txt'), 'utf8')).toBe('keep');
    const empty = join(f.root, 'empty');
    mkdirSync(empty);
    expect(() => restoreBackup(good, empty)).toThrow('TARGET_EXISTS');
  } finally {
    await f.cleanup();
  }
});
it('rejects version/path/hash/schema damage, symlinks, missing blobs, oversized and extra files before restore writes', async () => {
  const f = await fixture();
  try {
    await f.stop();
    const good = join(f.root, 'snapshot');
    await createBackup(f.data, good);
    for (const [name, change] of [
      ['version', (m: Record<string, unknown>) => (m.version = 99)],
      [
        'path',
        (m: Record<string, unknown>) =>
          ((m.files as { path: string }[])[0]!.path = '../escape'),
      ],
      [
        'encoded',
        (m: Record<string, unknown>) =>
          ((m.files as { path: string }[])[0]!.path = 'content/%2e%2e/escape'),
      ],
      [
        'oversize',
        (m: Record<string, unknown>) =>
          ((m.files as { bytes: number }[])[0]!.bytes = LIMITS.fileBytes + 1),
      ],
    ] as const) {
      const copy = join(f.root, name);
      cpSync(good, copy, { recursive: true });
      mutateManifest(copy, change);
      const target = join(f.root, name + '-restore');
      expect(() => restoreBackup(copy, target)).toThrow();
      expect(existsSync(target)).toBe(false);
      expect(existsSync(join(f.root, 'escape'))).toBe(false);
    }
    const blobPath = verifyBackup(good).files.find((e) =>
      e.path.startsWith('content/blobs/'),
    )!.path;
    for (const name of ['missing', 'corrupt', 'symlink', 'extra', 'large']) {
      const copy = join(f.root, name);
      cpSync(good, copy, { recursive: true });
      if (name === 'missing') rmSync(join(copy, blobPath));
      if (name === 'corrupt') writeFileSync(join(copy, blobPath), 'corrupt');
      if (name === 'symlink') {
        rmSync(join(copy, blobPath));
        symlinkSync(join(good, blobPath), join(copy, blobPath));
      }
      if (name === 'extra')
        writeFileSync(join(copy, 'content', 'extra'), 'extra');
      if (name === 'large') {
        const large = join(copy, 'content', 'large');
        writeFileSync(large, '');
        truncateSync(large, LIMITS.fileBytes + 1);
      }
      expect(() => verifyBackup(copy)).toThrow();
      const target = join(f.root, name + '-restore');
      expect(() => restoreBackup(copy, target)).toThrow();
      expect(existsSync(target)).toBe(false);
    }
    const schema = join(f.root, 'schema');
    cpSync(good, schema, { recursive: true });
    const db = new DatabaseSync(join(schema, 'control.sqlite'));
    db.prepare(
      "UPDATE catalog_meta SET value='99' WHERE key='storage_version'",
    ).run();
    db.close();
    mutateManifest(schema, (m) => {
      const e = (
        m.files as { path: string; bytes: number; sha256: string }[]
      ).find((e) => e.path === 'control.sqlite')!;
      const raw = readFileSync(join(schema, e.path));
      e.bytes = raw.length;
      e.sha256 = sha(raw);
    });
    expect(() => verifyBackup(schema)).toThrow('SNAPSHOT_NOT_READY');
  } finally {
    await f.cleanup();
  }
});
it('readiness fails dependencies independently while liveness stays200, with redacted request IDs', async () => {
  const f = await fixture();
  try {
    expect((await f.app.app.inject({ url: '/api/health' })).statusCode).toBe(
      200,
    );
    const denied = await f.app.app.inject({
      url: '/api/readiness',
      headers: { authorization: 'Bearer ' + f.reader.token },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.correlationId).toBe(
      denied.headers['x-request-id'],
    );
    expect(denied.body).not.toContain(f.reader.token);
    const blob = join(
      f.data,
      'content',
      'blobs',
      f.file.contentHash.slice(0, 2),
      f.file.contentHash,
    );
    const original = readFileSync(blob);
    rmSync(blob);
    let ready = await f.app.app.inject({ url: '/api/readiness', headers });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.storage.ok).toBe(false);
    expect(ready.body).not.toContain(f.data);
    expect(ready.body).not.toContain('backup-fixed-needle');
    expect((await f.app.app.inject({ url: '/api/health' })).statusCode).toBe(
      200,
    );
    const baseUrl = await f.app.app.listen({ host: '127.0.0.1', port: 0 });
    const report = await new OpenContextClient({ baseUrl, token }).readiness();
    expect(report.ready).toBe(false);
    expect(report.checks.storage?.ok).toBe(false);
    const cli = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((done, reject) => {
      const child = spawn(
        process.execPath,
        ['scripts/opencontext.ts', 'readiness'],
        {
          env: {
            PATH: process.env['PATH'],
            OPENCONTEXT_URL: baseUrl,
            OPENCONTEXT_QUERY_TOKEN: token,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (c) => (stdout += String(c)));
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.on('error', reject);
      child.on('close', (code) => done({ code, stdout, stderr }));
    });
    expect(cli.code).toBe(1);
    expect(JSON.parse(cli.stdout).checks.storage.ok).toBe(false);
    expect(cli.stdout + cli.stderr).not.toContain(token);
    expect(cli.stdout + cli.stderr).not.toContain(f.data);
    writeFileSync(blob, original);
    f.app.catalog.db
      .prepare('DELETE FROM retrieval_generations WHERE project_id=?')
      .run(f.project.id);
    ready = await f.app.app.inject({ url: '/api/readiness', headers });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.index.code).toBe('INDEX_NOT_READY');
    f.app.catalog.db
      .prepare('INSERT INTO retrieval_generations VALUES(?,?)')
      .run(f.project.id, f.head!);
    f.app.catalog.db.exec('DELETE FROM retrieval_fts');
    ready = await f.app.app.inject({ url: '/api/readiness', headers });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.index.ok).toBe(false);
    f.app.catalog.db
      .prepare("UPDATE catalog_meta SET value='99' WHERE key='storage_version'")
      .run();
    expect(inspectStorage(f.data, f.app.catalog.db).checks.migration.ok).toBe(
      false,
    );
    await f.stop();
    expect(() =>
      createApplication({ dataRoot: f.data, ownerToken: token }),
    ).toThrow('SCHEMA_UNSUPPORTED');
  } finally {
    await f.cleanup();
  }
});
it('operator CLI cannot use query credentials and does not log raw filesystem errors', async () => {
  const command = async (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (done) => {
        const p = spawn(process.execPath, ['scripts/admin.ts', ...args], {
          env: { PATH: process.env['PATH'], ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        p.stdout.on('data', (c) => (stdout += String(c)));
        p.stderr.on('data', (c) => (stderr += String(c)));
        p.on('close', (code) => done({ code, stdout, stderr }));
      },
    );
  const secret = 'synthetic-reader-must-not-manage';
  const denied = await command(
    ['restore', '/not/a/snapshot', '/not/a/target'],
    { OPENCONTEXT_QUERY_TOKEN: secret },
  );
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain('QUERY_CREDENTIAL_NOT_ALLOWED');
  expect(denied.stderr).not.toContain(secret);
  const bad = await command(['verify', '/private-missing-example'], {});
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain('OPERATION_FAILED');
  expect(bad.stderr).not.toContain('/private-missing-example');
});
it('SIGKILL after a durable copied file quarantines backup/restore and releases the stopped-source lock', async () => {
  const f = await fixture();
  try {
    await f.stop();
    const moduleUrl = new URL(
      '../../packages/state-sqlite/src/maintenance.ts',
      import.meta.url,
    ).href;
    const killDuring = async (
      kind: 'backup' | 'restore',
      source: string,
      target: string,
    ) =>
      new Promise<NodeJS.Signals | null>((done) => {
        const program = `const m=await import(${JSON.stringify(moduleUrl)});${kind === 'backup' ? 'await m.createBackup' : 'm.restoreBackup'}(${JSON.stringify(source)},${JSON.stringify(target)},()=>process.kill(process.pid,'SIGKILL'));`;
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', program],
          { env: { PATH: process.env['PATH'] }, stdio: 'ignore' },
        );
        child.on('close', (_code, signal) => done(signal));
      });
    const partial = join(f.root, 'killed-backup');
    expect(await killDuring('backup', f.data, partial)).toBe('SIGKILL');
    expect(existsSync(join(partial, '.backup-incomplete'))).toBe(true);
    expect(() => verifyBackup(partial)).toThrow('BACKUP_INCOMPLETE');
    const good = join(f.root, 'good-after-kill');
    await createBackup(f.data, good);
    expect(verifyBackup(good).complete).toBe(true);
    const restored = join(f.root, 'killed-restore');
    expect(await killDuring('restore', good, restored)).toBe('SIGKILL');
    expect(existsSync(join(restored, RESTORE_MARKER))).toBe(true);
    expect(() =>
      createApplication({ dataRoot: restored, ownerToken: token }),
    ).toThrow('RESTORE_INCOMPLETE');
    expect(() => restoreBackup(good, restored)).toThrow('TARGET_EXISTS');
  } finally {
    await f.cleanup();
  }
});

it('FileStore rejects existing and dangling internal symlinks before reading or writing', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-link-test-'));
  try {
    const data = join(root, 'data'),
      outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), 'unchanged');
    const store = new FileStore(data);
    symlinkSync(outside, join(store.root, 'blobs'));
    expect(() => store.putText('forbidden')).toThrow('UNSAFE_SYMLINK');
    expect(() => store.readText(hash('forbidden'))).toThrow('UNSAFE_SYMLINK');
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    rmSync(join(store.root, 'blobs'));
    symlinkSync(join(root, 'nonexistent'), join(store.root, 'blobs'));
    expect(() => store.putText('forbidden')).toThrow('UNSAFE_SYMLINK');
    expect(existsSync(join(root, 'nonexistent'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('readiness SDK refuses arbitrary503 error bodies instead of echoing secret fields', async () => {
  const client = new OpenContextClient({
    baseUrl: 'http://127.0.0.1:4310',
    token: 'synthetic-only',
    fetch: async () =>
      new Response(
        JSON.stringify({ secret: 'must-not-echo', path: '/private/user/path' }),
        { status: 503 },
      ),
  });
  await expect(client.readiness()).rejects.toMatchObject({
    code: 'INVALID_READINESS_RESPONSE',
    message: 'INVALID_READINESS_RESPONSE',
  });
});
