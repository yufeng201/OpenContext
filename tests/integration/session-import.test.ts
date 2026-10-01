import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApplication } from '../../apps/server/src/app.ts';
import { hash } from '../../packages/storage-fs/src/index.ts';
import type {
  Binding,
  FileEntry,
  ImportedObjectRef,
  Project,
  ReadResult,
  Run,
  SearchResult,
} from '../../packages/contracts/src/index.ts';

const token = 'synthetic-session-owner-000000000000000000';
const headers = { authorization: 'Bearer ' + token };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function example(provider: 'codex' | 'claude') {
  return readFileSync(
    new URL(
      `../../plugins/session-connector/fixtures/${provider}-session.json`,
      import.meta.url,
    ),
    'utf8',
  );
}
function changedCodex(marker = 'Experience: newer-amber-evidence') {
  const value = JSON.parse(example('codex'));
  value.payload.thread.turns[0].items[1].text = marker;
  return JSON.stringify(value);
}
async function fixture(provider: 'codex' | 'claude' = 'codex') {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-session-integration-'));
  let app = createApplication({
    dataRoot: root,
    ownerToken: token,
    autoStart: false,
  });
  cleanup.push(async () => {
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = (
    await app.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Synthetic sessions' },
    })
  ).json<Project>();
  const response = await app.app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/bindings`,
    headers,
    payload: {
      name: provider + ' explicit imports',
      connector: {
        packageRef: `org.opencontext.${provider}-sessions@0.1.0`,
        config: { projectScope: 'synthetic-project' },
      },
      processor: {
        packageRef: 'org.opencontext.session-candidates@0.1.0',
        config: {},
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const binding = response.json<Binding>();
  const base = `/api/projects/${project.id}/bindings/${binding.id}`;
  return {
    root,
    project,
    binding,
    base,
    get app() {
      return app;
    },
    async upload(
      content = example(provider),
      expectedObjectId?: string,
      filename = 'selected.json',
    ) {
      return app.app.inject({
        method: 'POST',
        url: base + '/imports',
        headers,
        payload: {
          filename,
          content,
          ...(expectedObjectId ? { expectedObjectId } : {}),
        },
      });
    },
    async run(kind: 'sync' | 'process') {
      const result = await app.app.inject({
        method: 'POST',
        url: base + '/' + kind,
        headers,
      });
      expect(result.statusCode, result.body).toBe(202);
      await app.coordinator.drain();
      return app.catalog.getRun(result.json<Run>().id)!;
    },
    async search(
      query: string,
      freshness: 'current_only' | 'include_stale' = 'current_only',
    ) {
      const result = await app.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/search`,
        headers,
        payload: { query, mode: 'grep', freshness },
      });
      expect(result.statusCode, result.body).toBe(200);
      return result.json<SearchResult>();
    },
    async read(file: FileEntry) {
      return app.app.inject({
        url: `/api/projects/${project.id}/read?fileId=${file.fileId}&revisionId=${file.revisionId}`,
        headers,
      });
    },
    files() {
      return app.catalog
        .currentFiles(project.id)
        .filter((file) => !file.tombstone);
    },
    async restart() {
      await app.app.close();
      app = createApplication({
        dataRoot: root,
        ownerToken: token,
        autoStart: false,
      });
    },
  };
}

