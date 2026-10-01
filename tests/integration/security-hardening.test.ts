import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { OpenContextClient } from '../../packages/http-client/src/index.ts';
import type { ApplicationOptions } from '../../apps/server/src/app.ts';
import { Type } from '@sinclair/typebox';
import { createApplication } from '../../apps/server/src/app.ts';
import { StaticRegistry } from '../../packages/plugin-host/src/index.ts';
import { markdownDefinition } from '../../plugins/markdown-processor/src/index.ts';
import type { ConnectorDefinition } from '../../packages/plugin-sdk/src/index.ts';
const owner = 'synthetic-security-owner-000000000000000';
const headers = { authorization: 'Bearer ' + owner };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function fixture(options: Partial<ApplicationOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oc-security-')),
    data = join(root, 'data'),
    webRoot = join(root, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<html>synthetic app</html>');
  let fault = false,
    version = 1,
    blocking = false;
  const definition: ConnectorDefinition = {
    manifest: {
      id: 'fixture.security',
      version: '1.0.0',
      protocolVersion: '1',
      capabilities: ['connector'],
      location: 'server',
      trust: 'official-trusted-native',
    },
    capability: 'connector',
    artifactPaths: [import.meta.url],
    title: 'Security fixture',
    description: 'No external service',
    configSchema: Type.Object({}, { additionalProperties: false }),
    fields: [],
    acceptsImports: false,
    probe: () => ({
      available: true,
      capabilities: ['connector'],
      limitations: [],
    }),
    async testConnection(_config, { signal }) {
      if (blocking)
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('CANCELLED')),
            { once: true },
          ),
        );
      return {
        status: 'reachable',
        evidence: 'simulated',
        code: fault
          ? 'PRIVATE_CREDENTIAL_SHOULD_NEVER_BE_A_CODE'
          : 'CHAT_READABLE',
      };
    },
    async invoke() {
      if (fault) throw new Error('PRIVATE_CREDENTIAL_SHOULD_NEVER_BE_A_CODE');
      return {
        sourceVersion: 'fixture-' + version,
        complete: true,
        files: Array.from({ length: 50 }, (_, i) => ({
          relativePath: 'file-' + i + '.md',
          content: 'security-needle ' + version + ' ' + i,
          mime: 'text/markdown' as const,
        })),
        renames: [],
        skipped: [],
      };
    },
  };
  const registry = new StaticRegistry([definition, markdownDefinition]);
  const app = createApplication({
    dataRoot: data,
    webRoot,
    ownerToken: owner,
    autoStart: false,
    registry,
    ...options,
  });
  cleanups.push(async () => {
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function setup() {
    const project = app.catalog.createProject('Security space');
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/projects/' + project.id + '/bindings',
      headers,
      payload: {
        name: 'Security fixture',
        connector: { packageRef: 'fixture.security@1.0.0', config: {} },
        processor: { packageRef: 'org.opencontext.markdown@0.1.0', config: {} },
      },
    });
    expect(response.statusCode).toBe(200);
    return { project, binding: response.json() };
  }
  async function sync(bindingId: string) {
    const run = app.catalog.enqueue(bindingId, 'sync');
    await app.coordinator.drain();
    return app.catalog.getRun(run.id)!;
  }
  async function mcp(args: Record<string, unknown>, token: string) {
    return app.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'context_read', arguments: args },
      },
    });
  }
  return {
    root,
    data,
    webRoot,
    app,
    registry,
    definition,
    setup,
    sync,
    mcp,
    setFault() {
      fault = true;
    },
    update() {
      version++;
    },
    block() {
      blocking = true;
    },
    unblock() {
      blocking = false;
    },
  };
}
it('unauthenticated static serving refuses file and directory symlinks out of the build root', async () => {
  const f = fixture(),
    privateFile = join(f.root, 'private-secret.txt');
  writeFileSync(privateFile, 'PRIVATE_STATIC_SECRET');
  symlinkSync(privateFile, join(f.webRoot, 'leak.js'));
  symlinkSync(f.root, join(f.webRoot, 'linked'));
  for (const path of ['/leak.js', '/linked/private-secret.txt']) {
    const response = await f.app.app.inject({ url: path });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('PRIVATE_STATIC_SECRET');
  }
  expect((await f.app.app.inject({ url: '/' })).statusCode).toBe(200);
});
it('MCP file faults have the same redaction boundary as REST and never expose local paths', async () => {
  const f = fixture(),
    { project, binding } = await f.setup();
  await f.sync(binding.id);
  const file = f.app.catalog.currentFiles(project.id)[0]!;
  const reader = f.app.catalog.createReaderToken(project.id);
  rmSync(
    join(
      f.data,
      'content',
      'blobs',
      file.contentHash.slice(0, 2),
      file.contentHash,
    ),
  );
  const args = {
    projectId: project.id,
    fileId: file.fileId,
    revisionId: file.revisionId,
  };
  const mcp = await f.mcp(args, reader.token);
  expect(mcp.body).not.toContain(f.data);
  expect(mcp.body).not.toContain('ENOENT');
  expect(mcp.json().error.message).toBe('INTERNAL_ERROR');
  const rest = await f.app.app.inject({
    url:
      '/api/projects/' +
      project.id +
      '/read?' +
      new URLSearchParams({ fileId: file.fileId, revisionId: file.revisionId }),
    headers: { authorization: 'Bearer ' + reader.token },
  });
  expect(rest.statusCode).toBe(500);
  expect(rest.body).not.toContain(f.data);
});
it('uppercase native-plugin diagnostics never become persisted or client-visible credentials', async () => {
  const f = fixture(),
    { project, binding } = await f.setup();
  f.setFault();
  const run = await f.sync(binding.id);
  expect(run.state).toBe('failed');
  expect(run.error).toBe('PROCESSING_FAILED');
  const response = await f.app.app.inject({
    url: '/api/projects/' + project.id + '/runs',
    headers,
  });
  expect(response.body).not.toContain(
    'PRIVATE_CREDENTIAL_SHOULD_NEVER_BE_A_CODE',
  );
  expect(JSON.stringify(f.app.catalog.getBinding(binding.id))).not.toContain(
    'PRIVATE_CREDENTIAL_SHOULD_NEVER_BE_A_CODE',
  );
  f.app.catalog.db
    .prepare('UPDATE runs SET error = ? WHERE id = ?')
    .run('PRIVATE_HISTORICAL_SECRET', run.id);
  f.app.catalog.db
    .prepare('UPDATE bindings SET last_error = ? WHERE id = ?')
    .run('PRIVATE_HISTORICAL_SECRET', binding.id);
  const reader = f.app.catalog.createReaderToken(project.id);
  for (const route of ['runs', 'bindings']) {
    const historical = await f.app.app.inject({
      url: '/api/projects/' + project.id + '/' + route,
      headers: { authorization: 'Bearer ' + reader.token },
    });
    expect(historical.statusCode).toBe(200);
    expect(historical.body).not.toContain('PRIVATE_HISTORICAL_SECRET');
  }
});

