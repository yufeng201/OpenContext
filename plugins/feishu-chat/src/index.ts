import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  FeishuChatMessageSchema,
  type FeishuChatMessage,
  type ConnectorInvocation,
  type ConnectorOutput,
} from '@opencontext/contracts';
import type {
  ConnectorDefinition,
  ExecutionContext,
} from '@opencontext/plugin-sdk';

type Realm = 'feishu' | 'lark';
export type FeishuChatOptions = {
  stateRoot: string;
  resolveCredential(
    ref: string,
    scope: { realm: Realm; chatId: string },
  ): Promise<string | undefined>;
  fetch?: typeof fetch;
  evidence?: 'live' | 'simulated';
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};
const VERSION = '0.1.0';
const MAX_PAGES = 100;
const MAX_MESSAGES = 500;
const MAX_BYTES = 10 * 1024 * 1024;
const PAGE_BYTES = 2 * 1024 * 1024;
// One host lifetime is enforced by Catalog; this also serializes factories in
// that process. Cross-process reuse of this private state root is unsupported.
const active = new Set<string>();
const DIGITS = /^[0-9]{1,16}$/;
const sha = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const configSchema = Type.Object(
  {
    realm: Type.Union([Type.Literal('feishu'), Type.Literal('lark')]),
    chatId: Type.String({ pattern: '^oc_[A-Za-z0-9_-]{1,150}$' }),
    secretRef: Type.String({ pattern: '^secret:feishu/[a-z0-9_-]{1,40}$' }),
    startTime: Type.String({ minLength: 20, maxLength: 30 }),
    endTime: Type.String({ minLength: 3, maxLength: 30 }),
    overlapSeconds: Type.String({ pattern: '^[0-9]{1,4}$', default: '300' }),
  },
  { additionalProperties: false },
);
type Config = Static<typeof configSchema>;
const storedSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('message'), message: FeishuChatMessageSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('deleted'),
      messageId: Type.String(),
      updateTime: Type.String({ pattern: '^[0-9]+$' }),
    },
    { additionalProperties: false },
  ),
]);
type Stored = Static<typeof storedSchema>;
const snapshotSchema = Type.Object(
  {
    schema: Type.Literal('opencontext.feishu-snapshot/v1'),
    pluginVersion: Type.Literal(VERSION),
    configHash: Type.String(),
    realm: Type.Union([Type.Literal('feishu'), Type.Literal('lark')]),
    chatId: Type.String(),
    watermark: Type.String({ pattern: '^[0-9]+$' }),
    lastFullAt: Type.Number(),
    records: Type.Record(Type.String(), storedSchema, {
      maxProperties: MAX_MESSAGES,
    }),
  },
  { additionalProperties: false },
);
type Snapshot = Static<typeof snapshotSchema>;
const containerSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('chat'), Type.Literal('thread')]),
    id: Type.String(),
    pageToken: Type.Union([Type.String(), Type.Null()]),
    seenTokens: Type.Array(Type.String(), { maxItems: MAX_PAGES }),
  },
  { additionalProperties: false },
);
const pendingSchema = Type.Object(
  {
    schema: Type.Literal('opencontext.feishu-pending/v1'),
    pluginVersion: Type.Literal(VERSION),
    configHash: Type.String(),
    realm: Type.Union([Type.Literal('feishu'), Type.Literal('lark')]),
    chatId: Type.String(),
    baseVersion: Type.Union([Type.String(), Type.Null()]),
    scanStart: Type.String(),
    scanEnd: Type.String(),
    full: Type.Boolean(),
    startedAt: Type.Number(),
    queue: Type.Array(containerSchema, { maxItems: MAX_MESSAGES + 1 }),
    seenThreads: Type.Array(Type.String(), { maxItems: MAX_MESSAGES }),
    pages: Type.Integer({ minimum: 0, maximum: MAX_PAGES }),
    scanned: Type.Integer({ minimum: 0, maximum: MAX_MESSAGES }),
    bytes: Type.Integer({ minimum: 0, maximum: MAX_BYTES }),
    restarted: Type.Boolean(),
    records: Type.Record(Type.String(), storedSchema, {
      maxProperties: MAX_MESSAGES,
    }),
    readyVersion: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
type Pending = Static<typeof pendingSchema>;

class ConnectorError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`${code}: Feishu connector could not complete the operation`);
    this.code = code;
  }
}
function fail(code: string): never {
  throw new ConnectorError(code);
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) fail('CANCELLED');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    fail('INVALID_RESPONSE');
  return value;
}
function digits(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (typeof value !== 'string' || !DIGITS.test(value))
    fail('INVALID_RESPONSE');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function timestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    fail('INVALID_CONFIG');
  const result = Date.parse(value);
  if (
    !Number.isFinite(result) ||
    new Date(result).toISOString().replace('.000Z', 'Z') !==
      value.replace('.000Z', 'Z')
  )
    fail('INVALID_CONFIG');
  return Math.floor(result / 1000);
}
function configuration(
  value: Record<string, unknown>,
  now: number,
): { config: Config; start: number; end: number } {
  if (!Value.Check(configSchema, value) || Number(value.overlapSeconds) > 3600)
    fail('INVALID_CONFIG');
  const start = timestamp(value.startTime);
  const end =
    value.endTime === 'now' ? Math.floor(now / 1000) : timestamp(value.endTime);
  if (start >= end || end > Math.floor(now / 1000)) fail('INVALID_CONFIG');
  return { config: value, start, end };
}
async function durable(
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  cancelled(signal);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    cancelled(signal);
    await rename(temporary, path);
    const directory = await open(join(path, '..'), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
async function readState(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > 3 * MAX_BYTES) fail('CHECKPOINT_CORRUPT');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function parseState(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    fail('CHECKPOINT_CORRUPT');
  }
}
function secretScreen(value: unknown, token: string, depth = 0): void {
  if (depth > 64) fail('INVALID_RESPONSE');
  if (typeof value === 'string') {
    if (value.includes(token)) fail('SECRET_IN_RESPONSE');
    // body.content and tool metadata can contain another JSON document. Screen
    // decoded strings as well as wire bytes, including Unicode escape spelling.
    if (['[', '{', '"'].includes(value.trimStart().charAt(0))) {
      let nested: unknown;
      try {
        nested = JSON.parse(value);
      } catch {
        return;
      }
      secretScreen(nested, token, depth + 1);
    }
  } else if (Array.isArray(value))
    for (const entry of value) secretScreen(entry, token, depth + 1);
  else if (value && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(?:authorization|access_token|refresh_token|app_secret|client_secret)$/i.test(
          key,
        )
      )
        fail('SECRET_IN_RESPONSE');
      secretScreen(entry, token, depth + 1);
    }
}

