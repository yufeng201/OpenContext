import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../../apps/server/src/app.ts';
import { Catalog } from '../../packages/state-sqlite/src/index.ts';
import type {
  AgentTask,
  AgentResponse,
} from '../../plugins/session-candidates/src/local-agent.ts';
import type { SessionMemoryStatus } from '../../packages/contracts/src/session-memory.ts';
import type { SearchResult } from '../../packages/contracts/src/index.ts';

const owner = 'synthetic-online-memory-owner-00000000000';
const headers = { authorization: `Bearer ${owner}` };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const original = readFileSync(
  new URL(
    '../../plugins/session-connector/fixtures/codex-session.json',
    import.meta.url,
  ),
  'utf8',
);
function fixture(enabled = true, autoStart = true) {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-memory-online-'));
  const directory = resolve(root, 'exports');
  mkdirSync(directory);
  writeFileSync(resolve(directory, 'selected.json'), original);
  const dataRoot = resolve(root, 'data');
  const sessionMemory = {
    enabled,
    dataRoot,
    directory,
    projectScope: 'synthetic-project',
  };
  let application = createApplication({
    dataRoot,
    ownerToken: owner,
    autoStart,
    sessionMemory,
  });
  cleanups.push(async () => {
    await application.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dataRoot,
    directory,
    sessionMemory,
    get application() {
      return application;
    },
    get: (path = '', auth = headers) =>
      application.app.inject({
        method: 'GET',
        url: '/api/session-memory' + path,
        headers: auth,
      }),
    post: (
      command: string,
      payload: Record<string, unknown> = {},
      auth = headers,
    ) =>
      application.app.inject({
        method: 'POST',
        url: '/api/session-memory/' + command,
        headers: auth,
        payload,
      }),
    async sync() {
      const r = await this.post('sync');
      expect(r.statusCode, r.body).toBe(200);
      return r.json<SessionMemoryStatus>();
    },
    async response() {
      const r = await this.get('/task');
      expect(r.statusCode, r.body).toBe(200);
      const { task } = r.json<{ task: AgentTask }>();
      const source = task.messages.find((m) => m.message.role === 'assistant')!;
      return {
        schema: 'opencontext.local-agent-response/v1',
        taskId: task.taskId,
        inputHash: task.inputHash,
        candidates: [
          {
            fileId: source.fileId,
            revisionId: source.revisionId,
            kind: 'memory',
            line: 1,
            markdown:
              'Synthetic online cedar-lighthouse proposal; simulated worker only.',
          },
        ],
      } satisfies AgentResponse;
    },
    async restart() {
      await application.app.close();
      application = createApplication({
        dataRoot,
        ownerToken: owner,
        autoStart,
        sessionMemory,
      });
    },
  };
}

it('online sync, task handoff, review and publication reuse the running server writer and survive restart', async () => {
  const f = fixture();
  expect((await f.get()).json()).toMatchObject({
    enabled: true,
    status: 'idle',
  });
  expect(() => new Catalog(resolve(f.dataRoot, 'control.sqlite'))).toThrow(
    'CATALOG_IN_USE',
  );
  const first = await f.sync();
  expect(first.status).toBe('pending');
  expect((await f.sync()).taskId).toBe(first.taskId);
  const reader = f.application.catalog.createReaderToken(first.projectId!);
  const readerHeaders = { authorization: `Bearer ${reader.token}` };
  const response = await f.response();
  const submitted = await f.post('submit', response);
  expect(submitted.statusCode, submitted.body).toBe(200);
  const review = submitted.json<SessionMemoryStatus>();
  expect(review.status).toBe('review');
  const search = () =>
    f.application.app.inject({
      method: 'POST',
      url: `/api/projects/${first.projectId}/search`,
      headers: readerHeaders,
      payload: { query: 'cedar-lighthouse', mode: 'grep' },
    });
  expect((await search()).json<SearchResult>().hits).toHaveLength(0);
  await f.restart();
  expect((await f.get()).json()).toMatchObject({
    status: 'review',
    taskId: first.taskId,
    reviewHash: review.reviewHash,
  });
  expect((await f.get('/review')).json().markdown).toContain(
    'status: candidate',
  );
  expect(
    (
      await f.post('approve', {
        taskId: first.taskId,
        reviewHash: '0'.repeat(64),
      })
    ).statusCode,
  ).toBe(403);
  const approval = { taskId: first.taskId, reviewHash: review.reviewHash };
  expect((await f.post('approve', approval)).json()).toMatchObject({
    status: 'published',
  });
  const head = f.application.catalog.head(first.projectId!);
  expect((await f.post('approve', approval)).json()).toMatchObject({
    status: 'published',
  });
  expect(f.application.catalog.head(first.projectId!)).toBe(head);
  const hits = (await search()).json<SearchResult>().hits;
  expect(hits).toHaveLength(1);
  expect(hits[0]!.file.derivedFrom).toHaveLength(2);
  await f.restart();
  expect((await f.sync()).status).toBe('published');
  expect((await f.get()).json().taskId).toBe(first.taskId);
});

it('denies anonymous and reader access to every control route, including handoffs and config', async () => {
  const f = fixture();
  const status = await f.sync();
  const reader = f.application.catalog.createReaderToken(status.projectId!);
  for (const auth of [{}, { authorization: `Bearer ${reader.token}` }]) {
    const expected = 'authorization' in auth ? 403 : 401;
    for (const path of ['', '/task', '/review'])
      expect((await f.get(path, auth as typeof headers)).statusCode).toBe(
        expected,
      );
    for (const command of ['sync', 'submit', 'approve', 'cancel', 'retry'])
      expect(
        (await f.post(command, {}, auth as typeof headers)).statusCode,
      ).toBe(expected);
  }
});

it('default-off configuration cannot scan, and requests cannot select arbitrary directories', async () => {
  const f = fixture(false);
  expect((await f.get()).json()).toMatchObject({
    enabled: false,
    status: 'disabled',
  });
  expect((await f.post('sync')).statusCode).toBe(403);
  expect(f.application.catalog.listProjects()).toHaveLength(0);
  const g = fixture();
  const request = await g.post('sync', { directory: '/not-authorized' });
  expect(request.statusCode).toBe(400);
  expect(g.application.catalog.listProjects()).toHaveLength(0);
  const project = g.application.catalog.createProject('synthetic');
  const rejected = await g.application.app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/bindings`,
    headers,
    payload: {
      name: 'bypass',
      connector: {
        packageRef: 'org.opencontext.session-directory@0.1.0',
        config: {
          enabled: true,
          directory: g.directory,
          projectScope: 'synthetic-project',
        },
      },
      processor: {
        packageRef: 'org.opencontext.reviewed-session-agent@0.1.0',
        config: {},
      },
    },
  });
  expect(rejected.statusCode).toBe(403);
});

it('coalesces concurrent sync requests without duplicate projects, bindings or task work', async () => {
  const f = fixture();
  const requests = await Promise.all(
    Array.from({ length: 8 }, () => f.post('sync')),
  );
  for (const r of requests) expect(r.statusCode, r.body).toBe(200);
  expect(new Set(requests.map((r) => r.json().taskId)).size).toBe(1);
  expect(f.application.catalog.listProjects()).toHaveLength(1);
  expect(
    f.application.catalog.listBindings(requests[0]!.json().projectId),
  ).toHaveLength(1);
});

it('cancel/retry rejects stale task IDs without damaging the newer review; source changes invalidate approval', async () => {
  const f = fixture();
  const first = await f.sync();
  const oldResponse = await f.response();
  expect((await f.post('cancel', { taskId: first.taskId })).json().status).toBe(
    'cancelled',
  );
  expect((await f.post('submit', oldResponse)).statusCode).toBe(403);
  const retry = await f.post('retry', { taskId: first.taskId });
  expect(retry.statusCode, retry.body).toBe(200);
  expect(retry.json().taskId).not.toBe(first.taskId);
  const review = (
    await f.post('submit', await f.response())
  ).json<SessionMemoryStatus>();
  expect((await f.post('cancel', { taskId: first.taskId })).statusCode).toBe(
    409,
  );
  expect((await f.get()).json().status).toBe('review');
  const changed = JSON.parse(original);
  changed.payload.thread.turns[0].items[1].text =
    'Memory: changed synthetic session';
  writeFileSync(resolve(f.directory, 'selected.json'), JSON.stringify(changed));
  await f.sync();
  expect(
    (
      await f.post('approve', {
        taskId: review.taskId,
        reviewHash: review.reviewHash,
      })
    ).statusCode,
  ).toBe(409);
  expect((await f.get()).json().status).toBe('pending');
});

it('generic process cannot bypass approval and revoked sources cannot expose handoffs', async () => {
  const f = fixture();
  const status = await f.sync();
  const run = f.application.catalog.enqueue(status.bindingId!, 'process');
  await f.application.coordinator.drain();
  expect(f.application.catalog.getRun(run.id)?.error).toBe('POLICY_DENIED');
  expect(
    f.application.catalog
      .currentFiles(status.projectId!)
      .filter((f) => f.collection === 'derived'),
  ).toHaveLength(0);
  f.application.catalog.revokeBinding(status.bindingId!);
  expect((await f.get('/task')).statusCode).toBe(409);
  expect((await f.post('submit', {})).statusCode).toBe(400);
});

it('online CLI performs the complete control flow over loopback without stopping the server', async () => {
  const f = fixture();
  const origin = await f.application.app.listen({ host: '127.0.0.1', port: 0 });
  const run = promisify(execFile);
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await run(
          process.execPath,
          ['scripts/session-memory-online.ts', ...args],
          {
            cwd: resolve(import.meta.dirname, '../..'),
            timeout: 15_000,
            maxBuffer: 1_048_576,
            env: {
              PATH: process.env['PATH'] ?? '',
              OPENCONTEXT_URL: origin,
              OPENCONTEXT_OWNER_TOKEN: owner,
            },
          },
        )
      ).stdout,
    );
  expect((await cli('config')).enabled).toBe(true);
  const first = await cli('sync');
  expect((await cli('task')).task.taskId).toBe(first.taskId);
  const responsePath = resolve(f.root, 'response.json');
  writeFileSync(responsePath, JSON.stringify(await f.response()));
  const reviewed = await cli('submit', responsePath);
  expect((await cli('review')).markdown).toContain('cedar-lighthouse');
  expect((await cli('approve', first.taskId, reviewed.reviewHash)).status).toBe(
    'published',
  );
  expect((await cli('status')).status).toBe('published');
  const health = await fetch(new URL('/api/health', origin));
  expect(health.status).toBe(200);
});

it('changed server configuration cannot download old handoffs or take approval shortcuts', async () => {
  const f = fixture();
  const initial = await f.sync();
  const review = (
    await f.post('submit', await f.response())
  ).json<SessionMemoryStatus>();
  const next = resolve(f.root, 'other-exports');
  mkdirSync(next);
  writeFileSync(resolve(next, 'selected.json'), original);
  f.sessionMemory.directory = next;
  await f.restart();
  for (const path of ['', '/task', '/review'])
    expect((await f.get(path)).statusCode).toBe(400);
  expect(
    (
      await f.post('approve', {
        taskId: initial.taskId,
        reviewHash: review.reviewHash,
      })
    ).statusCode,
  ).toBe(400);
});

it('approval idempotency does not report success after binding revocation', async () => {
  const f = fixture();
  const status = await f.sync();
  const review = (
    await f.post('submit', await f.response())
  ).json<SessionMemoryStatus>();
  const approval = { taskId: status.taskId, reviewHash: review.reviewHash };
  expect((await f.post('approve', approval)).statusCode).toBe(200);
  f.application.catalog.revokeBinding(status.bindingId!);
  expect((await f.post('approve', approval)).statusCode).toBe(409);
});

it('currently unsupported JSONL, truncated lines and unknown export formats never advance the snapshot', async () => {
  const f = fixture();
  const first = await f.sync();
  // Deliberately synthetic rollout-shaped data, not captured from a real Codex session.
  const event = JSON.stringify({
    timestamp: '2026-10-09T00:00:00Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'synthetic only' },
  });
  for (const body of [
    event + '\n',
    event + '\n' + event + '\n',
    event + '\n{"partial":',
  ]) {
    writeFileSync(resolve(f.directory, 'synthetic-rollout.jsonl'), body);
    const r = await f.post('sync');
    expect(r.statusCode, r.body).toBe(400);
    expect(
      f.application.catalog.getBinding(first.bindingId!)?.sourceVersion,
    ).toBe(first.sourceVersion);
    expect((await f.get()).json().taskId).toBe(first.taskId);
  }
  rmSync(resolve(f.directory, 'synthetic-rollout.jsonl'));
  const unknown = JSON.parse(original);
  unknown.schema = 'opencontext.session-import/v999';
  writeFileSync(resolve(f.directory, 'selected.json'), JSON.stringify(unknown));
  expect((await f.post('sync')).statusCode).toBe(400);
  expect(
    f.application.catalog.getBinding(first.bindingId!)?.sourceVersion,
  ).toBe(first.sourceVersion);
});

it('retries approval immediately after a committed publication checkpoint gap without a status read', async () => {
  const f = fixture();
  const first = await f.sync();
  const reviewed = (await f.post('submit', await f.response())).json();
  const approval = { taskId: first.taskId, reviewHash: reviewed.reviewHash };
  expect((await f.post('approve', approval)).statusCode).toBe(200);
  const head = f.application.catalog.head(first.projectId!);
  const path = resolve(f.dataRoot, 'plugin-state/session-memory/state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  // Persist the exact pre-cursor crash state while retaining the committed host run.
  state.status = 'publishing';
  state.processedVersion = null;
  writeFileSync(path, JSON.stringify(state));
  await f.restart();
  const result = await f.post('approve', approval);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({
    status: 'published',
    processedVersion: state.taskVersion,
  });
  expect(f.application.catalog.head(first.projectId!)).toBe(head);
});

it('never serves a modified review file as the approved hash preview', async () => {
  const f = fixture();
  await f.sync();
  await f.post('submit', await f.response());
  const path = resolve(f.dataRoot, 'plugin-state/session-memory/review.md');
  const originalPreview = readFileSync(path, 'utf8');
  writeFileSync(path, '# Forged synthetic preview');
  const result = await f.get('/review');
  expect(result.statusCode).toBe(409);
  expect(result.body).not.toContain('Forged synthetic preview');
  // A read failure does not discard a valid response; restoring the exact file recovers.
  writeFileSync(path, originalPreview);
  expect((await f.get('/review')).statusCode).toBe(200);
});

it('a rejected replacement response preserves the last valid review and approval', async () => {
  const f = fixture();
  const first = await f.sync();
  const response = await f.response();
  const reviewed = (await f.post('submit', response)).json();
  const preview = (await f.get('/review')).json();
  for (const patch of [
    { fileId: 'synthetic-unrelated-file' },
    { line: 999999 },
    { markdown: '   ' },
  ]) {
    const invalid = structuredClone(response);
    Object.assign(invalid.candidates[0]!, patch);
    const rejected = await f.post('submit', invalid);
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    expect((await f.get()).json()).toMatchObject({
      status: 'review',
      reviewHash: reviewed.reviewHash,
    });
    expect((await f.get('/review')).json()).toEqual(preview);
  }
  const wrongHash = await f.post('submit', {
    ...response,
    inputHash: '0'.repeat(64),
  });
  expect(wrongHash.statusCode).toBe(409);
  expect((await f.get('/review')).json()).toEqual(preview);
  expect(
    (
      await f.post('approve', {
        taskId: first.taskId,
        reviewHash: reviewed.reviewHash,
      })
    ).statusCode,
  ).toBe(200);
});

it('stale sources cannot be served as a current review or retained after a rejected replacement', async () => {
  const f = fixture();
  const first = await f.sync();
  const response = await f.response();
  await f.post('submit', response);
  const changed = JSON.parse(original);
  changed.payload.thread.turns[0].items[1].text =
    'Synthetic source update outside the memory control flow';
  writeFileSync(resolve(f.directory, 'selected.json'), JSON.stringify(changed));
  const run = f.application.catalog.enqueue(first.bindingId!, 'sync');
  await f.application.coordinator.drain();
  expect(f.application.catalog.getRun(run.id)?.state).toBe('published');
  const stale = await f.get('/review');
  expect(stale.statusCode).toBe(409);
  expect(stale.body).not.toContain('cedar-lighthouse');
  expect((await f.post('submit', response)).statusCode).toBe(409);
  expect((await f.get()).json().status).toBe('failed');
  expect((await f.post('retry', { taskId: first.taskId })).json().status).toBe(
    'pending',
  );
});

it('recovered publication is readable through loopback CLI/MCP only in the authorized project', async () => {
  const f = fixture();
  const first = await f.sync();
  const review = (await f.post('submit', await f.response())).json();
  const approval = { taskId: first.taskId, reviewHash: review.reviewHash };
  expect((await f.post('approve', approval)).statusCode).toBe(200);
  const head = f.application.catalog.head(first.projectId!);
  const reader = f.application.catalog.createReaderToken(first.projectId!);
  const other = f.application.catalog.createProject(
    'Synthetic unrelated project',
  );
  const outsider = f.application.catalog.createReaderToken(other.id);
  const statePath = resolve(
    f.dataRoot,
    'plugin-state/session-memory/state.json',
  );
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(
    statePath,
    JSON.stringify({ ...state, status: 'publishing', processedVersion: null }),
  );
  await f.restart();
  const origin = await f.application.app.listen({ host: '127.0.0.1', port: 0 });
  const run = promisify(execFile);
  const cli = async (script: string, token: string, ...args: string[]) =>
    JSON.parse(
      (
        await run(process.execPath, ['scripts/' + script, ...args], {
          cwd: resolve(import.meta.dirname, '../..'),
          timeout: 15000,
          maxBuffer: 1048576,
          env: {
            PATH: process.env['PATH'] ?? '',
            OPENCONTEXT_URL: origin,
            OPENCONTEXT_OWNER_TOKEN: token,
            OPENCONTEXT_QUERY_TOKEN: token,
          },
        })
      ).stdout,
    );
  expect(
    (
      await cli(
        'session-memory-online.ts',
        owner,
        'approve',
        first.taskId!,
        review.reviewHash,
      )
    ).status,
  ).toBe('published');
  expect(f.application.catalog.head(first.projectId!)).toBe(head);
  const hits = (
    await cli(
      'opencontext.ts',
      reader.token,
      'search',
      first.projectId!,
      'cedar-lighthouse',
    )
  ).hits;
  expect(hits).toHaveLength(1);
  const file = hits[0].file;
  const read = async (token: string) => {
    const response = await fetch(new URL('/mcp', origin), {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_read',
          arguments: {
            projectId: first.projectId,
            fileId: file.fileId,
            revisionId: file.revisionId,
            section: 'Content',
            maxBytes: 256,
          },
        },
      }),
    });
    return { status: response.status, text: await response.text() };
  };
  const allowed = await read(reader.token);
  expect(allowed.status).toBe(200);
  const content = JSON.parse(allowed.text).result.structuredContent;
  expect(content.text).toContain('cedar-lighthouse');
  expect(content.citation.revisionId).toBe(file.revisionId);
  expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(256);
  const denied = await read(outsider.token);
  expect(denied.text).not.toContain('cedar-lighthouse');
  expect(denied.text).toContain('FORBIDDEN');
  await expect(
    cli(
      'opencontext.ts',
      outsider.token,
      'search',
      first.projectId!,
      'cedar-lighthouse',
    ),
  ).rejects.toThrow();
  f.application.catalog.revokeBinding(first.bindingId!);
  const revoked = await read(reader.token);
  expect(revoked.text).not.toContain('cedar-lighthouse');
});

it('concurrent approvals and retries produce one publication and one replacement task', async () => {
  const f = fixture();
  const first = await f.sync();
  await f.post('cancel', { taskId: first.taskId });
  const retries = await Promise.all(
    Array.from({ length: 8 }, () => f.post('retry', { taskId: first.taskId })),
  );
  const accepted = retries.filter((r) => r.statusCode === 200);
  expect(accepted.length).toBeGreaterThan(0);
  expect(new Set(accepted.map((r) => r.json().taskId)).size).toBe(1);
  for (const r of retries) expect([200, 409, 429]).toContain(r.statusCode);
  const taskId = accepted[0]!.json().taskId;
  expect(taskId).not.toBe(first.taskId);
  const reviewed = (await f.post('submit', await f.response())).json();
  const approvals = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.post('approve', { taskId, reviewHash: reviewed.reviewHash }),
    ),
  );
  for (const r of approvals) {
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('published');
  }
  const runs = f.application.catalog.listRuns(first.projectId!);
  expect(runs.filter((run) => run.kind === 'sync')).toHaveLength(2);
  expect(runs.filter((run) => run.kind === 'process')).toHaveLength(1);
  expect(
    f.application.catalog
      .currentFiles(first.projectId!)
      .filter((file) => file.collection === 'derived'),
  ).toHaveLength(1);
  expect((await f.post('retry', { taskId: first.taskId })).statusCode).toBe(
    409,
  );
  expect((await f.get()).json()).toMatchObject({ status: 'published', taskId });
});

it('recovery of a committed publication does not bypass a revoked binding', async () => {
  const f = fixture();
  const first = await f.sync();
  const review = (await f.post('submit', await f.response())).json();
  const approval = { taskId: first.taskId, reviewHash: review.reviewHash };
  expect((await f.post('approve', approval)).statusCode).toBe(200);
  const path = resolve(f.dataRoot, 'plugin-state/session-memory/state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(
    path,
    JSON.stringify({ ...state, status: 'publishing', processedVersion: null }),
  );
  f.application.catalog.revokeBinding(first.bindingId!);
  await f.restart();
  const head = f.application.catalog.head(first.projectId!);
  expect((await f.post('approve', approval)).statusCode).toBe(409);
  expect((await f.get('/review')).statusCode).toBe(409);
  expect(f.application.catalog.head(first.projectId!)).toBe(head);
  expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('publishing');
  expect(
    f.application.catalog
      .listRuns(first.projectId!)
      .filter((run) => run.kind === 'process'),
  ).toHaveLength(1);
});

it('does not retain a prior review when its binding is revoked during replacement validation', async () => {
  const f = fixture();
  const first = await f.sync();
  const response = await f.response();
  await f.post('submit', response);
  const catalog = f.application.catalog;
  const currentFiles = catalog.currentFiles;
  let reads = 0;
  catalog.currentFiles = function (projectId) {
    const files = currentFiles.call(this, projectId);
    if (++reads === 2)
      queueMicrotask(() => catalog.revokeBinding(first.bindingId!));
    return files;
  };
  try {
    const invalid = structuredClone(response);
    invalid.candidates[0]!.fileId = 'synthetic-invalid-replacement';
    expect((await f.post('submit', invalid)).statusCode).toBeGreaterThanOrEqual(
      400,
    );
  } finally {
    catalog.currentFiles = currentFiles;
  }
  expect(catalog.getBinding(first.bindingId!)?.active).toBe(false);
  const state = JSON.parse(
    readFileSync(
      resolve(f.dataRoot, 'plugin-state/session-memory/state.json'),
      'utf8',
    ),
  );
  expect(state.status).toBe('failed');
  expect(state.response).toBeNull();
  expect(state.reviewHash).toBeNull();
  expect((await f.get('/review')).statusCode).toBe(409);
});

it('rolls back a new memory space when binding persistence fails, then retries without orphan spaces', async () => {
  const f = fixture();
  f.application.catalog.db.exec(`CREATE TEMP TRIGGER fail_memory_binding
    BEFORE INSERT ON bindings BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END`);
  const failed = await f.post('sync');
  expect(failed.statusCode).toBe(500);
  expect(f.application.catalog.listProjects()).toHaveLength(0);
  const initializationEvents = () =>
    f.application.catalog.db
      .prepare(
        "SELECT event_json FROM (SELECT event_json FROM audit_pending UNION ALL SELECT event_json FROM audit_events) WHERE json_extract(event_json,'$.action') IN ('project.create','source.create')",
      )
      .all();
  expect(initializationEvents()).toHaveLength(0);
  f.application.catalog.db.exec('DROP TRIGGER fail_memory_binding');
  const recovered = await f.sync();
  expect(recovered.status).toBe('pending');
  expect(initializationEvents()).toHaveLength(2);
  expect(f.application.catalog.listProjects()).toHaveLength(1);
  expect(f.application.catalog.listBindings(recovered.projectId!)).toHaveLength(
    1,
  );
});

it('refuses a published sync run as proof that reviewed memory was published', async () => {
  const f = fixture();
  const first = await f.sync();
  await f.post('submit', await f.response());
  const path = resolve(f.dataRoot, 'plugin-state/session-memory/state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const sync = f.application.catalog
    .listRuns(first.projectId!)
    .find((run) => run.kind === 'sync')!;
  expect(sync.state).toBe('published');
  const damaged = JSON.stringify({
    ...state,
    status: 'publishing',
    runId: sync.id,
  });
  writeFileSync(path, damaged);
  await f.restart();
  const result = await f.get();
  expect(result.statusCode).toBe(500);
  expect(result.json().error.code).toBe('CHECKPOINT_CORRUPT');
  expect(readFileSync(path, 'utf8')).toBe(damaged);
  expect(
    f.application.catalog
      .currentFiles(first.projectId!)
      .filter((file) => file.collection === 'derived'),
  ).toHaveLength(0);
});

it('survives process death between space and binding inserts without partial initialization', async () => {
  const f = fixture();
  await f.application.app.close();
  const script = resolve(f.root, 'crash-initialization.mjs');
  writeFileSync(
    script,
    `
    const {createApplication}=await import(${JSON.stringify(new URL('../../apps/server/src/app.ts', import.meta.url).href)});
    const a=createApplication(${JSON.stringify({ dataRoot: f.dataRoot, ownerToken: owner, autoStart: false, sessionMemory: f.sessionMemory })});
    a.catalog.db.function('synthetic_crash',()=>{process.kill(process.pid,'SIGKILL');return 1;});
    a.catalog.db.exec("CREATE TEMP TRIGGER crash_binding BEFORE INSERT ON bindings BEGIN SELECT synthetic_crash(); END");
    await a.app.inject({method:'POST',url:'/api/session-memory/sync',headers:${JSON.stringify(headers)},payload:{}});
  `,
  );
  expect(() =>
    execFileSync(process.execPath, [script], {
      timeout: 10000,
      stdio: 'pipe',
      env: { PATH: process.env['PATH'] ?? '' },
    }),
  ).toThrow(expect.objectContaining({ signal: 'SIGKILL' }));
  await f.restart();
  expect(f.application.catalog.listProjects()).toHaveLength(0);
  const status = await f.sync();
  expect(status.status).toBe('pending');
  expect(f.application.catalog.listProjects()).toHaveLength(1);
});

it.each(['input', 'task', 'response'] as const)(
  'rejects a mismatched %s checkpoint during publication recovery',
  async (mismatch) => {
    const f = fixture();
    const first = await f.sync();
    const review = (await f.post('submit', await f.response())).json();
    expect(
      (
        await f.post('approve', {
          taskId: first.taskId,
          reviewHash: review.reviewHash,
        })
      ).statusCode,
    ).toBe(200);
    const head = f.application.catalog.head(first.projectId!);
    const runs = f.application.catalog.listRuns(first.projectId!);
    const path = resolve(f.dataRoot, 'plugin-state/session-memory/state.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.status = 'publishing';
    state.processedVersion = null;
    if (mismatch === 'input')
      state.task.inputCommitId = 'synthetic-unrelated-commit';
    if (mismatch === 'task')
      state.task.bindingId = 'synthetic-unrelated-binding';
    if (mismatch === 'response')
      state.response.taskId = 'synthetic-unrelated-task';
    const damaged = JSON.stringify(state);
    writeFileSync(path, damaged);
    await f.restart();
    const result = await f.get();
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe('CHECKPOINT_CORRUPT');
    expect(readFileSync(path, 'utf8')).toBe(damaged);
    expect(f.application.catalog.head(first.projectId!)).toBe(head);
    expect(f.application.catalog.listRuns(first.projectId!)).toHaveLength(
      runs.length,
    );
  },
);

it('status polling recovers a committed publication exactly once and clears obsolete errors', async () => {
  const f = fixture();
  const first = await f.sync();
  const review = (await f.post('submit', await f.response())).json();
  const approval = { taskId: first.taskId, reviewHash: review.reviewHash };
  expect((await f.post('approve', approval)).statusCode).toBe(200);
  const head = f.application.catalog.head(first.projectId!);
  const path = resolve(f.dataRoot, 'plugin-state/session-memory/state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(
    path,
    JSON.stringify({
      ...state,
      status: 'publishing',
      processedVersion: null,
      error: 'PROCESSING_FAILED',
    }),
  );
  await f.restart();
  for (let i = 0; i < 3; i++) {
    const status = await f.get();
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'published',
      processedVersion: state.taskVersion,
      error: null,
    });
  }
  expect((await f.post('approve', approval)).statusCode).toBe(200);
  expect(f.application.catalog.head(first.projectId!)).toBe(head);
  expect(
    f.application.catalog
      .listRuns(first.projectId!)
      .filter((run) => run.kind === 'process'),
  ).toHaveLength(1);
});
