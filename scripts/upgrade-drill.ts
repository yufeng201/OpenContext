/** Disposable operator drill. Never accepts user data roots or credentials. */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { FileStore } from '../packages/storage-fs/src/index.ts';
import { createApplication } from '../apps/server/src/app.ts';
import type {
  Binding,
  Project,
  ReadResult,
} from '../packages/contracts/src/index.ts';
const root = mkdtempSync(resolve(tmpdir(), 'oc-upgrade-drill-'));
const data = join(root, 'source'),
  repo = join(root, 'repo'),
  snapshot = join(root, 'snapshot'),
  restored = join(root, 'restored');
const token = 'synthetic-restore-drill-owner-00000000000';
const headers = { authorization: 'Bearer ' + token };
let app: ReturnType<typeof createApplication> | undefined;
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
function admin(...args: string[]): unknown {
  return JSON.parse(
    execFileSync(process.execPath, ['scripts/admin.ts', ...args], {
      env: { PATH: process.env['PATH'] },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}
try {
  mkdirSync(repo);
  git('init', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Recovery\nrestore-drill-needle\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  app = createApplication({
    dataRoot: data,
    ownerToken: token,
    allowedLocalRepoRoot: root,
    autoStart: false,
  });
  const project = (
    await app.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Synthetic drill' },
    })
  ).json<Project>();
  const binding = (
    await app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/bindings`,
      headers,
      payload: { name: 'Synthetic repository', repoUrl: repo, branch: 'main' },
    })
  ).json<Binding>();
  const run = await app.app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/bindings/${binding.id}/sync`,
    headers,
  });
  assert.equal(run.statusCode, 202);
  await app.coordinator.drain();
  const file = app.catalog.currentFiles(project.id)[0]!;
  const head = app.catalog.head(project.id);
  const reader = app.catalog.createReaderToken(project.id);
  const readUrl =
    `/api/projects/${project.id}/read?` +
    new URLSearchParams({ fileId: file.fileId, revisionId: file.revisionId });
  const original = (
    await app.app.inject({ url: readUrl, headers })
  ).json<ReadResult>();
  app.catalog.setAuditReadGap(true);
  await app.app.close();
  app = undefined;
  const legacyDb = new DatabaseSync(join(data, 'control.sqlite'));
  legacyDb.exec(
    "UPDATE catalog_meta SET value='1' WHERE key='storage_version'",
  );
  legacyDb.close();
  const sourceBefore = readFileSync(join(data, 'control.sqlite'));
  const backup = admin('backup', data, snapshot);
  admin('verify', snapshot);
  admin('diagnose', data);
  admin('upgrade', snapshot, restored);
  assert.deepEqual(readFileSync(join(data, 'control.sqlite')), sourceBefore);
  const rollback = join(root, 'rollback');
  admin('restore', snapshot, rollback);
  const legacyDir = join(root, 'legacy-code');
  mkdirSync(legacyDir);
  const baseline = 'ce2ca046ae4d34442d0c28137f72f4b2cb87a883';
  for (const file of ['index.ts', 'audit-storage.ts'])
    writeFileSync(
      join(legacyDir, file),
      execFileSync('git', [
        'show',
        baseline + ':packages/state-sqlite/src/' + file,
      ]),
    );
  symlinkSync(
    resolve('packages/state-sqlite/node_modules'),
    join(legacyDir, 'node_modules'),
    'dir',
  );
  const { Catalog: LegacyCatalog } = await import(
    pathToFileURL(join(legacyDir, 'index.ts')).href
  );
  assert.throws(
    () => new LegacyCatalog(join(restored, 'control.sqlite')),
    /SCHEMA_UNSUPPORTED/,
  );
  const old = new LegacyCatalog(join(rollback, 'control.sqlite'));
  try {
    assert.equal(old.head(project.id), head);
    const version = old.getRevision(project.id, file.fileId, file.revisionId);
    assert.equal(version.contentHash, original.file.contentHash);
    assert.equal(
      new FileStore(rollback).readText(version.contentHash),
      original.text,
    );
    assert.equal(old.authenticate(reader.token, token), null);
    assert.equal(old.auditReadGap(), true);
  } finally {
    old.close();
  }
  admin('diagnose', restored);
  app = createApplication({
    dataRoot: restored,
    ownerToken: token,
    allowedLocalRepoRoot: root,
    autoStart: false,
  });
  assert.equal(app.catalog.head(project.id), head);
  assert.deepEqual(
    (await app.app.inject({ url: readUrl, headers })).json(),
    original,
  );
  assert.equal(
    (
      await app.app.inject({
        url: readUrl,
        headers: { authorization: 'Bearer ' + reader.token },
      })
    ).statusCode,
    401,
  );
  const gap = await app.app.inject({ url: '/api/readiness', headers });
  assert.equal(gap.statusCode, 503);
  assert.equal(gap.json().audit.readGapPersisted, true);
  const ack = await app.app.inject({
    method: 'POST',
    url: '/api/audit/retry',
    headers,
    payload: { acknowledgeReadGap: true },
  });
  assert.equal(ack.statusCode, 200);
  const queryToken = app.catalog.createReaderToken(project.id);
  const baseUrl = await app.app.listen({ host: '127.0.0.1', port: 0 });
  const cli = await new Promise<{ code: number | null; stdout: string }>(
    (done) => {
      const child = spawn(
        process.execPath,
        [
          'scripts/opencontext.ts',
          'read',
          project.id,
          file.fileId,
          file.revisionId,
        ],
        {
          env: {
            PATH: process.env['PATH'],
            OPENCONTEXT_URL: baseUrl,
            OPENCONTEXT_QUERY_TOKEN: queryToken.token,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += String(c)));
      child.on('close', (code) => done({ code, stdout }));
    },
  );
  assert.equal(cli.code, 0);
  assert.deepEqual(JSON.parse(cli.stdout), original);
  const search = (
    await app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/search`,
      headers: { authorization: 'Bearer ' + queryToken.token },
      payload: { query: 'restore-drill-needle', mode: 'grep' },
    })
  ).json();
  assert.equal(search.hits[0].file.revisionId, file.revisionId);
  assert.equal(
    (await app.app.inject({ url: '/api/readiness', headers })).statusCode,
    200,
  );
  app.catalog.revokeBinding(binding.id);
  assert.equal(
    (
      await app.app.inject({
        url: readUrl,
        headers: { authorization: 'Bearer ' + queryToken.token },
      })
    ).statusCode,
    404,
  );
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        upgradedSchema: 2,
        rollbackSchema: 1,
        actualLegacyBaseline: 'ce2ca046',
        legacyRejectsNewSchema: true,
        originalControlUnchanged: true,
        persistedGapRequiresAcknowledgement: true,
        backup,
        fixedRevisionPreserved: true,
        headPreserved: true,
        hashAndCitationPreserved: true,
        searchPreserved: true,
        oldReaderTokensRevoked: true,
        newReaderScopeAndSourceRevocationEnforced: true,
        readinessVerified: true,
        commands: [
          'admin backup',
          'admin verify',
          'admin diagnose',
          'admin restore',
          'cli read',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app?.app.close();
  rmSync(root, { recursive: true, force: true });
}
