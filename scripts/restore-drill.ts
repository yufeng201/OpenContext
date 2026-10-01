/** Disposable operator drill. Never accepts user data roots or credentials. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createApplication } from '../apps/server/src/app.ts';
import type {
  Binding,
  Project,
  ReadResult,
} from '../packages/contracts/src/index.ts';
const root = mkdtempSync(resolve(tmpdir(), 'oc-restore-drill-'));
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
  await app.app.close();
  app = undefined;
  const backup = admin('backup', data, snapshot);
  admin('verify', snapshot);
  admin('diagnose', data);
  admin('restore', snapshot, restored);
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