it('SDK rejects invalid JSON, credential-looking error codes and oversized bodies without echoing content', async () => {
  const make = (response: Response) =>
    new OpenContextClient({
      baseUrl: 'http://localhost:4310',
      token: 'synthetic',
      fetch: async () => response,
    });
  await expect(
    make(new Response('PRIVATE_JSON_SECRET')).projects(),
  ).rejects.toMatchObject({
    message: 'INVALID_RESPONSE',
    code: 'INVALID_RESPONSE',
  });
  await expect(
    make(
      Response.json(
        { error: { code: 'PRIVATE_CREDENTIAL_SHOULD_NEVER_BE_A_CODE' } },
        { status: 403 },
      ),
    ).projects(),
  ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  await expect(
    make(
      new Response('x', { headers: { 'content-length': '16777217' } }),
    ).projects(),
  ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  const chunk = new Uint8Array(8_388_609);
  let n = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (n++ < 2) controller.enqueue(chunk);
      else controller.close();
    },
  });
  await expect(make(new Response(stream)).projects()).rejects.toMatchObject({
    code: 'RESPONSE_TOO_LARGE',
  });
});
it('SDK timeout cancels an actual loopback request and gives a stable error', async () => {
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('INVALID_ADDRESS');
    const client = new OpenContextClient({
      baseUrl: 'http://127.0.0.1:' + addr.port,
      token: 'synthetic',
      timeoutMs: 50,
    });
    await expect(client.projects()).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 0,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
it('connection probes admit four operations, reject excess and actually cancel at the server deadline', async () => {
  const f = fixture({ connectionTestTimeoutMs: 100 }),
    { project, binding } = await f.setup();
  f.block();
  const url =
    '/api/projects/' +
    project.id +
    '/bindings/' +
    binding.id +
    '/test-connection';
  const pending = Array.from({ length: 4 }, () =>
    f.app.app.inject({ method: 'POST', url, headers }),
  );
  await new Promise((done) => setTimeout(done, 20));
  const excess = await f.app.app.inject({ method: 'POST', url, headers });
  expect(excess.statusCode).toBe(429);
  expect(excess.json().error.code).toBe('RESOURCE_BUSY');
  for (const response of await Promise.all(pending)) {
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('CONNECTION_TEST_TIMEOUT');
  }
  f.unblock();
  expect(
    (await f.app.app.inject({ method: 'POST', url, headers })).statusCode,
  ).toBe(200);
});
it('credential-looking connection-result codes cannot pass the plugin response gate', async () => {
  const f = fixture(),
    { project, binding } = await f.setup();
  f.setFault();
  const response = await f.app.app.inject({
    method: 'POST',
    url:
      '/api/projects/' +
      project.id +
      '/bindings/' +
      binding.id +
      '/test-connection',
    headers,
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe('INVALID_PLUGIN_OUTPUT');
  expect(response.body).not.toContain(
    'PRIVATE_CREDENTIAL_SHOULD_NEVER_BE_A_CODE',
  );
});
it('task admission bounds the durable queue at100 without breaking duplicate idempotence', async () => {
  const f = fixture(),
    { project, binding } = await f.setup();
  const first = f.app.catalog.enqueue(binding.id, 'sync');
  for (let i = 1; i < 100; i++) {
    const b = f.app.catalog.createBinding(project.id, {
      name: 'Synthetic ' + i,
      connector: f.registry.prepareSync(
        { packageRef: 'fixture.security@1.0.0', config: {} },
        'connector',
      ),
      processor: f.registry.prepareSync(
        { packageRef: 'org.opencontext.markdown@0.1.0', config: {} },
        'processor',
      ),
    });
    f.app.catalog.enqueue(b.id, 'sync');
  }
  expect(f.app.catalog.enqueue(binding.id, 'sync').id).toBe(first.id);
  const extra = f.app.catalog.createBinding(project.id, {
    name: 'Extra',
    connector: f.registry.prepareSync(
      { packageRef: 'fixture.security@1.0.0', config: {} },
      'connector',
    ),
    processor: f.registry.prepareSync(
      { packageRef: 'org.opencontext.markdown@0.1.0', config: {} },
      'processor',
    ),
  });
  const response = await f.app.app.inject({
    method: 'POST',
    url: '/api/projects/' + project.id + '/bindings/' + extra.id + '/sync',
    headers,
  });
  expect(response.statusCode).toBe(429);
  expect(response.json().error.code).toBe('QUEUE_FULL');
  expect(f.app.catalog.listRuns(project.id)).toHaveLength(100);
});
it('REST SDK CLI and MCP preserve project/source/revision gates across50-file snapshots and revocation', async () => {
  const f = fixture(),
    { project, binding } = await f.setup();
  await f.sync(binding.id);
  const before = f.app.catalog.currentFiles(project.id);
  expect(before).toHaveLength(50);
  const file = before[0]!;
  const other = f.app.catalog.createProject('Other space'),
    reader = f.app.catalog.createReaderToken(project.id),
    rh = { authorization: 'Bearer ' + reader.token };
  const baseUrl = await f.app.app.listen({ host: '127.0.0.1', port: 0 });
  const client = new OpenContextClient({ baseUrl, token: reader.token });
  const cli = (...args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          ['scripts/opencontext.ts', ...args],
          {
            env: {
              PATH: process.env['PATH'],
              OPENCONTEXT_URL: baseUrl,
              OPENCONTEXT_QUERY_TOKEN: reader.token,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '',
          err = '';
        child.stdout.on('data', (c) => (out += String(c)));
        child.stderr.on('data', (c) => (err += String(c)));
        child.on('error', reject);
        child.on('close', (code) => done({ code, out, err }));
      },
    );
  expect((await client.projects()).map((p) => p.id)).toEqual([project.id]);
  for (const method of [
    () => client.tree(other.id),
    () => client.search(other.id, { query: 'security-needle' }),
    () => client.read(other.id, file.fileId, file.revisionId),
  ])
    await expect(method()).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  const wrong = await f.mcp(
    { projectId: other.id, fileId: file.fileId, revisionId: file.revisionId },
    reader.token,
  );
  expect(wrong.json().error.message).toBe('FORBIDDEN');
  expect(wrong.body).not.toContain('security-needle');
  const wrongCLI = await cli('tree', other.id);
  expect(wrongCLI.code).toBe(1);
  expect(JSON.parse(wrongCLI.err).error).toBe('FORBIDDEN');
  const base = '/api/projects/' + project.id;
  const mutations: [string, string, unknown?][] = [
    ['POST', '/api/projects', { name: 'Denied' }],
    ['POST', base + '/tokens'],
    ['DELETE', '/api/tokens/' + reader.id],
    [
      'POST',
      base + '/bindings',
      { name: 'Denied', repoUrl: 'https://example.invalid/repo' },
    ],
    ['DELETE', base + '/bindings/' + binding.id],
    ['POST', base + '/bindings/' + binding.id + '/sync'],
    ['POST', base + '/bindings/' + binding.id + '/process'],
    ['POST', base + '/bindings/' + binding.id + '/test-connection'],
    ['GET', base + '/bindings/' + binding.id + '/imports'],
    [
      'POST',
      base + '/bindings/' + binding.id + '/imports',
      { filename: 'test.json', content: '{}' },
    ],
    ['DELETE', base + '/bindings/' + binding.id + '/imports/unknown'],
    ['GET', '/api/plugins'],
    ['GET', '/api/readiness'],
  ];
  for (const [method, url, payload] of mutations) {
    const response = await f.app.app.inject({
      method: method as 'GET' | 'POST' | 'DELETE',
      url,
      headers: rh,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode, url).toBe(403);
  }
  const fixed = await client.read(project.id, file.fileId, file.revisionId);
  f.update();
  await f.sync(binding.id);
  expect(f.app.catalog.currentFiles(project.id)[0]!.revisionId).not.toBe(
    file.revisionId,
  );
  expect(
    (await client.read(project.id, file.fileId, file.revisionId)).text,
  ).toBe(fixed.text);
  expect(
    (
      await f.mcp(
        {
          projectId: project.id,
          fileId: file.fileId,
          revisionId: file.revisionId,
        },
        reader.token,
      )
    ).json().result.structuredContent.text,
  ).toBe(fixed.text);
  await expect(
    client.read(project.id, file.fileId, 'missing-revision'),
  ).rejects.toMatchObject({ status: 404 });
  f.app.catalog.revokeBinding(binding.id);
  expect(await client.tree(project.id)).toEqual([]);
  expect(
    (
      await client.search(project.id, {
        query: 'security-needle',
        freshness: 'include_stale',
      })
    ).hits,
  ).toEqual([]);
  await expect(
    client.read(project.id, file.fileId, file.revisionId),
  ).rejects.toMatchObject({ status: 404 });
  const revoked = await f.mcp(
    { projectId: project.id, fileId: file.fileId, revisionId: file.revisionId },
    reader.token,
  );
  expect(revoked.json().error.message).toBe('NOT_FOUND');
  expect(revoked.body).not.toContain('security-needle');
  const revokedCLI = await cli(
    'read',
    project.id,
    file.fileId,
    file.revisionId,
  );
  expect(revokedCLI.code).toBe(1);
  expect(JSON.parse(revokedCLI.err).error).toBe('NOT_FOUND');
  expect(revokedCLI.out + revokedCLI.err).not.toContain(reader.token);
  f.app.catalog.revokeToken(reader.id);
  await expect(client.projects()).rejects.toMatchObject({ status: 401 });
  expect(
    (
      await f.mcp(
        {
          projectId: project.id,
          fileId: file.fileId,
          revisionId: file.revisionId,
        },
        reader.token,
      )
    ).statusCode,
  ).toBe(401);
});
it('large inputs and oversized static files fail closed, and Host authority rejects userinfo syntax', async () => {
  const f = fixture();
  writeFileSync(join(f.webRoot, 'large.js'), '');
  const fs = await import('node:fs');
  fs.truncateSync(join(f.webRoot, 'large.js'), 8_388_609);
  expect((await f.app.app.inject({ url: '/large.js' })).statusCode).toBe(404);
  expect(
    (
      await f.app.app.inject({
        url: '/api/health',
        headers: { host: 'evil@localhost' },
      })
    ).statusCode,
  ).toBe(403);
  const payload = await f.app.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'x'.repeat(70000) }),
  });
  expect(payload.statusCode).toBe(413);
  expect(payload.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  const mcp = await f.app.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...headers, accept: 'application/json, text/event-stream' },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'context_search',
        arguments: { projectId: 'x', query: 'x'.repeat(301) },
      },
    },
  });
  expect(mcp.json().error.message).toContain('Invalid search arguments');
});

