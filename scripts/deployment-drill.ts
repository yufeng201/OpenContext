import { noLinks } from '../packages/state-sqlite/src/maintenance.ts';
/** Fresh source copy, frozen install and synthetic private start/upgrade drill. */
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import type { createApplication } from '../apps/server/src/app.ts';
const startedAt = Date.now();
const root = mkdtempSync(join(tmpdir(), 'oc-clean-deploy-')),
  checkout = join(root, 'checkout'),
  repo = join(root, 'synthetic-repo'),
  userConfig = join(root, 'empty-npmrc');
let data = join(root, 'data');
const owner = 'synthetic-deployment-owner-000000000000000';
mkdirSync(checkout, { mode: 0o700 });
writeFileSync(userConfig, '', { mode: 0o600 });
const env = {
  PATH: process.env['PATH'],
  NPM_CONFIG_USERCONFIG: userConfig,
  NPM_CONFIG_GLOBALCONFIG: userConfig,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
const production = {
  ...env,
  NODE_ENV: 'production',
  OPENCONTEXT_OWNER_TOKEN: owner,
  OPENCONTEXT_DATA_ROOT: data,
  PORT: '0',
};
const sha = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
let child: ReturnType<typeof spawn> | undefined;
async function stop() {
  if (!child) return;
  const c = child;
  child = undefined;
  if (c.exitCode === null && c.signalCode === null) {
    const closed = once(c, 'close');
    c.kill('SIGTERM');
    await closed;
  }
}
function run(
  command: string,
  args: string[],
  cwd = checkout,
  environment: NodeJS.ProcessEnv = env,
) {
  const r = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8_388_608,
  });
  if (r.error) throw new Error('DRILL_SUBPROCESS_FAILED');
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function successful(
  command: string,
  args: string[],
  cwd = checkout,
  environment: NodeJS.ProcessEnv = env,
) {
  const r = run(command, args, cwd, environment);
  assert.equal(r.status, 0, 'Synthetic drill step failed');
  return r;
}
function report(text: string) {
  const start = text.indexOf('{');
  assert(start >= 0);
  return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as Record<
    string,
    unknown
  >;
}
async function launch() {
  child = spawn(process.execPath, ['apps/server/src/main.ts'], {
    cwd: checkout,
    env: production,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const c = child;
  return await new Promise<string>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('STARTUP_TIMEOUT')), 8000);
    let out = '';
    c.stdout!.on('data', (part) => {
      out += String(part);
      const url =
        /OpenContext local development slice: (http:\/\/127\.0\.0\.1:\d+)/.exec(
          out,
        )?.[1];
      if (url) {
        clearTimeout(timer);
        done(url);
      }
    });
    c.once('error', () => {
      clearTimeout(timer);
      reject(new Error('STARTUP_FAILED'));
    });
    c.once('close', () => {
      clearTimeout(timer);
      reject(new Error('STARTUP_FAILED'));
    });
  });
}
try {
  const list = successful(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    process.cwd(),
  )
    .out.split('\0')
    .filter(Boolean);
  for (const file of list) {
    assert(
      !file
        .split('/')
        .some((p) =>
          [
            '.git',
            'node_modules',
            '.cache',
            'runtime',
            'data',
            'secrets',
            'credentials',
          ].includes(p),
        ),
    );
    const target = join(checkout, file);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    noLinks(resolve(file));
    copyFileSync(resolve(file), target);
  }
  successful('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet']);
  const lockBefore = sha(join(checkout, 'pnpm-lock.yaml'));
  console.log(
    'Stage: fresh frozen install; no copied node_modules or dependency cache',
  );
  successful('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']);
  assert.equal(sha(join(checkout, 'pnpm-lock.yaml')), lockBefore);
  console.log('Stage: fresh build and deployment preflight');
  successful('pnpm', ['build']);
  successful('pnpm', ['docs:build']);
  assert.equal(
    report(successful('pnpm', ['preflight'], checkout, production).out).data,
    'new',
  );
  const first = await launch();
  assert.equal((await fetch(first + '/api/health')).status, 200);
  assert.equal((await fetch(first + '/')).status, 200);
  assert.equal((await fetch(first + '/api/projects')).status, 401);
  await stop();
  console.log(
    'Stage: create isolated published fixture, legacy-compatible upgrade and fixed read',
  );
  mkdirSync(repo, { mode: 0o700 });
  const git = (...args: string[]) =>
    successful(
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
      repo,
    );
  git('init', '-b', 'main');
  writeFileSync(
    join(repo, 'README.md'),
    '# Deployment\nclean-deployment-needle\n',
  );
  git('add', '.');
  git('commit', '-m', 'synthetic fixture');
  const module = (await import(
    pathToFileURL(join(checkout, 'apps/server/src/app.ts')).href
  )) as { createApplication: typeof createApplication };
  const app = module.createApplication({
    dataRoot: data,
    ownerToken: owner,
    autoStart: false,
    allowedLocalRepoRoot: root,
  });
  let projectId: string,
    fileId: string,
    revisionId: string,
    head: string | null,
    original: unknown;
  try {
    const project = app.catalog.createProject('Synthetic deployment');
    projectId = project.id;
    const binding = (
      await app.app.inject({
        method: 'POST',
        url: '/api/projects/' + project.id + '/bindings',
        headers: { authorization: 'Bearer ' + owner },
        payload: { name: 'Synthetic Git', repoUrl: repo, branch: 'main' },
      })
    ).json();
    app.catalog.enqueue(binding.id, 'sync');
    await app.coordinator.drain();
    const file = app.catalog.currentFiles(project.id)[0]!;
    fileId = file.fileId;
    revisionId = file.revisionId;
    head = app.catalog.head(project.id);
    original = (
      await app.app.inject({
        url:
          '/api/projects/' +
          project.id +
          '/read?' +
          new URLSearchParams({ fileId, revisionId }),
        headers: { authorization: 'Bearer ' + owner },
      })
    ).json();
    assert.match(
      (original as { text: string }).text,
      /clean-deployment-needle/,
    );
  } finally {
    await app.app.close();
  }
  const legacy = new DatabaseSync(join(data, 'control.sqlite'));
  legacy.prepare("DELETE FROM catalog_meta WHERE key='storage_version'").run();
  legacy.close();
  const compatible = report(
    run('pnpm', ['preflight'], checkout, production).out,
  );
  assert.equal(compatible.ready, false);
  assert.equal(compatible.upgradeRequired, true);
  assert.equal(
    (compatible.inspection as { checks: { migration: { code: string } } })
      .checks.migration.code,
    'LEGACY_COMPATIBLE',
  );
  const oldHash = sha(join(data, 'control.sqlite'));
  const snapshot = join(root, 'pre-upgrade-snapshot');
  const nextData = join(root, 'upgraded-data');
  successful(
    process.execPath,
    ['scripts/admin.ts', 'backup', data, snapshot],
    checkout,
    env,
  );
  successful(
    process.execPath,
    ['scripts/admin.ts', 'upgrade', snapshot, nextData],
    checkout,
    env,
  );
  assert.equal(sha(join(data, 'control.sqlite')), oldHash);
  data = nextData;
  production.OPENCONTEXT_DATA_ROOT = data;
  const upgraded = await launch();
  const headers = { authorization: 'Bearer ' + owner };
  const projects = (await (
    await fetch(upgraded + '/api/projects', { headers })
  ).json()) as { id: string; head: string }[];
  assert.equal(projects[0]!.id, projectId);
  assert.equal(projects[0]!.head, head);
  const query = successful(
    process.execPath,
    ['scripts/opencontext.ts', 'read', projectId!, fileId!, revisionId!],
    checkout,
    { ...env, OPENCONTEXT_URL: upgraded, OPENCONTEXT_QUERY_TOKEN: owner },
  );
  assert.deepEqual(JSON.parse(query.out), original);
  assert.equal(
    (await fetch(upgraded + '/api/readiness', { headers })).status,
    200,
  );
  await stop();
  const unknown = new DatabaseSync(join(data, 'control.sqlite'));
  unknown
    .prepare("UPDATE catalog_meta SET value='99' WHERE key='storage_version'")
    .run();
  unknown.close();
  const before = sha(join(data, 'control.sqlite'));
  const rejected = run('pnpm', ['preflight'], checkout, production);
  assert.equal(rejected.status, 1);
  assert.equal(report(rejected.out).ready, false);
  assert.equal(sha(join(data, 'control.sqlite')), before);
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        elapsedMs: Date.now() - startedAt,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        freshSourceFiles: list.length,
        frozenLockSha256: lockBefore,
        noBorrowedDependencies: true,
        installScriptsDisabled: true,
        privateStartupHTTP: true,
        missingCredential401: true,
        knownLegacyPreflight: true,
        upgradePreservesHeadAndFixedRead: true,
        unknownSchemaRejectedWithoutControlDbChange: true,
        originalDeploymentUntouched: true,
        scope:
          'one synthetic published Git file; single local writer; no TLS/live integrations',
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
