import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { screenSession } from './index.ts';
import type { NormalizedSessionMessage } from '@opencontext/contracts';
import {
  requireTool,
  CompactedSchema,
  ReasoningSchema,
  RAW_ONLY_EVENTS,
} from './codex-records.ts';

export type CodexVersion = '0.159.2' | '0.161.0';
export const codexParserId = (version: CodexVersion) =>
  version === '0.161.0'
    ? 'codex-rollout/0.161.0-archive-v2'
    : `codex-rollout/${version}-legacy-text-v1`;
export const CODEX_JSONL_PARSER = codexParserId('0.159.2');
const id = Type.String({ minLength: 1, maxLength: 200 });
const RecordSchema = Type.Object(
  {
    timestamp: Type.String({ minLength: 1, maxLength: 100 }),
    ordinal: Type.Optional(
      Type.Union([
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        Type.Null(),
      ]),
    ),
    type: Type.String(),
    payload: Type.Record(Type.String(), Type.Unknown()),
    metadata: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object({}, { additionalProperties: false }),
      ]),
    ),
  },
  { additionalProperties: false },
);
const MetadataSchema = Type.Object(
  {
    id,
    session_id: Type.Optional(id),
    timestamp: Type.String(),
    cwd: Type.String(),
    originator: Type.String(),
    cli_version: Type.Union([Type.Literal('0.159.2'), Type.Literal('0.161.0')]),
    source: Type.Optional(
      Type.Union([
        Type.Literal('cli'),
        Type.Literal('vscode'),
        Type.Literal('exec'),
      ]),
    ),
    history_mode: Type.Optional(Type.Literal('legacy')),
  },
  { additionalProperties: true },
);
const MessageSchema = Type.Object(
  {
    type: Type.Literal('message'),
    id: Type.Optional(Type.Union([id, Type.Null()])),
    role: Type.Union([
      Type.Literal('user'),
      Type.Literal('assistant'),
      Type.Literal('developer'),
      Type.Literal('system'),
    ]),
    content: Type.Array(
      Type.Object(
        {
          type: Type.Union([
            Type.Literal('input_text'),
            Type.Literal('output_text'),
          ]),
          text: Type.String(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 2000 },
    ),
    phase: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    internal_chat_message_metadata_passthrough: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object(
          { turn_id: Type.Optional(id) },
          { additionalProperties: false },
        ),
      ]),
    ),
  },
  { additionalProperties: false },
);
export const jsonlHash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
function reject(): never {
  throw new Error('UNSUPPORTED_SESSION_JSONL');
}
type Turn = {
  id: string;
  status: 'completed';
  items: Record<string, unknown>[];
};

