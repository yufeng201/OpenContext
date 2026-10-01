import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createApplication } from '../../apps/server/src/app.ts';
import {
  feishuApiFixture,
  feishuFixtureConfig,
} from '../fixtures/feishu-api.ts';
import type {
  Binding,
  FileEntry,
  Project,
  ReadResult,
  Run,
  SearchResult,
} from '../../packages/contracts/src/index.ts';

const headers = {
  authorization: 'Bearer synthetic-feishu-integration-owner-0000000000',
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function fixture(config: Record<string, string> = feishuFixtureConfig) {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-feishu-integration-'));
  const remote = feishuApiFixture();
  const options = {
    dataRoot: root,
    ownerToken: headers.authorization.slice(7),
    autoStart: false,
    feishu: { ...remote, sleep: async () => {} },
  };
  let app = createApplication(options);
  cleanup.push(async () => {
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = (
    await app.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Feishu synthetic archive' },
    })
  ).json<Project>();
  const response = await app.app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/bindings`,
    headers,
    payload: {
      name: 'Selected group',
      connector: { packageRef: 'org.opencontext.feishu-chat@0.1.0', config },
      processor: {
        packageRef: 'org.opencontext.feishu-chat-analysis@0.1.0',
        config: {},
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const binding = response.json<Binding>();
  const base = `/api/projects/${project.id}/bindings/${binding.id}`;
  return {
    root,
    remote,
    project,
    binding,
    base,
    get app() {
      return app;
    },
    async diagnostic() {
      return app.app.inject({
        method: 'POST',
        url: base + '/test-connection',
        headers,
      });
    },
    async run(kind: 'sync' | 'process') {
      const r = await app.app.inject({
        method: 'POST',
        url: base + '/' + kind,
        headers,
      });
      expect(r.statusCode, r.body).toBe(202);
      await app.coordinator.drain();
      return app.catalog.getRun(r.json<Run>().id)!;
    },
    async search(
      query: string,
      freshness: 'current_only' | 'include_stale' = 'current_only',
    ) {
      const r = await app.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/search`,
        headers,
        payload: { query, mode: 'grep', freshness },
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json<SearchResult>();
    },
    read(file: FileEntry) {
      return app.app.inject({
        url: `/api/projects/${project.id}/read?fileId=${file.fileId}&revisionId=${file.revisionId}`,
        headers,
      });
    },
    files() {
      return app.catalog.currentFiles(project.id).filter((f) => !f.tombstone);
    },
    async restart() {
      await app.app.close();
      app = createApplication(options);
    },
  };
}

it('executes the registered network adapter against simulated official pages, analysis, shared recall and fixed MCP reads', async () => {
  const f = await fixture();
  const diagnostic = await f.diagnostic();
  expect(diagnostic.statusCode, diagnostic.body).toBe(200);
  expect(diagnostic.json()).toMatchObject({
    status: 'reachable',
    evidence: 'simulated',
  });
  expect(f.app.catalog.head(f.project.id)).toBeNull();
  const sync = await f.run('sync');
  expect(sync.state, JSON.stringify(sync)).toBe('published');
  expect(f.remote.requests.some((url) => url.includes('page_token=last'))).toBe(
    true,
  );
  expect(
    f.remote.requests.some((url) => url.includes('container_id_type=thread')),
  ).toBe(true);
  expect((await f.run('process')).state).toBe('published');
  expect(
    f.files().filter((file) => file.collection === 'derived'),
  ).toHaveLength(5);
  const hits = (await f.search('feishu-amber-plan')).hits;
  expect(new Set(hits.map((hit) => hit.file.collection))).toEqual(
    new Set(['sources', 'derived']),
  );
  const derived = hits.find((hit) => hit.file.collection === 'derived')!;
  const read = (await f.read(derived.file)).json<ReadResult>();
  expect(read.text).toContain('simulated');
  expect(read.text).toContain('deterministic');
  for (const dep of derived.file.derivedFrom)
    expect(read.text).toContain(
      `oc://space/${f.project.id}/file/${dep.fileId}@${dep.revisionId}`,
    );
  const head = f.app.catalog.head(f.project.id);
  await f.restart();
  expect((await f.run('sync')).state).toBe('published');
  expect((await f.run('process')).state).toBe('published');
  expect(f.app.catalog.head(f.project.id)).toBe(head);
  const origin = await f.app.app.listen({ host: '127.0.0.1', port: 0 });
  const mcp = await fetch(origin + '/mcp', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'context_read',
        arguments: {
          projectId: f.project.id,
          fileId: derived.file.fileId,
          revisionId: derived.file.revisionId,
        },
      },
    }),
  });
  expect(mcp.status).toBe(200);
  expect(await mcp.text()).toContain('feishu-amber-plan');
});

it('resumes an interrupted page after restart without advancing the confirmed cursor or publishing partial files', async () => {
  const f = await fixture();
  f.remote.failNextPages(20);
  const failed = await f.run('sync');
  expect(failed.state).toBe('failed');
  expect(f.app.catalog.getBinding(f.binding.id)?.sourceVersion).toBeNull();
  expect(f.files()).toHaveLength(0);
  const before = f.remote.requests.length;
  f.remote.failNextPages(0);
  await f.restart();
  const resumed = await f.run('sync');
  expect(resumed.state, JSON.stringify(resumed)).toBe('published');
  expect(
    f.remote.requests
      .slice(before)
      .some((url) => url.includes('page_token=empty')),
  ).toBe(true);
  expect(
    f.files().filter((file) => file.collection === 'sources'),
  ).toHaveLength(3);
});

