import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ConnectorInvocation } from '@opencontext/contracts';
import type { ExecutionContext } from '@opencontext/plugin-sdk';
import {
  createFeishuChatDefinition,
  type FeishuChatOptions,
} from '../src/index.ts';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const SECRET = 'SYNTHETIC_FEISHU_CREDENTIAL_NEVER_PERSIST';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const config = {
  realm: 'feishu',
  chatId: 'oc_synthetic',
  secretRef: 'secret:feishu/synthetic',
  startTime: '2026-09-30T00:00:00Z',
  endTime: 'now',
  overlapSeconds: '300',
};
const input = (previousVersion: string | null = null): ConnectorInvocation => ({
  config,
  previousVersion,
  imports: [],
  maxFiles: 500,
  maxBytes: 10_485_760,
});
const context = (
  ref = 'instance:synthetic@1',
  signal = new AbortController().signal,
): ExecutionContext => ({
  instanceRef: ref,
  signal,
  workDir: '/unused-feishu-work',
});
function message(
  id = 'om_one',
  text = 'Topic: Synthetic source',
  time = NOW - 1000,
): Record<string, unknown> {
  return {
    message_id: id,
    chat_id: 'oc_synthetic',
    create_time: String(time),
    update_time: String(time),
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    deleted: false,
  };
}
function page(items: unknown[], hasMore = false, token?: string): Response {
  return Response.json({
    code: 0,
    data: { items, has_more: hasMore, ...(token ? { page_token: token } : {}) },
  });
}
async function setup(
  fetcher: typeof fetch,
  extra: Partial<FeishuChatOptions> = {},
) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'opencontext-feishu-'));
  roots.push(stateRoot);
  const options: FeishuChatOptions = {
    stateRoot,
    fetch: fetcher,
    now: () => NOW,
    sleep: async () => undefined,
    resolveCredential: async () => SECRET,
    ...extra,
  };
  return {
    stateRoot,
    options,
    definition: createFeishuChatDefinition(options),
  };
}
const instanceDirectory = (
  root: string,
  ref = 'instance:synthetic@1',
): string => join(root, createHash('sha256').update(ref).digest('hex'));
async function stateText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? stateText(join(root, entry.name))
          : readFile(join(root, entry.name), 'utf8'),
      ),
    )
  ).join('\n');
}

