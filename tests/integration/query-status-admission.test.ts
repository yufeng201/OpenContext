import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { OpenContextClient } from '../../packages/http-client/src/index.ts';
import {
  QUERY_RESPONSE_MAX_BYTES,
  READ_RESPONSE_MAX_BYTES,
} from '../../packages/contracts/src/query-api.ts';
const sentinel = 'SYNTHETIC_PRIVATE_STATUS_SENTINEL';
const make = (response: Response) =>
  new OpenContextClient({
    baseUrl: 'http://localhost',
    token: 'synthetic-status-admission-token',
    fetch: async (_url, init) => {
      expect(init?.redirect).toBe('error');
      return response;
    },
  });
for (const status of [
  201, 202, 203, 204, 205, 206, 207, 208, 226, 301, 302, 303, 307, 308,
])
  it(`read HTTP${status} rejects before acquiring/consuming body, irrespective of declared length`, async () => {
    for (const length of [
      undefined,
      '0',
      'invalid',
      String(READ_RESPONSE_MAX_BYTES + 1),
    ]) {
      let pulls = 0,
        cancelled = false;
      const empty = status === 204 || status === 205;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            pulls++;
            const bytes = new Uint8Array(17 * 1024 * 1024).fill(32);
            bytes.set(new TextEncoder().encode('{}'), bytes.length - 2);
            c.enqueue(bytes);
            c.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const reader = vi.spyOn(stream, 'getReader');
      const response = new Response(empty ? null : stream, {
        status,
        headers: {
          'content-type': 'application/json',
          ...(length === undefined ? {} : { 'content-length': length }),
        },
      });
      const error = await make(response)
        .read('p', 'f', 'r')
        .catch((e) => e);
      expect(error).toMatchObject({
        code: 'INVALID_RESPONSE',
        message: 'INVALID_RESPONSE',
        status,
      });
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(reader).not.toHaveBeenCalled();
      expect(pulls).toBe(0);
      expect(stream.locked).toBe(false);
      if (!empty) expect(cancelled).toBe(true);
    }
  });
it('HTTP errors keep the small budget and cancel streams without trusting missing/forged length', async () => {
  for (const length of [
    undefined,
    '0',
    'invalid',
    String(QUERY_RESPONSE_MAX_BYTES + 1),
  ]) {
    let pulls = 0,
      cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(65536).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, {
      status: 500,
      headers: {
        'content-type': 'application/json',
        ...(length === undefined ? {} : { 'content-length': length }),
      },
    });
    await expect(make(response).read('p', 'f', 'r')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 500,
    });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(pulls).toBeLessThanOrEqual(QUERY_RESPONSE_MAX_BYTES / 65536 + 1);
    if (length === 'invalid' || length === String(QUERY_RESPONSE_MAX_BYTES + 1))
      expect(pulls).toBe(0);
  }
});
it('non-read unexpected success also rejects before consuming a body', async () => {
  let cancelled = false,
    pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(65536));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await expect(
    make(
      new Response(stream, {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    ).projects(),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 201 });
  expect(pulls).toBe(0);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

it('readiness keeps its explicit503 report exception and small encoded budget', async () => {
  const ok = { ok: true, code: 'OK' },
    report = {
      ready: false,
      checks: {
        database: { ok: false, code: 'DATABASE_UNAVAILABLE' },
        migration: ok,
        storage: ok,
        pluginState: ok,
        index: ok,
      },
      counts: { projects: 0, revisions: 0, pendingIndex: 0 },
      mode: 'demo',
      requestId: '00000000-0000-0000-0000-000000000000',
      scheduler: ok,
    };
  expect(
    await make(Response.json(report, { status: 503 })).readiness(),
  ).toEqual(report);
  let cancelled = false,
    pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(65536).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await expect(
    make(
      new Response(stream, {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    ).readiness(),
  ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE', status: 503 });
  expect(pulls).toBeLessThanOrEqual(QUERY_RESPONSE_MAX_BYTES / 65536 + 1);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
it('native HTTP redirect never follows its target and returns a safe transport error', async () => {
  let targetCalls = 0,
    requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === '/redirect-target') {
      targetCalls++;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } else res.writeHead(302, { location: '/redirect-target' }).end(sentinel);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('INVALID_ADDRESS');
  try {
    const client = new OpenContextClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'synthetic-redirect-test-token',
    });
    const error = await client.read('p', 'f', 'r').catch((e) => e);
    expect(error).toMatchObject({
      code: 'REQUEST_FAILED',
      message: 'REQUEST_FAILED',
    });
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(targetCalls).toBe(0);
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
