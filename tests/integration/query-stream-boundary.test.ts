import { it, expect, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OpenContextClient } from '../../packages/http-client/src/index.ts';
const privateDiagnostic = 'SYNTHETIC_PRIVATE_UPSTREAM_DIAGNOSTIC';
const client = (
  fetch: typeof globalThis.fetch,
  timeoutMs = 15000,
  maxResponseBytes = 128,
) =>
  new OpenContextClient({
    baseUrl: 'http://localhost',
    token: 'synthetic-boundary-test-token',
    fetch,
    timeoutMs,
    maxResponseBytes,
  });
for (const mode of ['throw', 'reject'] as const)
  it(`transport ${mode} returns only stable SDK error fields`, async () => {
    const transport: typeof fetch = () => {
      if (mode === 'throw') throw new Error(privateDiagnostic);
      return Promise.reject(new Error(privateDiagnostic));
    };
    const error = await client(transport)
      .projects()
      .catch((error) => error);
    expect(error).toMatchObject({
      name: 'OpenContextError',
      code: 'REQUEST_FAILED',
      message: 'REQUEST_FAILED',
      status: 0,
      correlationId: undefined,
    });
    expect(String(error)).not.toContain(privateDiagnostic);
    expect(JSON.stringify(error)).not.toContain(privateDiagnostic);
  });
it('finite hot empty stream exceeds work budget, cancels and releases its reader', async () => {
  let pulls = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++pulls <= 100000) c.enqueue(new Uint8Array(0));
      else {
        c.enqueue(new TextEncoder().encode('[]'));
        c.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    client(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/json' },
        }),
    ).projects(),
  ).rejects.toMatchObject({ code: 'RESPONSE_WORK_LIMIT' });
  expect(pulls).toBeLessThan(10000);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
it('10ms absolute deadline rejects hot stream instead of accepting a late 2-byte result', async () => {
  let pulls = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++pulls <= 100000) c.enqueue(new Uint8Array(0));
      else {
        c.enqueue(new TextEncoder().encode('[]'));
        c.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const error = await client(
    async () =>
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
    10,
  )
    .projects()
    .catch((error) => error);
  expect(['TIMEOUT', 'RESPONSE_WORK_LIMIT']).toContain(error.code);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(10000);
  expect(stream.locked).toBe(false);
});
it('fine-grained ready byte stream respects work budget even below byte limit', async () => {
  let pulls = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++pulls <= 100000) c.enqueue(new Uint8Array([32]));
      else {
        c.enqueue(new TextEncoder().encode('[]'));
        c.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    client(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/json' },
        }),
      15000,
      200000,
    ).projects(),
  ).rejects.toMatchObject({ code: 'RESPONSE_WORK_LIMIT' });
  expect(pulls).toBeLessThan(10000);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
it('bounded empty chunks and fragmented valid body remain readable without retaining empty chunks', async () => {
  let pulls = 0;
  const parts = [
    ...Array.from({ length: 100 }, () => new Uint8Array(0)),
    new Uint8Array([91]),
    new Uint8Array([93]),
  ];
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      const part = parts[pulls++];
      if (part) c.enqueue(part);
      else c.close();
    },
  });
  expect(
    await client(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/json' },
        }),
    ).projects(),
  ).toEqual([]);
  expect(stream.locked).toBe(false);
});
it('scheduled cancellation gets an event-loop turn during hot zero-byte reads and discards raw reason', async () => {
  let pulls = 0,
    cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++pulls <= 100000) c.enqueue(new Uint8Array(0));
      else {
        c.enqueue(new TextEncoder().encode('[]'));
        c.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = client(
    async () =>
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
  ).projects({ signal: controller.signal });
  const timer = setTimeout(() => controller.abort(privateDiagnostic), 0);
  try {
    await expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
      message: 'CANCELLED',
    });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  } finally {
    clearTimeout(timer);
  }
});
it('absolute deadline detects elapsed time even when timer cannot run during synchronous transport', async () => {
  let now = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([91, 93]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, {
    headers: { 'content-type': 'application/json' },
  });
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    await expect(
      client(() => {
        now = 11;
        return Promise.resolve(response);
      }, 10).projects(),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  } finally {
    clock.mockRestore();
  }
});
it('final schema validation is included in absolute request deadline', async () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const stringify = JSON.stringify;
  const response = Response.json([]);
  const serialization = vi
    .spyOn(JSON, 'stringify')
    .mockImplementation((value, replacer, space) => {
      const result = stringify(value, replacer, space);
      now = 11;
      return result;
    });
  try {
    await expect(
      client(async () => response, 10).projects(),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  } finally {
    serialization.mockRestore();
    clock.mockRestore();
  }
});
it('slow stream cancels and releases resources at whole-request timeout', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([91]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    client(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/json' },
        }),
      30,
    ).projects(),
  ).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
it('CLI unknown uppercase native diagnostic is not an accepted machine code', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-cli-diagnostic-'));
  try {
    const preload = join(root, 'preload.cjs');
    writeFileSync(
      preload,
      `console.log=()=>{throw new Error('${privateDiagnostic}')};`,
    );
    const child = spawnSync(
      process.execPath,
      ['--require', preload, 'scripts/opencontext.ts', '--help'],
      {
        cwd: process.cwd(),
        env: { PATH: process.env['PATH'] },
        encoding: 'utf8',
        timeout: 3000,
      },
    );
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stderr)).toEqual({ error: 'REQUEST_FAILED' });
    expect(child.stdout + child.stderr).not.toContain(privateDiagnostic);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
