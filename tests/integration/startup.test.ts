import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../../apps/server/src/app.ts';

const entry = fileURLToPath(
  new URL('../../apps/server/src/main.ts', import.meta.url),
);
const owner = 'synthetic-startup-owner-token-000000000';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function tempRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-startup-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function launch(
  root: string,
  demo: boolean,
  environment: Record<string, string> = {},
) {
  const child = spawn(process.execPath, [entry, ...(demo ? ['--demo'] : [])], {
    cwd: root,
    env: { PATH: process.env['PATH'], PORT: '0', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  const started = new Promise<'listening' | number | null>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Startup timed out: ' + output)),
        8_000,
      );
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('OpenContext local development slice:')) {
          clearTimeout(timer);
          resolve('listening');
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    },
  );
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await closed;
  };
  cleanups.push(stop);
  return {
    started,
    stop,
    get output() {
      return output;
    },
  };
}

it('isolates default demo data and refuses a private directory in demo mode', async () => {
  const root = tempRoot();
  const privateApp = launch(root, false, { OPENCONTEXT_OWNER_TOKEN: owner });
  expect(await privateApp.started).toBe('listening');
  expect(existsSync(resolve(root, 'runtime/control.sqlite'))).toBe(true);
  await privateApp.stop();
  const demoApp = launch(root, true);
  expect(await demoApp.started).toBe('listening');
  expect(existsSync(resolve(root, 'runtime-demo/control.sqlite'))).toBe(true);
  await demoApp.stop();
  const mismatch = launch(root, true, {
    OPENCONTEXT_DATA_ROOT: resolve(root, 'runtime'),
  });
  expect(await mismatch.started).toBe(1);
  expect(mismatch.output).toContain('DATA_MODE_MISMATCH');
  const reopened = launch(root, false, { OPENCONTEXT_OWNER_TOKEN: owner });
  expect(await reopened.started).toBe('listening');
});

it('rejects ambiguous demo plus private owner configuration before creating data', async () => {
  const root = tempRoot();
  const app = launch(root, true, { OPENCONTEXT_OWNER_TOKEN: owner });
  expect(await app.started).toBe(1);
  expect(app.output).toContain('DEMO_OWNER_TOKEN_CONFLICT');
  expect(existsSync(resolve(root, 'runtime'))).toBe(false);
  expect(existsSync(resolve(root, 'runtime-demo'))).toBe(false);
});

it('does not expose a server Feishu credential through the publicly known demo owner', async () => {
  const root = tempRoot();
  const app = launch(root, true, {
    OPENCONTEXT_FEISHU_TOKEN: 'synthetic-credential-not-used',
  });
  expect(await app.started).toBe(1);
  expect(app.output).toContain('DEMO_FEISHU_CREDENTIAL_CONFLICT');
  expect(app.output).not.toContain('synthetic-credential-not-used');
  expect(existsSync(resolve(root, 'runtime-demo'))).toBe(false);
});

it('rejects owner tokens that the Web login contract cannot accept', async () => {
  const root = tempRoot();
  const app = launch(root, false, { OPENCONTEXT_OWNER_TOKEN: 'x'.repeat(257) });
  expect(await app.started).toBe(1);
  expect(app.output).toContain('OWNER_TOKEN_TOO_LONG');
  expect(existsSync(resolve(root, 'runtime'))).toBe(false);
});

it('a rejected duplicate application leaves the live owner able to write', async () => {
  const root = tempRoot();
  const app = createApplication({
    dataRoot: root,
    ownerToken: owner,
    autoStart: false,
  });
  cleanups.push(() => app.app.close());
  const address = await app.app.listen({ host: '127.0.0.1', port: 0 });
  expect(() =>
    createApplication({ dataRoot: root, ownerToken: owner }),
  ).toThrow('CATALOG_IN_USE');
  const response = await fetch(address + '/api/projects', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + owner,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Still writable' }),
  });
  expect(response.status).toBe(200);
});

it('accepts the maximum owner length through the same Web login boundary', async () => {
  const app = createApplication({
    dataRoot: tempRoot(),
    ownerToken: 'x'.repeat(256),
    autoStart: false,
  });
  cleanups.push(() => app.app.close());
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { token: 'x'.repeat(256) },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['set-cookie']).toBeDefined();
});

it('invalid port and credential-bearing proxy origin fail without creating private data or echoing configuration', async () => {
  for (const configuration of [
    { PORT: 'not-a-port' },
    {
      NODE_ENV: 'production',
      OPENCONTEXT_TEST_REPO_ROOT: '/synthetic-only-test-root',
    },
    {
      OPENCONTEXT_PUBLIC_ORIGIN:
        'https://user:PRIVATE_ORIGIN_SECRET@context.example.invalid',
    },
  ]) {
    const root = tempRoot();
    const app = launch(root, false, {
      OPENCONTEXT_OWNER_TOKEN: owner,
      ...configuration,
    });
    expect(await app.started).toBe(1);
    expect(app.output).not.toContain(root);
    expect(app.output).not.toContain('PRIVATE_ORIGIN_SECRET');
    expect(existsSync(resolve(root, 'runtime'))).toBe(false);
  }
});