it.each(['codex', 'claude'] as const)(
  '%s imports produce cited candidate files, shared recall and restart-safe idempotency',
  async (provider) => {
    const f = await fixture(provider);
    const upload = await f.upload();
    expect(upload.statusCode, upload.body).toBe(200);
    const ref = upload.json<ImportedObjectRef>();
    expect((await f.upload()).json<ImportedObjectRef>()).toEqual(ref);
    expect((await f.run('sync')).state).toBe('published');
    const queued = f.app.catalog.enqueue(f.binding.id, 'process');
    await f.restart();
    expect(f.app.catalog.getRun(queued.id)?.execution).toEqual(
      queued.execution,
    );
    await f.app.coordinator.drain();
    expect(f.app.catalog.getRun(queued.id)?.state).toBe('published');
    const files = f.files();
    const raw = files.find((file) => file.logicalPath.endsWith('/raw.json'))!;
    expect((await f.read(raw)).json<ReadResult>().text).toBe(example(provider));
    const candidates = files.filter((file) => file.collection === 'derived');
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.derivedFrom).toHaveLength(2);
      expect(candidate.derivedFrom).toContainEqual({
        fileId: raw.fileId,
        revisionId: raw.revisionId,
      });
      const result = (await f.read(candidate)).json<ReadResult>();
      expect(result.text).toContain('status: candidate');
      expect(result.text).toContain('method: deterministic');
      for (const dep of candidate.derivedFrom) {
        expect(result.text).toContain(
          `oc://space/${f.project.id}/file/${dep.fileId}@${dep.revisionId}`,
        );
        expect(
          f.app.catalog.getRevision(f.project.id, dep.fileId, dep.revisionId),
        ).toBeTruthy();
      }
    }
    expect(
      files.some((file) => /\/(AGENTS|CLAUDE)\.md$/.test(file.logicalPath)),
    ).toBe(false);
    const query = provider === 'codex' ? 'bounded backoff' : '可重建';
    expect(
      new Set((await f.search(query)).hits.map((hit) => hit.file.collection)),
    ).toEqual(new Set(['sources', 'derived']));
    const head = f.app.catalog.head(f.project.id);
    expect((await f.run('sync')).state).toBe('published');
    expect((await f.run('process')).state).toBe('published');
    expect(f.app.catalog.head(f.project.id)).toBe(head);
    const address = await f.app.app.listen({ host: '127.0.0.1', port: 0 });
    const mcp = await fetch(address + '/mcp', {
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
            fileId: candidates[0]!.fileId,
            revisionId: candidates[0]!.revisionId,
          },
        },
      }),
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain('status: candidate');
  },
);

