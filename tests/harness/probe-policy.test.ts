import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProbeRequest } from '../../scripts/probes/policy.ts';

test('acceptance probe admits temporary read-only thread and explicit retrieval', () => {
  assert.doesNotThrow(() => assertProbeRequest('initialize', {}));
  assert.doesNotThrow(() =>
    assertProbeRequest('thread/start', {
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    }),
  );
  for (const tool of ['context_search', 'context_read'])
    assert.doesNotThrow(() =>
      assertProbeRequest('mcpServer/tool/call', {
        server: 'opencontext',
        tool,
      }),
    );
});
test('acceptance probe refuses model turns, login, persistent threads and write tools', () => {
  for (const [method, params] of [
    ['turn/start', {}],
    ['account/login/start', {}],
    [
      'thread/start',
      { ephemeral: false, sandbox: 'read-only', approvalPolicy: 'never' },
    ],
    [
      'thread/start',
      {
        ephemeral: true,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
    ],
    ['mcpServer/tool/call', { server: 'opencontext', tool: 'context_write' }],
    ['mcpServer/tool/call', { server: 'other', tool: 'context_read' }],
  ] as const)
    assert.throws(
      () => assertProbeRequest(method, params),
      /PROBE_METHOD_DENIED/,
    );
});

test('Docker probe accepts only immutable local IDs and rejects implicit image pulls', async () => {
  const { spawnSync } = await import('node:child_process');
  const positive = spawnSync(
    'python3',
    [
      '-c',
      "import runpy; p=runpy.run_path('scripts/probes/docker-acceptance.py'); assert p['validate_image']('sha256:'+'a'*64)=='sha256:'+'a'*64",
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(positive.status, 0, positive.stderr);
  const rejected = spawnSync(
    'python3',
    ['scripts/probes/docker-acceptance.py', 'unreviewed:latest'],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /LOCAL_IMAGE_ID_REQUIRED/);
});
