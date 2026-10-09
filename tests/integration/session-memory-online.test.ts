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
import { execFile } from 'node:child_process';
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