it('private TLS proxy origin is explicit, cookies are Secure and forwarded headers cannot authorize another origin', async () => {
  const f = fixture({ publicOrigin: 'https://context.example.invalid' });
  const login = await f.app.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: {
      host: 'context.example.invalid',
      origin: 'https://context.example.invalid',
    },
    payload: { token: owner },
  });
  expect(login.statusCode).toBe(200);
  expect(login.headers['set-cookie']).toContain('; Secure');
  expect(
    (
      await f.app.app.inject({
        url: '/api/health',
        headers: {
          host: 'context.example.invalid',
          origin: 'http://context.example.invalid',
        },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.app.inject({
        url: '/api/health',
        headers: {
          host: 'evil.example.invalid',
          'x-forwarded-host': 'context.example.invalid',
          'x-forwarded-proto': 'https',
        },
      })
    ).statusCode,
  ).toBe(403);
});
it('private root permissions and ambiguous owner credentials fail before data creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-root-perms-'));
  const fs = await import('node:fs');
  fs.chmodSync(root, 0o755);
  try {
    expect(() =>
      createApplication({ dataRoot: root, ownerToken: owner }),
    ).toThrow('ROOT_PERMISSIONS_UNSAFE');
    expect(fs.existsSync(join(root, 'control.sqlite'))).toBe(false);
    expect(() =>
      createApplication({
        dataRoot: join(root, 'new'),
        ownerToken: ' '.repeat(32),
      }),
    ).toThrow('INVALID_OWNER_TOKEN');
    expect(fs.existsSync(join(root, 'new'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