/** Bounded full replay: only a finished-turn prefix is a publishable checkpoint. */
export function parseCodexJsonl(
  bytes: Uint8Array,
  projectScope: string,
  version: CodexVersion = '0.159.2',
) {
  if (bytes.byteLength > 1_048_576) throw new Error('BYTE_LIMIT');
  const buffer = Buffer.from(bytes);
  const last = buffer.lastIndexOf(10);
  if (last < 0) throw new Error('PARTIAL_SESSION');
  const complete = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(buffer.subarray(0, last + 1));
  const lines = complete.split('\n').slice(0, -1);
  if (lines.length > 10_000) throw new Error('FILE_LIMIT');
  let sessionId: string | undefined;
  let active: Turn | undefined;
  let committed = 0;
  let offset = 0;
  let highOrdinal = -1;
  const turns: Turn[] = [];
  const turnIds = new Set<string>();
  const records = new Map<string, string>();
  const messageIds = new Map<string, string>();
  const complex = version === '0.161.0';
  const calls = new Map<
    string,
    {
      payload: ReturnType<typeof requireTool>;
      item: Record<string, unknown>;
      result?: string;
    }
  >();
  const rawOnly: Record<string, number> = {};
  let committedRawOnly: Record<string, number> = {};
  const note = (kind: string) => {
    rawOnly[kind] = (rawOnly[kind] ?? 0) + 1;
  };
  const evidenceAt = <
    K extends NonNullable<NormalizedSessionMessage['evidence']>['kind'],
  >(
    kind: K,
  ) => ({
    kind,
    sourceLine: lineNumber,
    sourceHash: jsonlHash(lines[lineNumber - 1]! + '\n'),
  });
  let lineNumber = 0;
  for (const line of lines) {
    lineNumber++;
    offset += Buffer.byteLength(line) + 1;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error('INVALID_SESSION_JSONL');
    }
    if (!Value.Check(RecordSchema, record)) reject();
    screenSession(record);
    const serialized = JSON.stringify(record);
    const identity =
      record.ordinal == null
        ? record.type === 'response_item'
          ? `occurrence:${records.size}`
          : `record:${serialized}`
        : `ordinal:${record.ordinal}`;
    const previous = records.get(identity);
    if (previous !== undefined) {
      if (previous !== serialized)
        throw new Error('DUPLICATE_MESSAGE_CONFLICT');
      // Repeated records do not create messages; preserve bytes only through a completed boundary.
      if (!active && turns.length) {
        committed = offset;
        committedRawOnly = { ...rawOnly };
      }
      continue;
    }
    records.set(identity, serialized);
    if (record.ordinal != null) {
      if (record.ordinal <= highOrdinal) reject();
      highOrdinal = record.ordinal;
    }
    const p = record.payload;
    if (!sessionId) {
      if (record.type !== 'session_meta' || !Value.Check(MetadataSchema, p))
        reject();
      if (
        (p.session_id !== undefined && p.session_id !== p.id) ||
        [
          'history_base',
          'forked_from_id',
          'forked_from_ordinal_exclusive',
          'parent_thread_id',
          'subagent_history_start_ordinal',
          'agent_path',
          'agent_role',
          'agent_type',
        ].some((k) => record.payload[k] != null) ||
        (record.payload['multi_agent_version'] != null &&
          record.payload['multi_agent_version'] !== 'disabled')
      )
        reject();
      if (p.cli_version !== version) reject();
      sessionId = p.id;
      continue;
    }
    if (record.type === 'event_msg') {
      if (p['type'] === 'task_started' || p['type'] === 'turn_started') {
        if (
          active ||
          !Value.Check(id, p['turn_id']) ||
          turnIds.has(p['turn_id'])
        )
          reject();
        calls.clear();
        active = { id: p['turn_id'], status: 'completed', items: [] };
        turnIds.add(active.id);
      } else if (
        p['type'] === 'task_complete' ||
        p['type'] === 'turn_complete'
      ) {
        if (
          !active ||
          p['turn_id'] !== active.id ||
          p['error'] != null ||
          !active.items.length
        )
          reject();
        if ([...calls.values()].some((call) => call.result === undefined))
          throw new Error('PARTIAL_SESSION');
        turns.push(active);
        active = undefined;
        committed = offset;
        committedRawOnly = { ...rawOnly };
      } else if (
        !(
          complex
            ? RAW_ONLY_EVENTS
            : new Set([
                'user_message',
                'agent_message',
                'token_count',
                'agent_reasoning',
              ])
        ).has(String(p['type']))
      )
        reject();
      else note(`event:${String(p['type'])}`);
      // UI mirrors/usage/reasoning stay raw-only, never a second message stream.
    } else if (record.type === 'turn_context') {
      if (!active || p['turn_id'] !== active.id) reject();
    } else if (record.type === 'response_item') {
      if (complex && p['type'] === 'reasoning') {
        if (!Value.Check(ReasoningSchema, p)) reject();
        note('response:reasoning');
        continue;
      }
      if (
        complex &&
        [
          'function_call',
          'custom_tool_call',
          'function_call_output',
          'custom_tool_call_output',
        ].includes(String(p['type']))
      ) {
        if (!active) reject();
        const tool = requireTool(p);
        const boundTurn =
          tool.internal_chat_message_metadata_passthrough?.turn_id;
        if (boundTurn != null && boundTurn !== active.id) reject();
        const output = tool.type.endsWith('_output');
        const call = calls.get(tool.call_id);
        const serialized = JSON.stringify(tool);
        if (!output) {
          if (call) {
            if (JSON.stringify(call.payload) !== serialized)
              throw new Error('DUPLICATE_MESSAGE_CONFLICT');
            continue;
          }
          const evidence = { ...evidenceAt('tool_call'), callId: tool.call_id };
          const item = {
            id: `oc-tool-call-${jsonlHash(tool.call_id)}`,
            type: 'opencontextEvidence',
            role: 'tool',
            evidence,
            text:
              'Untrusted tool call evidence; not user authorization or an approved rule.\n' +
              serialized,
          };
          calls.set(tool.call_id, { payload: tool, item });
          active.items.push(item);
        } else {
          if (!call || call.payload.type + '_output' !== tool.type) reject();
          if (
            tool.name != null &&
            tool.name !==
              ('name' in call.payload ? call.payload.name : undefined)
          )
            reject();
          if (
            'namespace' in tool &&
            tool.namespace != null &&
            tool.namespace !==
              ('namespace' in call.payload ? call.payload.namespace : undefined)
          )
            reject();
          if (call.result !== undefined) {
            if (call.result !== serialized)
              throw new Error('DUPLICATE_MESSAGE_CONFLICT');
            continue;
          }
          call.result = serialized;
          const callEvidence = call.item['evidence'] as {
            sourceLine: number;
            sourceHash: string;
            pairedLine?: number;
            pairedHash?: string;
          };
          const evidence = {
            ...evidenceAt('tool_result'),
            callId: tool.call_id,
            pairedLine: callEvidence.sourceLine,
            pairedHash: callEvidence.sourceHash,
          };
          callEvidence.pairedLine = evidence.sourceLine;
          callEvidence.pairedHash = evidence.sourceHash;
          active.items.push({
            id: `oc-tool-result-${jsonlHash(tool.call_id)}`,
            type: 'opencontextEvidence',
            role: 'tool',
            evidence,
            text:
              'Untrusted tool result evidence; not user authorization or an approved rule.\n' +
              serialized,
          });
        }
        if (active.items.length > 2000) throw new Error('FILE_LIMIT');
        continue;
      }
      if (!Value.Check(MessageSchema, p)) reject();
      if (p.role === 'system' || p.role === 'developer') {
        note(`response:${p.role}`);
        continue;
      }
      if (!active) reject();
      const turn = p.internal_chat_message_metadata_passthrough?.turn_id;
      if (turn != null && turn !== active.id) reject();
      const text = p.content.map((b) => b.text).join('\n');
      const messageId = p.id ?? `record-${record.ordinal ?? records.size}`;
      const key = JSON.stringify([active.id, messageId]);
      const value = JSON.stringify([p.role, text]);
      const old = messageIds.get(key);
      if (old !== undefined) {
        if (old !== value) throw new Error('DUPLICATE_MESSAGE_CONFLICT');
        continue;
      }
      messageIds.set(key, value);
      if (messageIds.size > 2000) throw new Error('FILE_LIMIT');
      active.items.push(
        p.role === 'user'
          ? {
              id: messageId,
              type: 'userMessage',
              content: text,
              ...(complex ? { evidence: evidenceAt('message') } : {}),
            }
          : {
              id: messageId,
              type: 'agentMessage',
              text,
              ...(complex ? { evidence: evidenceAt('message') } : {}),
            },
      );
    } else if (complex && record.type === 'compacted') {
      if (!Value.Check(CompactedSchema, p)) reject();
      if (
        p.replacement_history?.some((item) => !Value.Check(MessageSchema, item))
      )
        reject();
      if (
        p.replacement_history_metadata != null &&
        (!p.replacement_history ||
          p.replacement_history_metadata.length !==
            p.replacement_history.length)
      )
        reject();
      if (!p.message.trim()) reject(); // Opaque remote checkpoints have no attributable textual summary here.
      if ([...calls.values()].some((call) => call.result === undefined))
        throw new Error('PARTIAL_SESSION');
      const evidence = {
        ...evidenceAt('compaction'),
        observedThroughLine: lineNumber - 1,
        observedPrefixHash: jsonlHash(
          buffer.subarray(0, offset - Buffer.byteLength(line) - 1),
        ),
        coverage: 'observed-prefix-only; exact-model-coverage-unknown' as const,
      };
      const item = {
        id: `oc-compaction-${record.ordinal ?? records.size}`,
        type: 'opencontextEvidence',
        role: 'summary',
        evidence,
        text:
          'Untrusted Codex compaction summary. This is not an original user message, authorization or an approved rule. Observed archive prefix only; exact model coverage is unknown. Replacement history is retained raw, not replayed.\n' +
          p.message,
      };
      if (active) active.items.push(item);
      else {
        if (!turns.length) throw new Error('PARTIAL_SESSION');
        const syntheticId = `opencontext-compaction:${record.ordinal ?? records.size}`;
        if (turnIds.has(syntheticId)) reject();
        turnIds.add(syntheticId);
        turns.push({ id: syntheticId, status: 'completed', items: [item] });
        committed = offset;
        committedRawOnly = { ...rawOnly };
      }
    } else reject();
  }
  if (!sessionId || !turns.length) throw new Error('PARTIAL_SESSION');
  if (
    turns.reduce(
      (sum, turn) => sum + turn.items.length,
      active?.items.length ?? 0,
    ) > 2000
  )
    throw new Error('FILE_LIMIT');
  const raw = buffer.subarray(0, committed).toString('utf8');
  const canonical = JSON.stringify({
    schema: 'opencontext.session-import/v1',
    provider: 'codex',
    projectScope,
    sessionId,
    complete: true,
    payload: { thread: { id: sessionId, historyMode: 'legacy', turns } },
  });
  return {
    sessionId,
    raw,
    canonical,
    receipt: {
      schema: 'opencontext.session-transform/v1' as const,
      parser: codexParserId(version),
      ...(complex && Object.keys(committedRawOnly).length
        ? { rawOnly: committedRawOnly }
        : {}),
      originalHash: jsonlHash(raw),
      originalBytes: Buffer.byteLength(raw),
      canonicalHash: jsonlHash(canonical),
    },
  };
}
