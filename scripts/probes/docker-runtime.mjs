// Run only via docker-acceptance.py, streamed to stdin inside the isolated container.
import process from 'node:process';
import console from 'node:console';
import { URL, URLSearchParams } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getCACertificates } from 'node:tls';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from './packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from './packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const base = 'http://127.0.0.1:4310';
const owner = readFileSync('/run/opencontext-owner', 'utf8');
const fixture = JSON.parse(process.env.SMOKE_FIXTURE);
const expected = process.env.SMOKE_EXPECTED
  ? JSON.parse(process.env.SMOKE_EXPECTED)
  : undefined;
assert.equal(process.getuid(), 1000);
assert.equal(existsSync('/run/secrets/npm_ca'), false);
assert.equal(getCACertificates('extra').length, 0);
assert.equal(
  Object.keys(process.env).some((k) =>
    /^(https?_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED)$/i.test(
      k,
    ),
  ),
  false,
);
assert.throws(
  () =>
    writeFileSync(
      '/opt/opencontext/apps/server/src/readonly-probe',
      'synthetic',
    ),
  (e) => e.code === 'EROFS',
);
async function request(path, token = owner, method = 'GET', body) {
  return globalThis.fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: globalThis.AbortSignal.timeout(5000),
  });
}
async function json(path, method = 'GET', body, token = owner) {
  const response = await request(path, token, method, body);
  assert.ok(response.ok, `${method} ${path} status ${response.status}`);
  return response.json();
}
async function cli(token, ...args) {
  const child = spawn(process.execPath, ['scripts/opencontext.ts', ...args], {
    env: {
      PATH: process.env.PATH,
      OPENCONTEXT_URL: base,
      OPENCONTEXT_QUERY_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '',
    err = '';
  child.stdout.on('data', (p) => (out += p));
  child.stderr.on('data', (p) => (err += p));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [exit] = await once(child, 'close');
    assert.equal(exit, 0, err);
    return JSON.parse(out);
  } finally {
    clearTimeout(timer);
  }
}
for (let n = 0; n < 80; n++) {
  try {
    if ((await request('/api/health', null)).ok) break;
  } catch {
    /* Retry bounded startup health check. */
  }
  await delay(100);
}
assert.equal((await request('/api/health', null)).status, 200);
assert.equal((await request('/api/readiness')).status, 200);
assert.equal((await request('/api/projects', null)).status, 401);
let project, other, binding, original, newRevision;
async function sync() {
  const run = await json(
    `/api/projects/${project.id}/bindings/${binding.id}/sync`,
    'POST',
  );
  for (let n = 0; n < 100; n++) {
    const current = (await json(`/api/projects/${project.id}/runs`)).find(
      (r) => r.id === run.id,
    );
    if (current?.state === 'published') return;
    assert.ok(!['failed', 'canceled'].includes(current?.state), 'SYNC_FAILED');
    await delay(100);
  }
  throw new Error('SYNC_DEADLINE');
}
if (!expected) {
  project = await json('/api/projects', 'POST', {
    name: 'Built image synthetic recall',
  });
  other = await json('/api/projects', 'POST', {
    name: 'Other synthetic space',
  });
  binding = await json(`/api/projects/${project.id}/bindings`, 'POST', {
    name: 'Synthetic import',
    connector: {
      packageRef: 'org.opencontext.codex-sessions@0.1.0',
      config: { projectScope: 'synthetic-project' },
    },
    processor: {
      packageRef: 'org.opencontext.session-candidates@0.1.0',
      config: {},
    },
  });
  const imported = await json(
    `/api/projects/${project.id}/bindings/${binding.id}/imports`,
    'POST',
    { filename: 'synthetic.json', content: JSON.stringify(fixture) },
  );
  await sync();
  const found = await json(`/api/projects/${project.id}/search`, 'POST', {
    query: 'bounded backoff',
    mode: 'grep',
  });
  assert.ok(found.hits.length > 0);
  const hit = found.hits[0];
  original = await json(
    `/api/projects/${project.id}/read?` +
      new URLSearchParams({
        fileId: hit.file.fileId,
        revisionId: hit.file.revisionId,
      }),
  );
  fixture.payload.thread.turns[0].items[1].text =
    'Experience: Retry transient failures with bounded backoff, image version two.';
  await json(
    `/api/projects/${project.id}/bindings/${binding.id}/imports`,
    'POST',
    {
      filename: 'synthetic.json',
      content: JSON.stringify(fixture),
      expectedObjectId: imported.id,
    },
  );
  await sync();
  const latest = await json(`/api/projects/${project.id}/search`, 'POST', {
    query: 'bounded backoff',
    mode: 'grep',
  });
  newRevision = latest.hits.find((h) => h.file.fileId === original.file.fileId)
    .file.revisionId;
  assert.notEqual(newRevision, original.file.revisionId);
} else {
  project = { id: expected.projectId };
  other = { id: expected.otherProjectId };
  binding = { id: expected.bindingId };
  original = {
    file: {
      fileId: expected.citation.fileId,
      revisionId: expected.citation.revisionId,
    },
    citation: expected.citation,
  };
  newRevision = expected.newRevision;
}
const reader = await json(`/api/projects/${project.id}/tokens`, 'POST');
assert.equal((await request('/api/readiness', reader.token)).status, 403);
assert.equal(
  (await request(`/api/projects/${other.id}/tree`, reader.token)).status,
  403,
);
const search = await cli(
  reader.token,
  'search',
  project.id,
  'bounded backoff',
  'grep',
);
assert.equal(
  search.hits.find((h) => h.file.fileId === original.file.fileId).file
    .revisionId,
  newRevision,
);
const fixed = await cli(
  reader.token,
  'read',
  project.id,
  original.file.fileId,
  original.file.revisionId,
);
assert.deepEqual(fixed.citation, original.citation);
assert.equal(fixed.file.freshness, 'stale');
const bodySha256 = createHash('sha256').update(fixed.text).digest('hex');
assert.equal(bodySha256, fixed.citation.contentHash);
if (expected) assert.equal(bodySha256, expected.bodySha256);
const client = new Client({ name: 'built-image-synthetic', version: '1.0.0' });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', base), {
      requestInit: { headers: { authorization: 'Bearer ' + reader.token } },
    }),
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'context_read'));
  const found = (
    await client.callTool({
      name: 'context_search',
      arguments: {
        projectId: project.id,
        query: 'bounded backoff',
        mode: 'grep',
      },
    })
  ).structuredContent;
  assert.equal(
    found.hits.find((h) => h.file.fileId === original.file.fileId).file
      .revisionId,
    newRevision,
  );
  const read = (
    await client.callTool({
      name: 'context_read',
      arguments: {
        projectId: project.id,
        fileId: original.file.fileId,
        revisionId: original.file.revisionId,
      },
    })
  ).structuredContent;
  assert.deepEqual(read, fixed);
} finally {
  await client.close();
}
const head = (await json('/api/projects')).find(
  (p) => p.id === project.id,
).head;
if (expected) assert.equal(head, expected.head);
assert.equal((await request('/api/readiness')).status, 200);
console.log(
  JSON.stringify({
    result: 'passed',
    uid: process.getuid(),
    rootWriteRejected: true,
    buildCAAbsent: true,
    extraCAs: 0,
    health: 200,
    readiness: 200,
    anonymous: 401,
    readerReadiness: 403,
    crossProject: 403,
    cliRecall: true,
    mcpRecall: true,
    fixedHistoricalRead: true,
    projectId: project.id,
    otherProjectId: other.id,
    bindingId: binding.id,
    citation: fixed.citation,
    bodySha256,
    newRevision,
    head,
  }),
);