type Page = {
  items: unknown[];
  hasMore: boolean;
  next: string | null;
  bytes: number;
};
function responseCode(code: number): string {
  // Do not infer authorization/rate-limit semantics from undocumented vendor codes.
  return code === 0 ? 'OK' : 'FEISHU_API_ERROR';
}

export function createFeishuChatDefinition(
  options: FeishuChatOptions,
): ConnectorDefinition {
  const request = options.fetch ?? globalThis.fetch;
  const evidence = options.evidence ?? (options.fetch ? 'simulated' : 'live');
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (milliseconds, signal) => {
      await wait(milliseconds, undefined, { signal });
    });

  async function page(
    config: Config,
    container: Static<typeof containerSchema>,
    start: string,
    end: string,
    signal: AbortSignal,
    pageSize = 50,
  ): Promise<Page> {
    cancelled(signal);
    let token: string | undefined;
    try {
      token = await options.resolveCredential(config.secretRef, {
        realm: config.realm,
        chatId: config.chatId,
      });
    } catch {
      fail('SECRET_UNAVAILABLE');
    }
    if (!token) fail('SECRET_NOT_CONFIGURED');
    if (token.length > 8192 || /[\r\n]/.test(token)) fail('SECRET_INVALID');
    const domain =
      config.realm === 'feishu' ? 'open.feishu.cn' : 'open.larksuite.com';
    const url = new URL(`https://${domain}/open-apis/im/v1/messages`);
    url.searchParams.set('container_id_type', container.type);
    url.searchParams.set('container_id', container.id);
    url.searchParams.set('page_size', String(pageSize));
    if (container.type === 'chat') {
      url.searchParams.set('start_time', start);
      url.searchParams.set('end_time', end);
      url.searchParams.set('sort_type', 'ByCreateTimeAsc');
    }
    if (container.pageToken)
      url.searchParams.set('page_token', container.pageToken);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      cancelled(signal);
      let response: Response;
      try {
        response = await request(url, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
      } catch {
        if (signal.aborted) fail('CANCELLED');
        fail('NETWORK_ERROR');
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt === 2)
          fail(
            response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE',
          );
        const retry = Number(response.headers.get('retry-after'));
        try {
          await sleep(
            Number.isFinite(retry) && retry > 0
              ? Math.min(retry * 1000, 2000)
              : 100 * 2 ** attempt,
            signal,
          );
        } catch {
          if (signal.aborted) fail('CANCELLED');
          fail('RETRY_INTERRUPTED');
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) fail('AUTH_FAILED');
        if (response.status === 403) fail('PERMISSION_DENIED');
        if (response.status === 400 && container.pageToken)
          fail('PAGE_TOKEN_INVALID');
        fail('UPSTREAM_REJECTED');
      }
      if (!response.body) fail('INVALID_RESPONSE');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          cancelled(signal);
          bytes += chunk.value.byteLength;
          if (bytes > PAGE_BYTES) fail('RESPONSE_TOO_LARGE');
          chunks.push(chunk.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        if (error instanceof ConnectorError) throw error;
        if (signal.aborted) fail('CANCELLED');
        fail('NETWORK_ERROR');
      } finally {
        reader.releaseLock();
      }
      let raw: string;
      try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks),
        );
      } catch {
        fail('INVALID_RESPONSE');
      }
      if (raw.includes(token)) fail('SECRET_IN_RESPONSE');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail('INVALID_RESPONSE');
      }
      secretScreen(parsed, token);
      const body = object(parsed);
      if (typeof body['code'] !== 'number') fail('INVALID_RESPONSE');
      if (body['code'] !== 0) fail(responseCode(body['code']));
      const data = object(body['data']);
      if (
        !Array.isArray(data['items']) ||
        typeof data['has_more'] !== 'boolean'
      )
        fail('INVALID_RESPONSE');
      for (const entry of data['items']) {
        const item = object(entry);
        if (item['chat_id'] !== undefined && item['chat_id'] !== config.chatId)
          fail('CHAT_MISMATCH');
      }
      const next = data['has_more'] ? data['page_token'] : null;
      if (
        next !== null &&
        (typeof next !== 'string' || next.length < 1 || next.length > 2000)
      )
        fail('INVALID_PAGE_TOKEN');
      return {
        items: data['items'],
        hasMore: data['has_more'],
        next: next as string | null,
        bytes,
      };
    }
    fail('UPSTREAM_UNAVAILABLE');
  }

  function output(
    snapshot: Snapshot,
    version: string,
    input: ConnectorInvocation,
  ): ConnectorOutput {
    const files: ConnectorOutput['files'] = [];
    const skipped: ConnectorOutput['skipped'] = [];
    let bytes = 0;
    for (const [messageId, stored] of Object.entries(snapshot.records).sort(
      ([a], [b]) => a.localeCompare(b, 'en'),
    )) {
      if (stored.kind === 'deleted') continue;
      const relativePath = `chats/${sha(snapshot.chatId)}/messages/${sha(messageId)}.json`;
      const content = `${canonical(stored.message)}\n`;
      bytes += Buffer.byteLength(content);
      if (
        files.length >= input.maxFiles ||
        bytes > input.maxBytes ||
        bytes > MAX_BYTES
      )
        fail('SNAPSHOT_LIMIT');
      files.push({ relativePath, content, mime: 'text/plain' });
      if (stored.message.messageType !== 'text')
        skipped.push({
          path: relativePath,
          reason: 'unsupported_message_type_raw_only',
        });
    }
    return {
      sourceVersion: version,
      complete: true,
      files,
      renames: [],
      skipped,
    };
  }

  async function invoke(
    input: ConnectorInvocation,
    context: ExecutionContext,
  ): Promise<ConnectorOutput> {
    cancelled(context.signal);
    const { config, start, end } = configuration(input.config, now());
    if (
      !context.instanceRef ||
      input.imports.length > 0 ||
      !Number.isSafeInteger(input.maxFiles) ||
      input.maxFiles < 1 ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1
    )
      fail('INVALID_CONFIG');
    const configHash = sha(canonical(config));
    const directory = join(options.stateRoot, sha(context.instanceRef));
    if (active.has(directory)) fail('INSTANCE_BUSY');
    active.add(directory);
    try {
      await mkdir(join(directory, 'snapshots'), {
        recursive: true,
        mode: 0o700,
      });
      for (const path of [
        join(directory, 'snapshots'),
        directory,
        options.stateRoot,
        join(options.stateRoot, '..'),
      ]) {
        const handle = await open(path, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const loadSnapshot = async (version: string): Promise<Snapshot> => {
        if (!/^fs1:[a-f0-9]{64}$/.test(version)) fail('CHECKPOINT_MISSING');
        const raw = await readState(
          join(directory, 'snapshots', `${version.slice(4)}.json`),
        );
        if (raw === null) fail('CHECKPOINT_MISSING');
        if (sha(raw) !== version.slice(4)) fail('CHECKPOINT_CORRUPT');
        const value = parseState(raw);
        if (
          !Value.Check(snapshotSchema, value) ||
          value.configHash !== configHash ||
          value.chatId !== config.chatId ||
          value.realm !== config.realm
        )
          fail('CHECKPOINT_CORRUPT');
        return value;
      };
      const base = input.previousVersion
        ? await loadSnapshot(input.previousVersion)
        : null;
      const pendingPath = join(directory, 'pending.json');
      const saved = await readState(pendingPath);
      let pending: Pending | null = null;
      if (saved !== null) {
        const parsed = parseState(saved);
        if (!Value.Check(pendingSchema, parsed)) fail('CHECKPOINT_CORRUPT');
        if (
          parsed.baseVersion === input.previousVersion &&
          parsed.configHash === configHash &&
          parsed.realm === config.realm &&
          parsed.chatId === config.chatId
        )
          pending = parsed;
      }
      if (
        pending?.readyVersion &&
        pending.readyVersion === input.previousVersion
      )
        pending = null;
      if (pending?.readyVersion) {
        // A locally staged snapshot is not authorization to publish. Recheck the
        // currently scoped credential and upstream chat access before replay.
        await page(
          config,
          { type: 'chat', id: config.chatId, pageToken: null, seenTokens: [] },
          pending.scanStart,
          pending.scanEnd,
          context.signal,
          1,
        );
        cancelled(context.signal);
        return output(
          await loadSnapshot(pending.readyVersion),
          pending.readyVersion,
          input,
        );
      }
      if (!pending) {
        const full = !base || now() - base.lastFullAt >= 86_400_000;
        pending = {
          schema: 'opencontext.feishu-pending/v1',
          pluginVersion: VERSION,
          configHash,
          realm: config.realm,
          chatId: config.chatId,
          baseVersion: input.previousVersion,
          scanStart: String(
            full
              ? start
              : Math.max(
                  start,
                  Number(base.watermark) - Number(config.overlapSeconds),
                ),
          ),
          scanEnd: String(end),
          full,
          startedAt: now(),
          queue: [
            {
              type: 'chat',
              id: config.chatId,
              pageToken: null,
              seenTokens: [],
            },
          ],
          seenThreads: [],
          pages: 0,
          scanned: 0,
          bytes: 0,
          restarted: false,
          records: base ? structuredClone(base.records) : {},
          readyVersion: null,
        };
        await durable(pendingPath, canonical(pending), context.signal);
      }
      while (pending.queue.length > 0) {
        cancelled(context.signal);
        if (pending.pages >= MAX_PAGES) fail('PAGE_LIMIT');
        const container = pending.queue[0]!;
        let received: Page;
        try {
          received = await page(
            config,
            container,
            pending.scanStart,
            pending.scanEnd,
            context.signal,
          );
        } catch (error) {
          if (
            error instanceof ConnectorError &&
            (error.code === 'PAGE_TOKEN_INVALID' ||
              (error.code === 'FEISHU_API_ERROR' &&
                container.pageToken !== null)) &&
            !pending.restarted
          ) {
            pending.queue = [
              {
                type: 'chat',
                id: config.chatId,
                pageToken: null,
                seenTokens: [],
              },
            ];
            pending.seenThreads = [];
            pending.records = base ? structuredClone(base.records) : {};
            pending.pages = 0;
            pending.scanned = 0;
            pending.bytes = 0;
            pending.restarted = true;
            await durable(pendingPath, canonical(pending), context.signal);
            continue;
          }
          throw error;
        }
        if (
          pending.scanned + received.items.length > MAX_MESSAGES ||
          pending.bytes + received.bytes > MAX_BYTES
        )
          fail('SCAN_LIMIT');
        const next: Pending = structuredClone(pending);
        next.pages += 1;
        next.scanned += received.items.length;
        next.bytes += received.bytes;
        for (const entry of received.items) {
          const raw = object(entry);
          if (raw['chat_id'] !== undefined && raw['chat_id'] !== config.chatId)
            fail('CHAT_MISMATCH');
          const messageId = identifier(raw['message_id']);
          const createTime = digits(raw['create_time']);
          const updateTime =
            raw['update_time'] === undefined
              ? createTime
              : digits(raw['update_time']);
          if (
            raw['deleted'] !== undefined &&
            typeof raw['deleted'] !== 'boolean'
          )
            fail('INVALID_RESPONSE');
          // Thread API has no time filter; enforce the same fixed snapshot window here.
          if (
            BigInt(createTime) < BigInt(next.scanStart) * 1000n ||
            BigInt(createTime) > BigInt(next.scanEnd) * 1000n
          )
            continue;
          if (container.type === 'chat' && raw['thread_id']) {
            const threadId = identifier(raw['thread_id']);
            if (!next.seenThreads.includes(threadId)) {
              next.seenThreads.push(threadId);
              next.queue.push({
                type: 'thread',
                id: threadId,
                pageToken: null,
                seenTokens: [],
              });
            }
          }
          let stored: Stored;
          if (raw['deleted'] === true)
            stored = { kind: 'deleted', messageId, updateTime };
          else {
            const messageType = identifier(raw['msg_type']);
            let text = '';
            if (messageType === 'text') {
              const body = object(raw['body']);
              if (typeof body['content'] !== 'string') fail('INVALID_RESPONSE');
              let content: unknown;
              try {
                content = JSON.parse(body['content']);
              } catch {
                fail('INVALID_RESPONSE');
              }
              const value = object(content)['text'];
              if (typeof value !== 'string') fail('INVALID_RESPONSE');
              text = value;
            }
            const message: FeishuChatMessage = {
              schema: 'opencontext.feishu-chat-message/v1',
              realm: config.realm,
              evidence,
              chatId: config.chatId,
              messageId,
              createTime,
              updateTime,
              messageType,
              text,
              raw,
            };
            if (!Value.Check(FeishuChatMessageSchema, message))
              fail('INVALID_RESPONSE');
            stored = { kind: 'message', message };
          }
          const previous = next.records[messageId];
          const previousTime =
            previous?.kind === 'message'
              ? previous.message.updateTime
              : previous?.updateTime;
          if (previous && previousTime) {
            if (BigInt(updateTime) < BigInt(previousTime)) continue;
            if (BigInt(updateTime) === BigInt(previousTime)) {
              if (canonical(previous) !== canonical(stored))
                fail('MESSAGE_VERSION_CONFLICT');
              continue;
            }
          }
          next.records[messageId] = stored;
          if (Object.keys(next.records).length > MAX_MESSAGES)
            fail('SNAPSHOT_LIMIT');
        }
        if (received.hasMore) {
          if (
            !received.next ||
            container.seenTokens.includes(received.next) ||
            container.pageToken === received.next
          )
            fail('REPEATED_PAGE_TOKEN');
          next.queue[0]!.seenTokens.push(received.next);
          next.queue[0]!.pageToken = received.next;
        } else next.queue.shift();
        cancelled(context.signal);
        await durable(pendingPath, canonical(next), context.signal);
        pending = next;
      }
      const snapshot: Snapshot = {
        schema: 'opencontext.feishu-snapshot/v1',
        pluginVersion: VERSION,
        configHash,
        realm: config.realm,
        chatId: config.chatId,
        watermark: pending.scanEnd,
        lastFullAt: pending.full ? pending.startedAt : base!.lastFullAt,
        records: pending.records,
      };
      const serialized = canonical(snapshot);
      const version = `fs1:${sha(serialized)}`;
      const result = output(snapshot, version, input);
      cancelled(context.signal);
      const target = join(directory, 'snapshots', `${version.slice(4)}.json`);
      const existing = await readState(target);
      if (existing !== null && existing !== serialized)
        fail('CHECKPOINT_CORRUPT');
      if (existing === null) await durable(target, serialized, context.signal);
      pending.readyVersion = version;
      await durable(pendingPath, canonical(pending), context.signal);
      return result;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (context.signal.aborted) fail('CANCELLED');
      fail('CHECKPOINT_IO');
    } finally {
      active.delete(directory);
    }
  }

  return {
    manifest: {
      id: 'org.opencontext.feishu-chat',
      version: VERSION,
      protocolVersion: '1',
      capabilities: ['connector'],
      location: 'server',
      trust: 'official-trusted-native',
    },
    capability: 'connector',
    artifactPaths: [import.meta.url],
    title: 'Feishu / Lark group archive',
    description:
      'Read-only bounded chat and discovered-thread synchronization; independent secret reference.',
    configSchema,
    acceptsImports: false,
    recommendedProcessorRef: 'org.opencontext.feishu-chat-analysis@0.1.0',
    fields: [
      {
        key: 'realm',
        label: 'Region',
        kind: 'select',
        options: [
          { value: 'feishu', label: 'Feishu (China)' },
          { value: 'lark', label: 'Lark' },
        ],
        default: 'feishu',
      },
      {
        key: 'chatId',
        label: 'Authorized group chat ID',
        kind: 'text',
        placeholder: 'oc_synthetic',
      },
      {
        key: 'secretRef',
        label: 'Server credential reference',
        kind: 'text',
        placeholder: 'secret:feishu/team',
      },
      {
        key: 'startTime',
        label: 'History start (UTC)',
        kind: 'text',
        placeholder: '2026-09-01T00:00:00Z',
      },
      {
        key: 'endTime',
        label: 'History end (UTC or now)',
        kind: 'text',
        default: 'now',
      },
      {
        key: 'overlapSeconds',
        label: 'Incremental overlap seconds',
        kind: 'text',
        default: '300',
      },
    ],
    probe: () => ({
      available: true,
      capabilities: ['connector'],
      limitations: [
        'Read-only selected group archive; server secret must be provisioned separately and authorized for that chat.',
        'Text extraction only; other messages remain raw metadata. No attachment downloads, events or external tasks.',
        'Discovered threads are paginated; old-root replies may wait for daily full reconciliation. Missing entries are never inferred as deletions.',
        '100 pages / 500 retained messages / 10 MiB limits. Private plugin checkpoints are required backup data.',
        'Upstream revocation fails sync; single-owner archive access must be revoked locally. No enterprise source-ACL synchronization.',
      ],
    }),
    validateConfig(config) {
      configuration(config, now());
    },
    async testConnection(value, context) {
      try {
        const { config, start, end } = configuration(value, now());
        await page(
          config,
          { type: 'chat', id: config.chatId, pageToken: null, seenTokens: [] },
          String(start),
          String(end),
          context.signal,
          1,
        );
        return { status: 'reachable', evidence, code: 'CHAT_READABLE' };
      } catch (error) {
        const code =
          error instanceof ConnectorError
            ? error.code
            : 'CONNECTION_TEST_FAILED';
        return {
          status: [
            'SECRET_NOT_CONFIGURED',
            'SECRET_UNAVAILABLE',
            'SECRET_INVALID',
            'AUTH_FAILED',
            'PERMISSION_DENIED',
          ].includes(code)
            ? 'blocked'
            : 'error',
          evidence,
          code,
        };
      }
    },
    invoke,
  };
}
