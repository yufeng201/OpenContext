import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { OpenContextClient } from '../../packages/http-client/src/index.ts';
import {
  parseQueryResponse,
  TreeSchema,
  QueryOpenApi,
} from '../../packages/contracts/src/query-api.ts';
const token = 'synthetic-response-test-token';
const text = '中文 pinned bytes';
const file = {
  fileId: 'f1',
  revisionId: 'r1',
  contentHash: createHash('sha256').update(text).digest('hex'),
  bytes: Buffer.byteLength(text),
  projectId: 'p1',
  bindingId: 'b1',
  slotKey: 'note',
  logicalPath: 'sources/note.md',
  collection: 'sources',
  ownership: 'source_managed',
  freshness: 'fresh',
  tombstone: false,
  sourceVersion: 'v1',
  createdAt: '2026-10-02T00:00:00Z',
  derivedFrom: [],
};
const citation = {
  uri: 'oc://space/p1/file/f1@r1',
  projectId: 'p1',
  fileId: 'f1',
  revisionId: 'r1',
  commitId: 'c1',
  path: file.logicalPath,
  contentHash: file.contentHash,
  sourceVersion: 'v1',
};
const make = (
  response: Response,
  opts: { timeoutMs?: number; maxResponseBytes?: number } = {},
) =>
  new OpenContextClient({
    baseUrl: 'http://localhost',
    token,
    fetch: async () => response,
    ...opts,
  });
for (const [name, value] of Object.entries({
  object: { secret: token },
  extra: [{ id: 'p1', name: 'A', head: null, createdAt: 'now', secret: token }],
  malformed: [{ id: 'p1', name: 2, head: null, createdAt: 'now' }],
}))
  it(`rejects malformed projects ${name} without echoing response`, async () => {
    try {
      await make(Response.json(value)).projects();
      throw new Error('EXPECTED_REJECTION');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_RESPONSE',
        message: 'INVALID_RESPONSE',
      });
      expect(JSON.stringify(error)).not.toContain(token);
    }
  });
it('valid pinned read verifies citation and actual UTF8 body hash', async () => {
  expect(
    await make(Response.json({ file, text, citation })).read('p1', 'f1', 'r1'),
  ).toEqual({ file, text, citation });
});
for (const [name, value] of Object.entries({
  wrongRevision: { file: { ...file, revisionId: 'r2' }, text, citation },
  crossSpace: { file: { ...file, projectId: 'p2' }, text, citation },
  badHash: {
    file: { ...file, contentHash: 'f'.repeat(64) },
    text,
    citation: { ...citation, contentHash: 'f'.repeat(64) },
  },
  wrongURI: {
    file,
    text,
    citation: { ...citation, uri: 'https://external.invalid/secret' },
  },
  extra: { file, text, citation, secret: token },
  tombstone: { file: { ...file, tombstone: true }, text, citation },
}))
  it(`rejects pinned read ${name}`, async () => {
    await expect(
      make(Response.json(value)).read('p1', 'f1', 'r1'),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
it('rejects success media type, unexpected status, bad JSON/UTF8 and declared/streamed oversize', async () => {
  await expect(make(new Response('[]')).projects()).rejects.toMatchObject({
    code: 'INVALID_RESPONSE_CONTENT_TYPE',
  });
  await expect(
    make(Response.json([], { status: 201 })).projects(),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(
    make(
      new Response(new Uint8Array([0xff]), {
        headers: { 'content-type': 'application/json' },
      }),
    ).projects(),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(
    make(
      new Response('[]', {
        headers: {
          'content-type': 'application/json',
          'content-length': '129',
        },
      }),
      { maxResponseBytes: 128 },
    ).projects(),
  ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  await expect(
    make(
      new Response(new Uint8Array(129), {
        headers: { 'content-type': 'application/json' },
      }),
      { maxResponseBytes: 128 },
    ).projects(),
  ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
});
it('accepts only shared strict safe error envelope and correlation UUID', async () => {
  const error = {
    code: 'FORBIDDEN',
    message: 'FORBIDDEN',
    correlationId: '00000000-0000-0000-0000-000000000000',
  };
  await expect(
    make(Response.json({ error }, { status: 403 })).projects(),
  ).rejects.toMatchObject({
    status: 403,
    code: 'FORBIDDEN',
    correlationId: error.correlationId,
  });
  for (const data of [
    { error: { ...error, message: token } },
    { error, secret: token },
    { error: { ...error, secret: token } },
  ])
    await expect(
      make(Response.json(data, { status: 403 })).projects(),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR', correlationId: undefined });
});
it('timeout and external cancellation cover noncooperative fetch and stalled body without raw abort reasons', async () => {
  let cancelled = false;
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('['));
      },
      cancel() {
        cancelled = true;
      },
    });
  await expect(
    make(
      new Response(stream(), {
        headers: { 'content-type': 'application/json' },
      }),
      { timeoutMs: 30 },
    ).projects(),
  ).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(cancelled).toBe(true);
  const c = new AbortController();
  const pending = make(
    new Response(stream(), { headers: { 'content-type': 'application/json' } }),
  ).projects({ signal: c.signal });
  c.abort(token);
  await expect(pending).rejects.toMatchObject({
    code: 'CANCELLED',
    message: 'CANCELLED',
  });
  const noncooperative = new OpenContextClient({
    baseUrl: 'http://localhost',
    token,
    timeoutMs: 20,
    fetch: () => new Promise(() => {}),
  });
  await expect(noncooperative.projects()).rejects.toMatchObject({
    code: 'TIMEOUT',
  });
});
it('schema rejects extra file fields and oversize/wrong-scope pages', () => {
  expect(() =>
    parseQueryResponse(TreeSchema, [{ ...file, secret: token }], {
      projectId: 'p1',
    }),
  ).toThrow('INVALID_RESPONSE');
  expect(
    QueryOpenApi.paths['/api/projects/{id}/search']?.post?.responses['200']
      ?.content['application/json'].schema,
  ).toMatchObject({ additionalProperties: false });
});
it('real HTTP delayed chunks time out in body phase and disconnect cleanly', async () => {
  const server = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('INVALID_ADDRESS');
  try {
    await expect(
      new OpenContextClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token,
        timeoutMs: 30,
      }).projects(),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it('authorized historical tombstoned source remains readable as stale while tree omits it', async () => {
  const historical = { ...file, tombstone: true, freshness: 'stale' };
  expect(
    (
      await make(Response.json({ file: historical, text, citation })).read(
        'p1',
        'f1',
        'r1',
      )
    ).text,
  ).toBe(text);
  expect(() =>
    parseQueryResponse(TreeSchema, [historical], { projectId: 'p1' }),
  ).toThrow('INVALID_RESPONSE');
});

it('explicit deleted source history may retain invalid freshness while invalid derived/current content is refused', async () => {
  const historical = { ...file, tombstone: true, freshness: 'invalid' };
  expect(
    (
      await make(Response.json({ file: historical, text, citation })).read(
        'p1',
        'f1',
        'r1',
      )
    ).text,
  ).toBe(text);
  for (const bad of [
    { ...historical, collection: 'derived' },
    { ...historical, tombstone: false },
  ])
    await expect(
      make(Response.json({ file: bad, text, citation })).read('p1', 'f1', 'r1'),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