describe('Feishu selected-group connector', () => {
  test('unconfirmed ready snapshot cannot first publish after credential or upstream permission revocation', async () => {
    let permitted = true;
    const revoked = await setup(async () => page([message()]), {
      resolveCredential: async () => (permitted ? SECRET : undefined),
    });
    await revoked.definition.invoke(input(), context());
    permitted = false;
    await expect(revoked.definition.invoke(input(), context())).rejects.toThrow(
      'SECRET_NOT_CONFIGURED',
    );
    let denied = false;
    const upstream = await setup(async () =>
      denied ? new Response('', { status: 403 }) : page([message()]),
    );
    await upstream.definition.invoke(input(), context());
    denied = true;
    await expect(
      upstream.definition.invoke(input(), context()),
    ).rejects.toThrow('PERMISSION_DENIED');
  });

  test('encoded copies of the known bearer credential cannot enter raw, normalized content or checkpoints', async () => {
    const encoded = SECRET.replace('S', '\\u0053');
    for (const payload of [
      JSON.stringify({
        code: 0,
        data: { items: [message('om_one', SECRET)], has_more: false },
      }).replaceAll(SECRET, encoded),
      JSON.stringify({
        code: 0,
        data: {
          items: [{ ...message(), body: { content: `{"text":"${encoded}"}` } }],
          has_more: false,
        },
      }),
    ]) {
      const scenario = await setup(
        async () =>
          new Response(payload, {
            headers: { 'content-type': 'application/json' },
          }),
      );
      await expect(
        scenario.definition.invoke(input(), context()),
      ).rejects.toThrow('SECRET_IN_RESPONSE');
      expect(await stateText(scenario.stateRoot)).not.toContain(SECRET);
      expect(
        await readdir(join(instanceDirectory(scenario.stateRoot), 'snapshots')),
      ).toEqual([]);
    }
  });
  test('a no-change same-version scan does not freeze future incremental polling', async () => {
    let clock = NOW;
    let calls = 0;
    const { definition } = await setup(
      async () => {
        calls += 1;
        return page([message()]);
      },
      { now: () => clock },
    );
    const first = await definition.invoke(input(), context());
    const same = await definition.invoke(input(first.sourceVersion), context());
    expect(same.sourceVersion).toBe(first.sourceVersion);
    clock += 60_000;
    const later = await definition.invoke(input(same.sourceVersion), context());
    expect(calls).toBe(3);
    expect(later.sourceVersion).not.toBe(same.sourceVersion);
  });
  test('reads fixed host/chat window, traverses discovered threads, deduplicates roots and marks simulated evidence', async () => {
    const calls: URL[] = [];
    const root = { ...message(), thread_id: 'omt_thread' };
    const { definition, stateRoot } = await setup(async (url, init) => {
      const parsed = new URL(String(url));
      calls.push(parsed);
      expect(parsed.origin).toBe('https://open.feishu.cn');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${SECRET}`,
      );
      if (parsed.searchParams.get('container_id_type') === 'thread') {
        expect(parsed.searchParams.has('start_time')).toBe(false);
        return page([root, message('om_reply', 'Action: Synthetic follow-up')]);
      }
      expect(parsed.searchParams.get('start_time')).toBe(
        String(Date.parse(config.startTime) / 1000),
      );
      expect(parsed.searchParams.get('end_time')).toBe(String(NOW / 1000));
      return page([root]);
    });
    const result = await definition.invoke(input(), context());
    expect(result.files).toHaveLength(2);
    expect(result.sourceVersion).toMatch(/^fs1:[a-f0-9]{64}$/);
    expect(
      result.files.every(
        (file) => JSON.parse(file.content).evidence === 'simulated',
      ),
    ).toBe(true);
    expect(calls).toHaveLength(2);
    expect(await stateText(stateRoot)).not.toContain(SECRET);
    const replay = await definition.invoke(input(), context());
    expect(replay).toEqual(result);
    expect(calls).toHaveLength(3); // Recheck current chat permission before replaying the unconfirmed proposal.
  });

  test('continues an empty page with has_more and durably resumes a failed page after factory restart', async () => {
    const calls: string[] = [];
    const first = await setup(async (url) => {
      const token = new URL(String(url)).searchParams.get('page_token') ?? '';
      calls.push(token);
      if (!token) return page([], true, 'next-page');
      return new Response('failure body must not leak', { status: 503 });
    });
    await expect(first.definition.invoke(input(), context())).rejects.toThrow(
      'UPSTREAM_UNAVAILABLE',
    );
    expect(calls).toEqual(['', 'next-page', 'next-page', 'next-page']);
    const pending = JSON.parse(
      await readFile(
        join(instanceDirectory(first.stateRoot), 'pending.json'),
        'utf8',
      ),
    );
    expect(pending.baseVersion).toBeNull();
    expect(pending.pages).toBe(1);
    expect(pending.queue[0].pageToken).toBe('next-page');
    const resumed = createFeishuChatDefinition({
      ...first.options,
      fetch: async (url) => {
        expect(new URL(String(url)).searchParams.get('page_token')).toBe(
          'next-page',
        );
        return page([message()]);
      },
    });
    expect((await resumed.invoke(input(), context())).files).toHaveLength(1);
  });

  test('advances overlap only from confirmed version and keeps absent historical messages', async () => {
    let clock = NOW;
    const starts: string[] = [];
    let items = [message()];
    const { definition } = await setup(
      async (url) => {
        starts.push(new URL(String(url)).searchParams.get('start_time')!);
        return page(items);
      },
      { now: () => clock },
    );
    const first = await definition.invoke(input(), context());
    clock += 60_000;
    items = [];
    const next = await definition.invoke(input(first.sourceVersion), context());
    expect(next.files).toHaveLength(1);
    expect(starts[1]).toBe(String(NOW / 1000 - 300));
    clock += 86_400_000;
    await definition.invoke(input(next.sourceVersion), context());
    expect(starts[2]).toBe(String(Date.parse(config.startTime) / 1000));
  });

  test('accepts newer versions, ignores older ones and removes explicit deletions without storing deleted body in the current snapshot', async () => {
    let current: Record<string, unknown> = message(
      'om_one',
      'OLD_SYNTHETIC_BODY',
    );
    const { definition, stateRoot } = await setup(async () => page([current]));
    const first = await definition.invoke(input(), context());
    current = {
      ...current,
      update_time: String(NOW),
      body: { content: JSON.stringify({ text: 'NEW_SYNTHETIC_BODY' }) },
    };
    const updated = await definition.invoke(
      input(first.sourceVersion),
      context(),
    );
    expect(updated.files[0]?.content).toContain('NEW_SYNTHETIC_BODY');
    current = { ...current, update_time: String(NOW + 1), deleted: true };
    const deleted = await definition.invoke(
      input(updated.sourceVersion),
      context(),
    );
    expect(deleted.files).toEqual([]);
    const snapshot = await readFile(
      join(
        instanceDirectory(stateRoot),
        'snapshots',
        `${deleted.sourceVersion.slice(4)}.json`,
      ),
      'utf8',
    );
    expect(snapshot).toContain('"kind":"deleted"');
    expect(snapshot).not.toContain('SYNTHETIC_BODY');
    current = message('om_one', 'LATE_OLD_BODY');
    expect(
      (await definition.invoke(input(deleted.sourceVersion), context())).files,
    ).toEqual([]);
  });

  test('rejects same-version conflicts, wrong group, malformed text and unsafe IDs atomically', async () => {
    for (const items of [
      [message(), message('om_one', 'conflict')],
      [{ ...message(), chat_id: 'oc_other' }],
      [{ ...message(), body: { content: '{bad-json' } }],
      [{ ...message(), message_id: '__proto__' }],
      [{ ...message(), update_time: -1 }],
    ]) {
      const { definition, stateRoot } = await setup(async () => page(items));
      await expect(definition.invoke(input(), context())).rejects.toThrow();
      expect(
        await readdir(join(instanceDirectory(stateRoot), 'snapshots')),
      ).toEqual([]);
    }
  });

  test('retains nontext raw metadata, normalizes safe numeric timestamps and excludes out-of-window thread replies', async () => {
    const root = {
      ...message(),
      thread_id: 'omt_thread',
      create_time: NOW - 1000,
      update_time: undefined,
    };
    const { definition } = await setup(async (url) =>
      new URL(String(url)).searchParams.get('container_id_type') === 'chat'
        ? page([root])
        : page([
            message('om_old', 'outside', Date.parse(config.startTime) - 1),
            {
              ...message('om_image'),
              msg_type: 'image',
              body: { content: '{"image_key":"synthetic"}' },
            },
          ]),
    );
    const result = await definition.invoke(input(), context());
    expect(result.files).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    const records = result.files.map((file) => JSON.parse(file.content));
    expect(
      records.find((record) => record.messageId === 'om_one').raw.create_time,
    ).toBe(NOW - 1000);
    expect(
      records.find((record) => record.messageId === 'om_one').updateTime,
    ).toBe(String(NOW - 1000));
    expect(records.find((record) => record.messageId === 'om_image').text).toBe(
      '',
    );
  });

  test('connection tests do not create state and distinguish credentials, permissions, region and bounded retries', async () => {
    const missing = await setup(
      async () => {
        throw new Error('must not request');
      },
      { resolveCredential: async () => undefined },
    );
    expect(
      await missing.definition.testConnection!(config, {
        signal: context().signal,
      }),
    ).toEqual({
      status: 'blocked',
      evidence: 'simulated',
      code: 'SECRET_NOT_CONFIGURED',
    });
    expect(await readdir(missing.stateRoot)).toEqual([]);
    const denied = await setup(
      async () => new Response(SECRET, { status: 403 }),
    );
    expect(
      await denied.definition.testConnection!(config, {
        signal: context().signal,
      }),
    ).toMatchObject({ status: 'blocked', code: 'PERMISSION_DENIED' });
    let calls = 0;
    const waits: number[] = [];
    const retry = await setup(
      async (url) => {
        expect(new URL(String(url)).host).toBe('open.larksuite.com');
        calls += 1;
        return calls < 3
          ? new Response('', { status: 429, headers: { 'retry-after': '999' } })
          : page([]);
      },
      {
        sleep: async (delay) => {
          waits.push(delay);
        },
      },
    );
    expect(
      await retry.definition.testConnection!(
        { ...config, realm: 'lark' },
        { signal: context().signal },
      ),
    ).toMatchObject({ status: 'reachable', evidence: 'simulated' });
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 2000]);
    const wrongChat = await setup(async () =>
      page([{ ...message(), chat_id: 'oc_other' }]),
    );
    expect(
      await wrongChat.definition.testConnection!(config, {
        signal: context().signal,
      }),
    ).toEqual({
      status: 'error',
      evidence: 'simulated',
      code: 'CHAT_MISMATCH',
    });
    expect(await readdir(wrongChat.stateRoot)).toEqual([]);
  });

  test('rejects repeated/missing pagination tokens and excessive complete-set output', async () => {
    const repeated = await setup(async () => page([], true, 'same'));
    await expect(
      repeated.definition.invoke(input(), context()),
    ).rejects.toThrow('REPEATED_PAGE_TOKEN');
    const missing = await setup(async () => page([], true));
    await expect(missing.definition.invoke(input(), context())).rejects.toThrow(
      'INVALID_PAGE_TOKEN',
    );
    const limit = await setup(async () => page([message(), message('om_two')]));
    await expect(
      limit.definition.invoke({ ...input(), maxFiles: 1 }, context()),
    ).rejects.toThrow('SNAPSHOT_LIMIT');
  });

  test('invalid page token restarts the same fixed window at most once without discarding confirmed records', async () => {
    let calls = 0;
    const windows: string[] = [];
    const { definition } = await setup(async (url) => {
      const parsed = new URL(String(url));
      windows.push(parsed.searchParams.get('end_time')!);
      calls += 1;
      if (calls === 1) return page([message()], true, 'expired');
      if (calls === 2) return new Response('', { status: 400 });
      return page([message(), message('om_two')]);
    });
    expect((await definition.invoke(input(), context())).files).toHaveLength(2);
    expect(calls).toBe(3);
    expect(new Set(windows).size).toBe(1);
  });

  test('HTTP 200 API error with a token restarts once, re-resolving credentials, then fails without guessing vendor code', async () => {
    let calls = 0;
    let credentials = 0;
    const { definition } = await setup(
      async (url) => {
        calls += 1;
        return new URL(String(url)).searchParams.has('page_token')
          ? Response.json({ code: 912345, msg: 'upstream private diagnostic' })
          : page([], true, 'expired');
      },
      {
        resolveCredential: async () => {
          credentials += 1;
          return SECRET;
        },
      },
    );
    await expect(definition.invoke(input(), context())).rejects.toThrow(
      'FEISHU_API_ERROR',
    );
    expect(calls).toBe(4);
    expect(credentials).toBe(4);
  });

  test('serializes same-instance factories and leaves connection tests outside checkpoint state', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { definition, options } = await setup(async () => {
      entered();
      await gate;
      return page([]);
    });
    const run = definition.invoke(input(), context());
    await started;
    await expect(
      createFeishuChatDefinition(options).invoke(input(), context()),
    ).rejects.toThrow('INSTANCE_BUSY');
    release();
    await run;
  });

  test('fails closed on hard page/message/body budgets and invalid connection configuration', async () => {
    let calls = 0;
    const pages = await setup(async () => page([], true, `page-${++calls}`));
    await expect(pages.definition.invoke(input(), context())).rejects.toThrow(
      'PAGE_LIMIT',
    );
    expect(calls).toBe(100);
    const messages = await setup(async () =>
      page(Array.from({ length: 501 }, (_, i) => message(`om_${i}`))),
    );
    await expect(
      messages.definition.invoke(input(), context()),
    ).rejects.toThrow('SCAN_LIMIT');
    const body = await setup(async () => new Response('x'.repeat(2_097_153)));
    await expect(body.definition.invoke(input(), context())).rejects.toThrow(
      'RESPONSE_TOO_LARGE',
    );
    for (const patch of [
      { realm: 'custom' },
      { chatId: 'other' },
      { secretRef: SECRET },
      { overlapSeconds: '3601' },
      { startTime: 'invalid' },
      { endTime: '2027-01-01T00:00:00Z' },
    ])
      expect(() =>
        pages.definition.validateConfig!({ ...config, ...patch }, {}),
      ).toThrow('INVALID_CONFIG');
  });

  test('missing confirmed snapshot fails closed; instance identities never share state', async () => {
    const { definition, stateRoot } = await setup(async () =>
      page([message()]),
    );
    const first = await definition.invoke(input(), context());
    await expect(
      definition.invoke(
        input(first.sourceVersion),
        context('instance:other@1'),
      ),
    ).rejects.toThrow('CHECKPOINT_MISSING');
    await unlink(
      join(
        instanceDirectory(stateRoot),
        'snapshots',
        `${first.sourceVersion.slice(4)}.json`,
      ),
    );
    await expect(
      definition.invoke(input(first.sourceVersion), context()),
    ).rejects.toThrow('CHECKPOINT_MISSING');
  });

  test('cancellation and secret-bearing responses cannot publish snapshots or persist credential bytes', async () => {
    const controller = new AbortController();
    const cancelled = await setup(async () => {
      controller.abort();
      return page([message()]);
    });
    await expect(
      cancelled.definition.invoke(
        input(),
        context('instance:synthetic@1', controller.signal),
      ),
    ).rejects.toThrow('CANCELLED');
    expect(
      await readdir(join(instanceDirectory(cancelled.stateRoot), 'snapshots')),
    ).toEqual([]);
    for (const raw of [
      { ...message(), authorization: SECRET },
      message('om_one', SECRET),
    ]) {
      const rejected = await setup(async () => page([raw]));
      await expect(
        rejected.definition.invoke(input(), context()),
      ).rejects.toThrow('SECRET_IN_RESPONSE');
      expect(await stateText(rejected.stateRoot)).not.toContain(SECRET);
    }
  });
});
