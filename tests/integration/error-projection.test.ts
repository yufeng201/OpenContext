import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  OpenContextClient,
  OpenContextError,
} from '../../packages/http-client/src/index.ts';
import { safeErrorCode } from '../../packages/contracts/src/errors.ts';
const secret = 'SYNTHETIC_PRIVATE_NATIVE_DIAGNOSTIC';
const uuid = '01234567-89ab-4cde-8fab-0123456789ab';
const sdk = (error: unknown) =>
  new OpenContextClient({
    baseUrl: 'http://localhost',
    token: 'synthetic-error-projection-token',
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(error);
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
function classified() {
  const error = new OpenContextError(502, 'INVALID_RESPONSE', uuid);
  Object.assign(error, {
    message: secret,
    name: secret,
    correlationId: secret,
    stack: secret,
    details: secret,
    cause: secret,
  });
  return error;
}
it('classified external stream error becomes a fresh closed SDK error, retaining only allowed code/status', async () => {
  const external = classified();
  const result = await sdk(external)
    .projects()
    .catch((e) => e);
  expect(result).not.toBe(external);
  expect(result).toMatchObject({
    name: 'OpenContextError',
    code: 'INVALID_RESPONSE',
    message: 'INVALID_RESPONSE',
    status: 502,
    correlationId: undefined,
  });
  expect(Object.keys(result).sort()).toEqual([
    'code',
    'correlationId',
    'name',
    'status',
  ]);
  expect(String(result) + JSON.stringify(result) + result.stack).not.toContain(
    secret,
  );
  expect(result.cause).toBeUndefined();
  expect(result.details).toBeUndefined();
});
it('valid UUID remains useful but mutable external message and diagnostic fields do not cross boundary', async () => {
  const external = classified();
  Object.assign(external, { correlationId: uuid });
  const result = await sdk(external)
    .projects()
    .catch((e) => e);
  expect(result).toMatchObject({
    code: 'INVALID_RESPONSE',
    status: 502,
    correlationId: uuid,
    message: 'INVALID_RESPONSE',
  });
  expect(JSON.stringify(result) + result.stack).not.toContain(secret);
});
for (const variant of [
  'accessors',
  'prototype-trap',
  'descriptor-trap',
  'revoked-proxy',
  'inherited-fields',
] as const)
  it(`${variant} error cannot execute getters/prototype traps or leak native diagnostics`, async () => {
    let reads = 0;
    const boom = () => {
      reads++;
      throw new Error(secret);
    };
    let external: unknown;
    if (variant === 'accessors') {
      external = {};
      for (const key of [
        'code',
        'message',
        'status',
        'correlationId',
        'name',
        'details',
        'cause',
        'stack',
      ])
        Object.defineProperty(external, key, { get: boom });
    } else if (variant === 'prototype-trap')
      external = new Proxy(new Error(secret), { getPrototypeOf: boom });
    else if (variant === 'descriptor-trap')
      external = new Proxy(new Error(secret), {
        getOwnPropertyDescriptor: boom,
      });
    else if (variant === 'revoked-proxy') {
      const pair = Proxy.revocable(new Error(secret), {});
      pair.revoke();
      external = pair.proxy;
    } else
      external = Object.create({
        get message() {
          return boom();
        },
        get code() {
          return boom();
        },
        get status() {
          return boom();
        },
        get correlationId() {
          return boom();
        },
      });
    const result = await sdk(external)
      .projects()
      .catch((e) => e);
    expect(result).toMatchObject({
      name: 'OpenContextError',
      code: 'INVALID_RESPONSE',
      message: 'INVALID_RESPONSE',
      correlationId: undefined,
    });
    expect(
      String(result) + JSON.stringify(result) + result.stack,
    ).not.toContain(secret);
    if (['accessors', 'inherited-fields', 'prototype-trap'].includes(variant))
      expect(reads).toBe(0);
  });
it('error constructor projects untrusted primitives without coercion or unsupported metadata', () => {
  const invalid = new OpenContextError(999, 'NOT_A_REVIEWED_CODE', secret);
  expect(invalid).toMatchObject({
    name: 'OpenContextError',
    status: 0,
    code: 'REQUEST_FAILED',
    message: 'REQUEST_FAILED',
    correlationId: undefined,
  });
  const hostile = {
    toString() {
      throw new Error(secret);
    },
    valueOf() {
      throw new Error(secret);
    },
  };
  const projected = new OpenContextError(
    hostile as unknown as number,
    hostile as unknown as string,
    hostile as unknown as string,
  );
  expect(projected).toMatchObject({
    status: 0,
    code: 'REQUEST_FAILED',
    correlationId: undefined,
  });
});
it('preserves reviewed platform codes and rejects arbitrary/overlong external codes without touching cause', () => {
  expect(
    safeErrorCode(new Error('POLICY_DENIED: ' + secret), 'PROCESSING_FAILED'),
  ).toBe('POLICY_DENIED');
  expect(
    safeErrorCode(
      {
        code: 'INVALID_RESPONSE',
        message: secret,
        cause: {
          get message() {
            throw new Error(secret);
          },
        },
      },
      'REQUEST_FAILED',
    ),
  ).toBe('INVALID_RESPONSE');
  expect(
    safeErrorCode(
      { code: 'INVALID_RESPONSE'.repeat(100), message: secret },
      'REQUEST_FAILED',
    ),
  ).toBe('REQUEST_FAILED');
  expect(
    safeErrorCode(
      new Proxy(new Error(secret), {
        getPrototypeOf() {
          throw new Error(secret);
        },
        getOwnPropertyDescriptor() {
          throw new Error(secret);
        },
      }),
      'REQUEST_FAILED',
    ),
  ).toBe('REQUEST_FAILED');
});
for (const mode of ['classified', 'accessors'] as const)
  it(`CLI reprojects ${mode} native error fields and never serializes the original`, () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-cli-projection-'));
    try {
      const preload = join(root, 'preload.mjs');
      const modulePath = new URL(
        '../../packages/http-client/src/index.ts',
        import.meta.url,
      ).href;
      writeFileSync(
        preload,
        `import {OpenContextError} from ${JSON.stringify(modulePath)};let e=new OpenContextError(502,'INVALID_RESPONSE','${uuid}');Object.assign(e,{message:'${secret}',name:'${secret}',correlationId:'${secret}',stack:'${secret}',details:'${secret}',cause:'${secret}'});${mode === 'accessors' ? `e=new Proxy(e,{getPrototypeOf(){throw new Error('${secret}')},getOwnPropertyDescriptor(){throw new Error('${secret}')}});` : ''}globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.error(e)}}),{headers:{'content-type':'application/json'}});`,
      );
      const child = spawnSync(
        process.execPath,
        ['--import', preload, 'scripts/opencontext.ts', 'projects'],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env['PATH'],
            OPENCONTEXT_URL: 'http://localhost',
            OPENCONTEXT_QUERY_TOKEN: 'synthetic-error-projection-token',
          },
          encoding: 'utf8',
          timeout: 3000,
        },
      );
      expect(child.status).toBe(1);
      const result = JSON.parse(child.stderr);
      expect(result.error).toBe('INVALID_RESPONSE');
      expect(result.correlationId).toBeUndefined();
      expect(
        Object.keys(result).every((key) =>
          ['error', 'status', 'correlationId'].includes(key),
        ),
      ).toBe(true);
      expect(child.stdout + child.stderr).not.toContain(secret);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
it('SDK client construction does not expose a native option getter exception', () => {
  const options = {
    baseUrl: 'http://localhost',
    get token(): string {
      throw new Error(secret);
    },
  };
  let result: unknown;
  try {
    new OpenContextClient(options);
  } catch (e) {
    result = e;
  }
  expect(result).toMatchObject({
    name: 'OpenContextError',
    code: 'REQUEST_FAILED',
    message: 'REQUEST_FAILED',
    status: 0,
    correlationId: undefined,
  });
  expect(
    String(result) + JSON.stringify(result) + (result as Error).stack,
  ).not.toContain(secret);
});