it('replaces selected exports with CAS, preserves message identity, invalidates removed evidence and never recalls deleted candidates', async () => {
  const f = await fixture();
  const object = (await f.upload()).json<ImportedObjectRef>();
  await f.run('sync');
  await f.run('process');
  const original = f
    .files()
    .find(
      (file) =>
        file.collection === 'derived' &&
        f.app.store.readText(file.contentHash).includes('bounded backoff'),
    )!;
  const message = original.derivedFrom.find((dep) =>
    f
      .files()
      .find((file) => file.fileId === dep.fileId)
      ?.logicalPath.includes('/messages/'),
  )!;
  expect((await f.upload(changedCodex())).statusCode).toBe(409);
  const replacement = await f.upload(changedCodex(), object.id);
  expect(replacement.statusCode, replacement.body).toBe(200);
  expect(
    (await f.upload(changedCodex('Experience: stale-overwrite'), object.id))
      .statusCode,
  ).toBe(409);
  await f.run('sync');
  expect(
    f.files().find((file) => file.fileId === message.fileId)!.revisionId,
  ).not.toBe(message.revisionId);
  expect((await f.read(original)).json<ReadResult>().file.freshness).toBe(
    'stale',
  );
  expect((await f.search('bounded backoff')).hits).toHaveLength(0);
  expect(
    (await f.search('bounded backoff', 'include_stale')).hits.some(
      (hit) => hit.file.collection === 'derived',
    ),
  ).toBe(true);
  await f.run('process');
  expect(
    f.files().filter((file) => file.collection === 'derived'),
  ).toHaveLength(1);
  expect((await f.read(original)).json<ReadResult>().file.freshness).toBe(
    'stale',
  );
  await f.restart();
  expect((await f.read(original)).json<ReadResult>().file.freshness).toBe(
    'stale',
  );
  const current = f.files().find((file) => file.collection === 'derived')!;
  expect(
    (
      await f.app.app.inject({
        method: 'DELETE',
        url: f.base + '/imports/' + object.id,
        headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await f.app.app.inject({
        method: 'DELETE',
        url: f.base + '/imports/' + replacement.json<ImportedObjectRef>().id,
        headers,
      })
    ).statusCode,
  ).toBe(200);
  await f.run('sync');
  expect((await f.search('newer-amber', 'include_stale')).hits).toHaveLength(0);
  expect((await f.read(current)).statusCode).toBe(404);
  await f.run('process');
  expect(f.files()).toHaveLength(0);
  expect((await f.read(current)).statusCode).toBe(404);
});

it('rejects partial, wrong-project, secret and malformed uploads before blob persistence', async () => {
  const f = await fixture();
  const invalid = [
    '{broken',
    example('codex').replace('"complete": true', '"complete": false'),
    example('codex').replace('synthetic-project', 'another-project'),
    example('codex').replace(
      '"cliVersion":',
      '"api_key":"synthetic-not-real", "cliVersion":',
    ),
  ];
  for (const content of invalid) {
    const response = await f.upload(content);
    expect(response.statusCode, response.body).toBe(400);
    expect(f.app.catalog.listImports(f.binding.id)).toHaveLength(0);
    const contentHash = hash(content);
    expect(
      existsSync(
        resolve(f.root, 'content/blobs', contentHash.slice(0, 2), contentHash),
      ),
    ).toBe(false);
    expect(response.body).not.toContain('synthetic-not-real');
  }
  expect(f.app.catalog.head(f.project.id)).toBeNull();
});

it('supersedes a queued import snapshot after replacement and allows explicit retry of the new snapshot', async () => {
  const f = await fixture();
  const object = (await f.upload()).json<ImportedObjectRef>();
  const queued = f.app.catalog.enqueue(f.binding.id, 'sync');
  await f.upload(changedCodex(), object.id);
  await f.app.coordinator.drain();
  expect(f.app.catalog.getRun(queued.id)?.error).toBe('INPUT_CHANGED');
  expect(f.app.catalog.head(f.project.id)).toBeNull();
  expect((await f.run('sync')).state).toBe('published');
});

it('denies reader imports and cross-project access, then revokes raw, messages, candidates and fixed MCP citations', async () => {
  const f = await fixture();
  await f.upload();
  await f.run('sync');
  await f.run('process');
  const reader = f.app.catalog.createReaderToken(f.project.id);
  const readerHeaders = { authorization: 'Bearer ' + reader.token };
  const other = f.app.catalog.createProject('Another synthetic project');
  expect(
    (
      await f.app.app.inject({
        url: f.base + '/imports',
        headers: readerHeaders,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.app.inject({
        method: 'POST',
        url: f.base + '/imports',
        headers: readerHeaders,
        payload: { filename: 'x.json', content: example('codex') },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.app.inject({
        url: `/api/projects/${other.id}/bindings/${f.binding.id}/imports`,
        headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await f.app.app.inject({
        method: 'POST',
        url: `/api/projects/${other.id}/search`,
        headers: readerHeaders,
        payload: { query: 'backoff' },
      })
    ).statusCode,
  ).toBe(403);
  const files = f.files();
  expect(
    (await f.app.app.inject({ method: 'DELETE', url: f.base, headers }))
      .statusCode,
  ).toBe(200);
  expect((await f.search('backoff', 'include_stale')).hits).toHaveLength(0);
  for (const file of files) expect((await f.read(file)).statusCode).toBe(404);
  const candidate = files.find((file) => file.collection === 'derived')!;
  const mcp = await f.app.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...readerHeaders,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'context_read',
        arguments: {
          projectId: f.project.id,
          fileId: candidate.fileId,
          revisionId: candidate.revisionId,
        },
      },
    },
  });
  expect(mcp.json().error.message).toBe('NOT_FOUND');
  expect(mcp.body).not.toContain('bounded backoff');
});