it('fails closed if a confirmed plugin snapshot is missing without deleting the published archive', async () => {
  const f = await fixture();
  expect((await f.run('sync')).state).toBe('published');
  const binding = f.app.catalog.getBinding(f.binding.id)!;
  const head = f.app.catalog.head(f.project.id);
  const namespace = createHash('sha256')
    .update(binding.connector!.ref)
    .digest('hex');
  rmSync(
    resolve(
      f.root,
      'plugin-state/feishu-chat',
      namespace,
      'snapshots',
      binding.sourceVersion!.slice(4) + '.json',
    ),
  );
  await f.restart();
  const failed = await f.run('sync');
  expect(failed.error).toBe('CHECKPOINT_MISSING');
  expect(f.app.catalog.head(f.project.id)).toBe(head);
  expect(f.app.catalog.getBinding(f.binding.id)!.sourceVersion).toBe(
    binding.sourceVersion,
  );
  expect((await f.search('feishu-amber-plan')).hits.length).toBeGreaterThan(0);
});

it('preserves absent messages but applies observed edits and explicit recall to current source and candidate visibility', async () => {
  const f = await fixture();
  await f.run('sync');
  await f.run('process');
  const old = (await f.search('feishu-amber-plan')).hits.find(
    (hit) => hit.file.collection === 'derived',
  )!.file;
  f.remote.setStage('missing');
  expect((await f.run('sync')).state).toBe('published');
  expect(
    (await f.search('feishu-amber-plan', 'include_stale')).hits.some(
      (hit) => hit.file.collection === 'sources',
    ),
  ).toBe(true);
  f.remote.setStage('updated');
  expect((await f.run('sync')).state).toBe('published');
  expect((await f.read(old)).json<ReadResult>().file.freshness).toBe('stale');
  await f.run('process');
  const candidate = (await f.search('feishu-amber-updated')).hits.find(
    (hit) => hit.file.collection === 'derived',
  )!.file;
  f.remote.setStage('deleted');
  expect((await f.run('sync')).state).toBe('published');
  expect((await f.search('feishu-amber', 'include_stale')).hits).toHaveLength(
    0,
  );
  expect((await f.read(candidate)).statusCode).toBe(404);
  await f.run('process');
  expect((await f.read(candidate)).statusCode).toBe(404);
});

it('keeps secrets server-side, refuses scope mismatch and distinguishes archive access from upstream access failure', async () => {
  const f = await fixture();
  await f.run('sync');
  await f.run('process');
  const reader = f.app.catalog.createReaderToken(f.project.id);
  expect(
    (
      await f.app.app.inject({
        method: 'POST',
        url: f.base + '/test-connection',
        headers: { authorization: 'Bearer ' + reader.token },
      })
    ).statusCode,
  ).toBe(403);
  const invalid = await f.app.app.inject({
    method: 'POST',
    url: `/api/projects/${f.project.id}/bindings`,
    headers,
    payload: {
      name: 'Invalid secret',
      connector: {
        packageRef: 'org.opencontext.feishu-chat@0.1.0',
        config: {
          ...feishuFixtureConfig,
          token: 'client-token-must-not-persist',
        },
      },
      processor: {
        packageRef: 'org.opencontext.feishu-chat-analysis@0.1.0',
        config: {},
      },
    },
  });
  expect(invalid.statusCode).toBe(400);
  f.remote.setStage('forbidden');
  expect((await f.run('sync')).state).toBe('failed');
  // Single-owner archive policy: upstream failure does not silently change local ACL.
  expect((await f.search('feishu-amber-plan')).hits.length).toBeGreaterThan(0);
  f.app.catalog.revokeBinding(f.binding.id);
  expect(
    (await f.search('feishu-amber-plan', 'include_stale')).hits,
  ).toHaveLength(0);
  expect((await f.diagnostic()).statusCode).toBe(409);
  function inspect(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const p = resolve(path, entry.name);
      if (entry.isDirectory()) inspect(p);
      else {
        const text = readFileSync(p).toString('utf8');
        expect(text).not.toContain('synthetic-feishu-fixture-only');
        expect(text).not.toContain('client-token-must-not-persist');
      }
    }
  }
  inspect(f.root);
  const missing = await fixture({
    ...feishuFixtureConfig,
    secretRef: 'secret:feishu/missing',
  });
  expect((await missing.diagnostic()).json()).toMatchObject({
    status: 'blocked',
    evidence: 'simulated',
  });
  expect(missing.remote.requests).toHaveLength(0);
  const wrong = await fixture({
    ...feishuFixtureConfig,
    chatId: 'oc_other_group',
  });
  expect((await wrong.diagnostic()).json()).toMatchObject({
    status: 'blocked',
    evidence: 'simulated',
  });
  expect(wrong.remote.requests).toHaveLength(0);
});
