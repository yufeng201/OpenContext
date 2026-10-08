/** Bounded synthetic loopback experiment; no environment data roots or credentials. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createApplication } from '../apps/server/src/app.ts';
const started = Date.now(),
  root = mkdtempSync(join(tmpdir(), 'oc-load-')),
  repo = join(root, 'repo');
const owner = 'synthetic-bounded-load-owner-000000000000';
const headers = { authorization: 'Bearer ' + owner };
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
      timeout: 5000,
    },
  );
try {
  mkdirSync(repo);
  git('init', '-b', 'main');
  for (let n = 0; n < 50; n++)
    writeFileSync(
      join(repo, `file-${n}.md`),
      '# bounded-load-needle\n' + 'synthetic text\n'.repeat(70),
    );
  git('add', '.');
  git('commit', '-m', 'v1');
  app = createApplication({
    dataRoot: join(root, 'data'),
    ownerToken: owner,
    allowedLocalRepoRoot: root,
    autoStart: false,
  });
  const project = (
    await app.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Load fixture' },
    })
  ).json();
  const other = (
    await app.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Other fixture' },
    })
  ).json();
  const binding = (
    await app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/bindings`,
      headers,
      payload: { name: 'repo', repoUrl: repo, branch: 'main' },
    })
  ).json();
  const sync = async () => {
    assert.equal(
      (
        await app!.app.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/bindings/${binding.id}/sync`,
          headers,
        })
      ).statusCode,
      202,
    );
    await app!.coordinator.drain();
    assert.equal(app!.catalog.listRuns(project.id)[0]!.state, 'published');
  };
  await sync();
  const historical = app.catalog.currentFiles(project.id)[0]!;
  for (let n = 0; n < 50; n++)
    writeFileSync(
      join(repo, `file-${n}.md`),
      '# bounded-load-needle v2\n' + 'synthetic text\n'.repeat(70),
    );
  git('add', '.');
  git('commit', '-m', 'v2');
  await sync();
  assert.equal(app.catalog.currentFiles(project.id).length, 50);
  assert.equal(
    app.catalog.db
      .prepare('SELECT count(*) AS n FROM revisions WHERE project_id=?')
      .get(project.id)?.n,
    100,
  );
  const reader = app.catalog.createReaderToken(project.id);
  app.auditDispatcher.flush();
  const url = await app.app.listen({ host: '127.0.0.1', port: 0 });
  const readerHeaders = { authorization: 'Bearer ' + reader.token },
    latencies: number[] = [];
  let next = 0,
    peakRss = process.memoryUsage().rss;
  const deadline = AbortSignal.timeout(30000);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < 200) {
        const n = next++,
          t = performance.now();
        const read = n % 5 === 0;
        const response = await fetch(
          url +
            (read
              ? `/api/projects/${project.id}/read?` +
                new URLSearchParams({
                  fileId: historical.fileId,
                  revisionId: historical.revisionId,
                })
              : `/api/projects/${project.id}/search`),
          {
            method: read ? 'GET' : 'POST',
            headers: {
              ...readerHeaders,
              ...(read ? {} : { 'content-type': 'application/json' }),
            },
            ...(read
              ? {}
              : {
                  body: JSON.stringify({
                    query: 'bounded-load-needle',
                    mode: 'grep',
                    limit: 50,
                  }),
                }),
            signal: deadline,
          },
        );
        assert.equal(response.status, 200);
        const value = await response.json();
        if (read) {
          assert.equal(value.file.revisionId, historical.revisionId);
          assert.equal(value.file.contentHash, historical.contentHash);
        } else {
          assert.equal(value.hits.length, 8);
          assert.equal(
            value.hits.reduce(
              (sum: number, h: { excerpt: string }) => sum + h.excerpt.length,
              0,
            ),
            4096,
          );
          assert(
            value.hits.every(
              (h: { file: { projectId: string } }) =>
                h.file.projectId === project.id,
            ),
          );
        }
        latencies.push(performance.now() - t);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
    }),
  );
  assert.equal(
    (
      await fetch(url + `/api/projects/${other.id}/tree`, {
        headers: readerHeaders,
      })
    ).status,
    403,
  );
  assert.equal(
    (await app.app.inject({ url: '/api/readiness', headers })).statusCode,
    200,
  );
  latencies.sort((a, b) => a - b);
  const p = (q: number) =>
    Math.round(
      latencies[
        Math.min(latencies.length - 1, Math.floor(latencies.length * q))
      ]! * 100,
    ) / 100;
  assert.equal(latencies.length, 200);
  assert(peakRss <= 512 * 1024 * 1024);
  assert(p(0.95) <= 1000);
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        files: 50,
        revisions: 100,
        spaces: 2,
        concurrency: 4,
        requests: 200,
        readRequests: 40,
        searchRequests: 160,
        unexpectedFailures: 0,
        p50Ms: p(0.5),
        p95Ms: p(0.95),
        maxMs: p(1),
        sampledPeakProcessRssBytes: peakRss,
        requestBudgetMs: 30000,
        elapsedMs: Date.now() - started,
        historicalFixedRead: true,
        crossSpaceDenied: true,
        readiness: true,
        scope:
          'one short local synthetic trial; no SLO/endurance/HA/real upstream claim',
      },
      null,
      2,
    ),
  );
} finally {
  await app?.app.close();
  rmSync(root, { recursive: true, force: true });
}
