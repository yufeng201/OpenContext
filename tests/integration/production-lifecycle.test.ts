import { it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  chmodSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerToken, runtimeConfig } from '../../apps/server/src/deployment.ts';
import { DatabaseSync } from 'node:sqlite';
const token = 'synthetic-production-owner-000000000000000';
const roots: string[] = [],
  children: ChildProcess[] = [];
function root() {
  const r = mkdtempSync(join(tmpdir(), 'oc-production-test-'));
  roots.push(r);
  return r;
}
afterEach(async () => {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) {
      const closed = once(c, 'close');
      c.kill('SIGKILL');
      await closed;
    }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function child(
  dir: string,
  extra: NodeJS.ProcessEnv = {},
  fixture = false,
  heap?: number,
) {
  const c = spawn(
    process.execPath,
    [
      ...(heap ? [`--max-old-space-size=${heap}`] : []),
      fixture
        ? 'tests/fixtures/production-child.ts'
        : 'apps/server/src/main.ts',
    ],
    {
      env: {
        PATH: process.env['PATH'],
        NODE_ENV: 'production',
        PORT: '0',
        OPENCONTEXT_DATA_ROOT: join(dir, 'data'),
        OPENCONTEXT_OWNER_TOKEN: token,
        FIXTURE_BLOCK: join(dir, 'block'),
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(c);
  let output = '',
    error = '';
  c.stdout!.on('data', (p) => {
    output += String(p);
  });
  c.stderr!.on('data', (p) => {
    error += String(p);
  });
  const closed = once(c, 'close');
  return {
    c,
    closed,
    get output() {
      return output;
    },
    get error() {
      return error;
    },
  };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error('FIXTURE_TIMEOUT');
}
async function address(p: ReturnType<typeof child>) {
  await until(() => /slice: http/.test(p.output) || p.c.exitCode !== null);
  expect(p.c.exitCode, p.error).toBe(null);
  return /slice: (http:\/\/127.0.0.1:\d+)/.exec(p.output)![1]!;
}
async function stop(p: ReturnType<typeof child>, signal: NodeJS.Signals) {
  p.c.kill(signal);
  const [code, received] = await p.closed;
  return { code, received };
}
const headers = {
  authorization: 'Bearer ' + token,
  'content-type': 'application/json',
};
it('accepts only explicitly named private owner files and gated ingress', () => {
  const r = root(),
    f = join(r, 'owner');
  writeFileSync(f, token + '\n', { mode: 0o600 });
  expect(ownerToken({ OPENCONTEXT_OWNER_TOKEN_FILE: f })).toBe(token);
  expect(() =>
    ownerToken({
      OPENCONTEXT_OWNER_TOKEN_FILE: f,
      OPENCONTEXT_OWNER_TOKEN: token,
    }),
  ).toThrow('CONFIGURATION_CONFLICT');
  chmodSync(f, 0o644);
  expect(() => ownerToken({ OPENCONTEXT_OWNER_TOKEN_FILE: f })).toThrow(
    'INVALID_SECRET_FILE',
  );
  chmodSync(f, 0o600);
  symlinkSync(f, join(r, 'link'));
  expect(() =>
    ownerToken({ OPENCONTEXT_OWNER_TOKEN_FILE: join(r, 'link') }),
  ).toThrow();
  expect(() => runtimeConfig({ OPENCONTEXT_BIND_HOST: '0.0.0.0' })).toThrow(
    'PUBLIC_ORIGIN_REQUIRED',
  );
  expect(
    runtimeConfig({
      OPENCONTEXT_BIND_HOST: '0.0.0.0',
      OPENCONTEXT_PUBLIC_ORIGIN: 'https://context.example.invalid',
    }).host,
  ).toBe('0.0.0.0');
  expect(() => runtimeConfig({ OPENCONTEXT_SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(
    'INVALID_SHUTDOWN_TIMEOUT',
  );
});
it.each(['SIGINT', 'SIGTERM'] as const)(
  'drains an accepted HTTP request and exits cleanly on %s',
  async (signal) => {
    const p = child(root(), {}, true),
      url = await address(p);
    const response = fetch(url + '/fixture/drain');
    await until(() => p.output.includes('fixture_request_entered'));
    const stopping = stop(p, signal);
    expect(await (await response).json()).toEqual({ drained: true });
    expect(await stopping).toEqual({ code: 0, received: null });
    expect(p.output).toContain('shutdown_complete');
    expect(p.output + p.error).not.toContain(token);
  },
);
it('bounded drain deadline terminates only its own wedged child with stable diagnostics', async () => {
  const p = child(
      root(),
      { FIXTURE_REQUEST_MS: '10000', OPENCONTEXT_SHUTDOWN_TIMEOUT_MS: '150' },
      true,
    ),
    url = await address(p);
  const response = fetch(url + '/fixture/drain').catch(() => null);
  await until(() => p.output.includes('fixture_request_entered'));
  expect(await stop(p, 'SIGTERM')).toEqual({ code: 1, received: null });
  await response;
  expect(p.error).toContain('SHUTDOWN_TIMEOUT');
  expect(p.output).not.toContain('shutdown_complete');
});
it('actual low heap and disk admission fail before creating data, without secret output', async () => {
  for (const mode of ['heap', 'disk']) {
    const r = root(),
      p = child(
        r,
        mode === 'disk'
          ? { OPENCONTEXT_MIN_FREE_BYTES: '999999999999999' }
          : {},
        false,
        mode === 'heap' ? 32 : undefined,
      );
    const [code] = await p.closed;
    expect(code).toBe(1);
    expect(existsSync(join(r, 'data'))).toBe(false);
    expect(p.error).toContain(
      mode === 'heap' ? 'RESOURCE_BUDGET_TOO_LOW' : 'DISK_BUDGET_TOO_LOW',
    );
    expect(p.output + p.error).not.toContain(token);
  }
});
it('rejects an occupied port and a second writer while the first remains healthy', async () => {
  const r = root(),
    first = child(r),
    url = await address(first);
  const writer = child(r);
  expect((await writer.closed)[0]).toBe(1);
  expect(writer.error).toContain('CATALOG_IN_USE');
  const other = root(),
    occupied = child(other, { PORT: new URL(url).port });
  expect((await occupied.closed)[0]).toBe(1);
  expect(occupied.output + occupied.error).not.toContain(token);
  expect((await fetch(url + '/api/health')).status).toBe(200);
  await stop(first, 'SIGTERM');
  const retry = child(other);
  expect((await fetch((await address(retry)) + '/api/health')).status).toBe(
    200,
  );
  await stop(retry, 'SIGTERM');
});
it('SIGKILL preserves committed refs and restart fences/retries a running synthetic task exactly once', async () => {
  const r = root(),
    p = child(r, {}, true),
    url = await address(p);
  async function post(path: string, body: unknown) {
    const response = await fetch(url + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json();
  }
  const project = await post('/api/projects', {
    name: 'Synthetic production recovery',
  });
  const base = '/api/projects/' + project.id;
  const binding = await post(base + '/bindings', {
    name: 'Synthetic',
    connector: {
      packageRef: 'org.opencontext.codex-sessions@0.1.0',
      config: { projectScope: 'synthetic-project' },
    },
    processor: {
      packageRef: 'org.opencontext.session-candidates@0.1.0',
      config: {},
    },
  });
  const bindingPath = base + '/bindings/' + binding.id;
  const content = readFileSync(
    'plugins/session-connector/fixtures/codex-session.json',
    'utf8',
  );
  await post(bindingPath + '/imports', { filename: 'synthetic.json', content });
  const run = await post(bindingPath + '/sync', {});
  await until(
    () => p.output.length > 0 && existsSync(join(r, 'block.entered')),
  );
  let published = false;
  for (let n = 0; n < 200; n++) {
    const runs = await (await fetch(url + base + '/runs', { headers })).json();
    if (
      runs.find((x: { id: string; state: string }) => x.id === run.id)
        ?.state === 'published'
    ) {
      published = true;
      break;
    }
    await delay(10);
  }
  expect(published).toBe(true);
  const before = await (await fetch(url + base + '/files', { headers })).json();
  expect(before.files.length).toBeGreaterThan(0);
  writeFileSync(join(r, 'block'), 'synthetic');
  rmSync(join(r, 'block.entered'));
  const pending = await post(bindingPath + '/sync', {});
  await until(() => existsSync(join(r, 'block.entered')));
  expect(await stop(p, 'SIGKILL')).toEqual({ code: null, received: 'SIGKILL' });
  const db = new DatabaseSync(join(r, 'data/control.sqlite'), {
    readOnly: true,
  });
  const old = db
    .prepare('SELECT fence,incarnation,state FROM runs WHERE id=?')
    .get(pending.id)!;
  expect(old.state).toBe('running');
  db.close();
  rmSync(join(r, 'block'));
  const restart = child(r, {}, true),
    next = await address(restart);
  let recovered = false;
  for (let n = 0; n < 200; n++) {
    const runs = await (await fetch(next + base + '/runs', { headers })).json();
    if (
      runs.find((x: { id: string; state: string }) => x.id === pending.id)
        ?.state === 'published'
    ) {
      recovered = true;
      break;
    }
    await delay(10);
  }
  expect(recovered).toBe(true);
  expect(
    await (await fetch(next + base + '/files', { headers })).json(),
  ).toEqual(before);
  await stop(restart, 'SIGTERM');
  const state = new DatabaseSync(join(r, 'data/control.sqlite'), {
    readOnly: true,
  });
  const current = state
    .prepare('SELECT fence,incarnation,state FROM runs WHERE id=?')
    .get(pending.id)!;
  expect(BigInt(current.fence as string)).toBeGreaterThan(
    BigInt(old.fence as string),
  );
  expect(current.incarnation).not.toBe(old.incarnation);
  expect(
    state
      .prepare('SELECT count(*) AS n FROM commits WHERE run_id=?')
      .get(pending.id)!.n,
  ).toBe(0);
  state.close();
}, 15000);

it('shutdown failure exits and projects only its stable code', async () => {
  const p = child(root(), { FIXTURE_CLOSE_FAIL: '1' }, true);
  await address(p);
  expect(await stop(p, 'SIGTERM')).toEqual({ code: 1, received: null });
  expect(p.error).toContain('SHUTDOWN_FAILED');
  expect(p.output + p.error).not.toContain(
    'synthetic-private-close-diagnostic',
  );
  expect(p.output + p.error).not.toContain(token);
});
