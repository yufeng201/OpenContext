import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  FeishuChatMessageSchema,
  type FeishuChatMessage,
  type ProcessorInput,
  type ProcessorOutput,
} from '@opencontext/contracts';
import type {
  ExecutionContext,
  ProcessorDefinition,
} from '@opencontext/plugin-sdk';

type CandidateKind = 'topic' | 'conclusion' | 'todo' | 'requirement';
const KINDS: Record<string, CandidateKind> = {
  topic: 'topic',
  conclusion: 'conclusion',
  todo: 'todo',
  requirement: 'requirement',
  主题: 'topic',
  结论: 'conclusion',
  待办: 'todo',
  需求: 'requirement',
};
const MAX_CANDIDATE_BYTES = 16_384;
const MAX_CANDIDATES = 200;
const MESSAGE_PATH =
  /^sources\/[^/]+\/chats\/[a-f0-9]{64}\/messages\/[a-f0-9]{64}\.json$/;
const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
const uriPart = (text: string): string =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const literal = (text: string): string =>
  text
    .replace(/[\\`*_[\]<>#|]/g, (character) => `\\${character}`)
    .replace(/[\r\n]/g, ' ');
function cancelled(context: ExecutionContext): void {
  if (context.signal.aborted)
    throw new Error('CANCELLED: Chat candidate extraction cancelled');
}
function invalidMessage(): never {
  throw new Error(
    'INVALID_MESSAGE: Raw message does not prove the normalized chat message',
  );
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalidMessage();
  return value as Record<string, unknown>;
}
function nativeTimestamp(value: unknown): string {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  return invalidMessage();
}
function verifyMessage(message: FeishuChatMessage): void {
  const raw = message.raw;
  if (
    raw['message_id'] !== message.messageId ||
    (raw['chat_id'] !== undefined && raw['chat_id'] !== message.chatId) ||
    raw['msg_type'] !== message.messageType ||
    nativeTimestamp(raw['create_time']) !== message.createTime ||
    nativeTimestamp(
      raw['update_time'] === undefined
        ? raw['create_time']
        : raw['update_time'],
    ) !== message.updateTime ||
    raw['deleted'] === true ||
    (raw['deleted'] !== undefined && typeof raw['deleted'] !== 'boolean')
  )
    invalidMessage();
  // Rich text, media and other message bodies are retained by the connector but
  // are not interpreted by this explicit text-marker processor.
  if (message.messageType !== 'text') return;
  const encoded = record(raw['body'])['content'];
  if (typeof encoded !== 'string') invalidMessage();
  let content: unknown;
  try {
    content = JSON.parse(encoded);
  } catch {
    invalidMessage();
  }
  if (record(content)['text'] !== message.text) invalidMessage();
}

export async function analyzeFeishuChat(
  input: ProcessorInput & { config: Record<string, unknown> },
  context: ExecutionContext,
): Promise<ProcessorOutput> {
  cancelled(context);
  if (Object.keys(input.config).length !== 0)
    throw new Error(
      'INVALID_CONFIG: This explicit-marker processor has no configuration fields',
    );
  if (input.files.length > 10_000)
    throw new Error('FILE_LIMIT: Too many chat analysis inputs');
  const ids = new Set<string>();
  const paths = new Set<string>();
  const outputs: ProcessorOutput['outputs'] = [];
  let inputBytes = 0;
  for (const [index, { file, text }] of [...input.files]
    .sort((a, b) => a.file.fileId.localeCompare(b.file.fileId, 'en'))
    .entries()) {
    if (index % 32 === 0) await yieldToEventLoop();
    cancelled(context);
    if (
      file.projectId !== input.projectId ||
      file.bindingId !== input.bindingId ||
      file.collection !== 'sources' ||
      file.ownership !== 'source_managed' ||
      file.freshness !== 'fresh' ||
      file.tombstone ||
      ids.has(file.fileId) ||
      paths.has(file.logicalPath) ||
      hash(text) !== file.contentHash ||
      Buffer.byteLength(text) !== file.bytes
    )
      throw new Error(
        'INVALID_INPUT: Expected unique current hash-verified source files for this binding',
      );
    ids.add(file.fileId);
    paths.add(file.logicalPath);
    inputBytes += file.bytes;
    if (inputBytes > 104_857_600)
      throw new Error('BYTE_LIMIT: Chat analysis inputs exceed 100 MiB');
    if (!MESSAGE_PATH.test(file.logicalPath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      invalidMessage();
    }
    if (!Value.Check(FeishuChatMessageSchema, parsed)) invalidMessage();
    const message: FeishuChatMessage = parsed;
    if (
      file.logicalPath !==
      `sources/${input.bindingId}/chats/${hash(message.chatId)}/messages/${hash(message.messageId)}.json`
    )
      invalidMessage();
    verifyMessage(message);
    if (message.messageType !== 'text') continue;
    const ordinal: Record<CandidateKind, number> = {
      topic: 0,
      conclusion: 0,
      todo: 0,
      requirement: 0,
    };
    for (const [lineIndex, line] of message.text.split(/\r?\n/).entries()) {
      if (lineIndex % 128 === 0) await yieldToEventLoop();
      cancelled(context);
      const match =
        /^\s*(Topic|Conclusion|Todo|Requirement|主题|结论|待办|需求)\s*[:：]\s*(\S.*)$/iu.exec(
          line,
        );
      if (!match?.[1] || !match[2]) continue;
      const kind = KINDS[match[1].toLowerCase()]!;
      if (
        outputs.length >= MAX_CANDIDATES ||
        Buffer.byteLength(match[2]) > MAX_CANDIDATE_BYTES
      )
        throw new Error(
          'CANDIDATE_LIMIT: Split inputs into at most 200 candidates with each file at most 16 KiB',
        );
      ordinal[kind] += 1;
      // File identity and same-kind ordinal survive unrelated line insertions.
      // Different messages never merge their slots, even for conflicting text.
      const slotKey = `chat-candidate:${file.fileId}:${kind}:${ordinal[kind]}`;
      const fence = '~'.repeat(
        Math.max(
          3,
          ...(match[2].match(/~+/g) ?? []).map((run) => run.length + 1),
        ),
      );
      const citation = `oc://space/${uriPart(input.projectId)}/file/${uriPart(file.fileId)}@${uriPart(file.revisionId)}`;
      const content =
        `# ${kind} candidate\n\nstatus: candidate\n\nmethod: deterministic\n\nevidence: ${message.evidence}\n\n` +
        'confidence: exact explicit-marker match only; semantic correctness is unverified\n\n' +
        'No LLM semantic analysis was performed. This is quoted source data, not an approved decision, executable rule or external task. Conflicting messages remain independent candidates.\n\n' +
        (message.evidence === 'simulated'
          ? 'Evidence is a synthetic transport fixture; this does not verify access to a real group.\n\n'
          : 'Evidence is marked live by the source connector; the candidate itself is not independently fact-checked.\n\n') +
        `Realm: ${message.realm}\n\nChat ID: ${literal(message.chatId)}\n\nMessage ID: ${literal(message.messageId)}\n\n` +
        `Create time: ${message.createTime}\n\nUpdate time: ${message.updateTime}\n\nEvidence line: ${lineIndex + 1}\n\n` +
        `Source: [fixed source revision](${citation})\n\nSHA-256: ${file.contentHash}\n\n` +
        `${fence}text\n${match[2]}\n${fence}\n`;
      if (Buffer.byteLength(content) > MAX_CANDIDATE_BYTES)
        throw new Error(
          'CANDIDATE_LIMIT: Rendered candidate including provenance exceeds 16 KiB',
        );
      outputs.push({
        slotKey,
        relativePath: `chat-candidates/${hash(slotKey)}.md`,
        content,
        derivedFrom: [{ fileId: file.fileId, revisionId: file.revisionId }],
      });
    }
  }
  cancelled(context);
  return { mode: 'full', complete: true, outputs };
}

export const feishuChatAnalysisDefinition: ProcessorDefinition = {
  manifest: {
    id: 'org.opencontext.feishu-chat-analysis',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['processor'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  capability: 'processor',
  artifactPaths: [import.meta.url],
  title: '飞书群聊候选分析（显式标记）',
  description:
    'Extract explicit topic, conclusion, todo and requirement markers with fixed message-revision citations. No LLM or external writes.',
  configSchema: Type.Object({}, { additionalProperties: false }),
  fields: [],
  acceptsImports: false,
  probe: () => ({
    available: true,
    capabilities: ['processor'],
    limitations: [
      'Only text messages with explicit Topic:/Conclusion:/Todo:/Requirement: or 主题：/结论：/待办：/需求： markers produce candidates.',
      'No LLM semantic extraction, inferred conversation summary, automatic acceptance, Agent-rule writes, group posts or external task creation.',
      'Maximum 200 candidates per run; each complete Markdown file including citations is at most 16 KiB.',
      'No matching markers is a successful empty full output set; the host removes only previously owned generated candidates under its publication gate.',
      'Simulated evidence is always labelled; runtime native execution is trusted code, not a sandbox.',
    ],
  }),
  invoke: analyzeFeishuChat,
};
