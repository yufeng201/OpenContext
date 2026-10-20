/** Disposable full-browser acceptance: real loopback server, synthetic sources, no user credentials. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createApplication } from '../apps/server/src/app.ts';
import { feishuApiFixture } from '../tests/fixtures/feishu-api.ts';

const cwd = resolve(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'oc-browser-acceptance-'));
const repo = join(root, 'repo');
let application: ReturnType<typeof createApplication> | undefined;
let child: ChildProcess | undefined;
let interrupted = false;
let killDeadline: ReturnType<typeof setTimeout> | undefined;
const terminate = (signal: NodeJS.Signals) => {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    } else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};
const stop = () => {
  interrupted = true;
  terminate('SIGTERM');
  killDeadline ??= setTimeout(() => terminate('SIGKILL'), 10000);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  mkdirSync(join(repo, 'docs/architecture'), { recursive: true });
  writeFileSync(
    join(repo, 'README.md'),
    '# Synthetic browser fixture\nbrowser-needle\n',
  );
  writeFileSync(join(repo, 'asset.bin'), Buffer.from([0, 1, 2, 0, 255]));
  writeFileSync(join(repo, 'docs/guide.md'), '# Guide\nSynthetic guide.\n');
  writeFileSync(
    join(repo, 'docs/architecture/decision.md'),
    '# Decision\nreverify-multilevel-needle\n',
  );
  writeFileSync(
    join(repo, 'docs/large.md'),
    '# Large\n## Start\n' +
      ('synthetic-budget-line '.repeat(7) + '\n').repeat(180) +
      '## End\nbudget-tail-needle\n',
  );
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=synthetic@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd: repo,
        timeout: 10000,
        stdio: 'ignore',
        env: {
          PATH: process.env['PATH'] ?? '',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    );
  git('init', '-b', 'main');
  git('add', '.');
  git('commit', '-m', 'Synthetic browser acceptance');
  const token = 'synthetic-browser-acceptance-loopback-only';
  application = createApplication({
    dataRoot: join(root, 'data'),
    ownerToken: token,
    feishu: feishuApiFixture(),
    allowedLocalRepoRoot: root,
  });
  const origin = await application.app.listen({ host: '127.0.0.1', port: 0 });
  if (interrupted) throw new Error('CANCELLED');
  console.log(
    'Synthetic browser acceptance: ' +
      origin +
      '; no real Feishu or model calls.',
  );
  child = spawn('pnpm', ['--filter', '@opencontext/web', 'test:browser'], {
    cwd,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
    env: {
      PATH: process.env['PATH'] ?? '',
      OPENCONTEXT_E2E_URL: origin,
      OPENCONTEXT_E2E_OWNER_TOKEN: token,
      OPENCONTEXT_E2E_REPO_URL: repo,
      ...(process.env['OPENCONTEXT_BROWSER_BINARY']
        ? {
            OPENCONTEXT_BROWSER_BINARY:
              process.env['OPENCONTEXT_BROWSER_BINARY'],
          }
        : {}),
      ...(process.env['OPENCONTEXT_UI_EVIDENCE']
        ? { OPENCONTEXT_UI_EVIDENCE: process.env['OPENCONTEXT_UI_EVIDENCE'] }
        : {}),
    },
  });
  const deadline = setTimeout(stop, 300000);
  try {
    const [code] = await once(child, 'exit');
    process.exitCode = interrupted ? 1 : (code ?? 1);
  } finally {
    clearTimeout(deadline);
    clearTimeout(killDeadline);
  }
} finally {
  if (
    interrupted ||
    (child && child.exitCode === null && child.signalCode === null)
  )
    terminate('SIGKILL');
  clearTimeout(killDeadline);
  await application?.app.close();
  rmSync(root, { recursive: true, force: true });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
