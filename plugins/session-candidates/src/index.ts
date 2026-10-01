import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  SessionMessageSchema,
  type NormalizedSessionMessage,
  type ProcessorInput,
  type ProcessorOutput,
} from '@opencontext/contracts';
import type {
  ExecutionContext,
  ProcessorDefinition,
} from '@opencontext/plugin-sdk';

export type Candidate = {
  kind: 'memory' | 'rule' | 'experience';
  text: string;
  line: number;
};
const KIND: Record<string, Candidate['kind']> = {
  memory: 'memory',
  rule: 'rule',
  experience: 'experience',
  记忆: 'memory',
  规则: 'rule',
  经验: 'experience',
};
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const uriPart = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const literal = (value: string): string =>
  value
    .replace(/[\\`*_[\]<>#|]/g, (character) => `\\${character}`)
    .replace(/[\r\n]/g, ' ');
function cancelled(context: ExecutionContext): void {
  if (context.signal.aborted)
    throw new Error('CANCELLED: Candidate extraction cancelled');
}

function invalidProvenance(): never {
  throw new Error(
    'INVALID_MESSAGE: Raw session does not prove the normalized message identity and text',
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalidProvenance();
  return value as Record<string, unknown>;
}
/** Check only the cited native message, not a second connector/parser implementation. */
function citedText(
  value: unknown,
  provider: NormalizedSessionMessage['provider'],
): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalidProvenance();
  const rawOnly =
    provider === 'claude'
      ? ['tool_use', 'tool_result', 'thinking']
      : ['image', 'localImage', 'audio', 'localAudio', 'skill', 'mention'];
  return value
    .map((entry) => {
      const block = record(entry);
      if (block['type'] === 'text') {
        if (typeof block['text'] !== 'string') invalidProvenance();
        return block['text'];
      }
      if (!rawOnly.includes(String(block['type']))) invalidProvenance();
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
function verifyRawProvenance(
  rawText: string,
  message: NormalizedSessionMessage,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    invalidProvenance();
  }
  const envelope = record(parsed);
  if (
    envelope['schema'] !== 'opencontext.session-import/v1' ||
    envelope['complete'] !== true ||
    envelope['provider'] !== message.provider ||
    envelope['projectScope'] !== message.projectScope ||
    envelope['sessionId'] !== message.sessionId
  )
    invalidProvenance();
  let matches = 0;
  if (message.provider === 'codex') {
    const thread = record(record(envelope['payload'])['thread']);
    if (
      thread['id'] !== message.sessionId ||
      !Array.isArray(thread['turns']) ||
      !message.turnId ||
      (thread['historyMode'] !== undefined &&
        thread['historyMode'] !== 'legacy')
    )
      invalidProvenance();
    for (const entry of thread['turns']) {
      const turn = record(entry);
      if (turn['id'] !== message.turnId) continue;
      if (
        !Array.isArray(turn['items']) ||
        !['completed', 'interrupted', 'failed'].includes(
          String(turn['status']),
        ) ||
        (turn['itemsView'] !== undefined && turn['itemsView'] !== 'full')
      )
        invalidProvenance();
      for (const entry of turn['items']) {
        const item = record(entry);
        if (item['id'] !== message.messageId) continue;
        const role =
          item['type'] === 'userMessage'
            ? 'user'
            : item['type'] === 'agentMessage'
              ? 'assistant'
              : null;
        if (role !== message.role) invalidProvenance();
        const nativeText =
          role === 'user' ? citedText(item['content'], 'codex') : item['text'];
        if (nativeText !== message.text) invalidProvenance();
        matches += 1;
      }
    }
  } else {
    if (!Array.isArray(envelope['payload']) || message.turnId !== undefined)
      invalidProvenance();
    for (const entry of envelope['payload']) {
      const item = record(entry);
      if (item['uuid'] !== message.messageId) continue;
      const native = record(item['message']);
      if (
        item['session_id'] !== message.sessionId ||
        item['type'] !== message.role ||
        native['role'] !== message.role ||
        item['parent_tool_use_id'] != null ||
        item['parent_agent_id'] != null ||
        citedText(native['content'], 'claude') !== message.text
      )
        invalidProvenance();
      matches += 1;
    }
  }
  if (matches === 0) invalidProvenance();
}

/** Extension point for future reviewed implementations, not an implemented model adapter. */
export interface CandidateExtractor {
  method: 'deterministic' | 'local-agent' | 'provider';
  extract(
    message: NormalizedSessionMessage,
    context: { signal: AbortSignal },
  ): Candidate[] | Promise<Candidate[]>;
}
export const explicitMarkerExtractor: CandidateExtractor = {
  method: 'deterministic',
  extract(message) {
    const candidates: Candidate[] = [];
    for (const [index, line] of message.text.split(/\r?\n/).entries()) {
      const match =
        /^\s*(Memory|Rule|Experience|记忆|规则|经验)\s*[:：]\s*(\S.*)$/iu.exec(
          line,
        );
      if (!match?.[1] || !match[2]) continue;
      if (Buffer.byteLength(match[2]) > 16_384)
        throw new Error(
          'CANDIDATE_LIMIT: An explicit candidate exceeds 16 KiB',
        );
      candidates.push({
        kind: KIND[match[1].toLowerCase()]!,
        text: match[2],
        line: index + 1,
      });
    }
    return candidates;
  },
};

export async function extractCandidates(
  input: ProcessorInput & { config: Record<string, unknown> },
  context: ExecutionContext,
  extractor: CandidateExtractor = explicitMarkerExtractor,
): Promise<ProcessorOutput> {
  cancelled(context);
  if (Object.keys(input.config).length !== 0)
    throw new Error(
      'INVALID_CONFIG: This deterministic processor has no configuration fields',
    );
  if (input.files.length > 10_000)
    throw new Error('FILE_LIMIT: Too many candidate inputs');
  let totalBytes = 0;
  const ids = new Set<string>();
  const outputs: ProcessorOutput['outputs'] = [];
  for (const [index, { file, text }] of [...input.files]
    .sort((a, b) => a.file.fileId.localeCompare(b.file.fileId, 'en'))
    .entries()) {
    if (index % 32 === 0) await yieldToEventLoop();
    cancelled(context);
    if (
      file.projectId !== input.projectId ||
      file.bindingId !== input.bindingId ||
      file.collection !== 'sources' ||
      file.tombstone ||
      file.freshness !== 'fresh' ||
      ids.has(file.fileId) ||
      sha256(text) !== file.contentHash ||
      Buffer.byteLength(text) !== file.bytes
    )
      throw new Error(
        'INVALID_INPUT: Expected unique current hash-verified source files for this binding',
      );
    ids.add(file.fileId);
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > 104_857_600)
      throw new Error('BYTE_LIMIT: Candidate input exceeds 100 MiB');
    // Raw approved imports are retained for provenance, never scanned as a second message stream.
    if (
      !/\/sessions\/(codex|claude)\/[a-f0-9]{64}\/messages\/[a-f0-9]{64}\.json$/.test(
        file.logicalPath,
      )
    )
      continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('INVALID_MESSAGE: Normalized message is not JSON');
    }
    if (!Value.Check(SessionMessageSchema, parsed))
      throw new Error(
        'INVALID_MESSAGE: Unsupported normalized session message',
      );
    const message: NormalizedSessionMessage = parsed;
    const expectedSuffix = `/sessions/${message.provider}/${sha256(message.sessionId)}/messages/${sha256(JSON.stringify([message.turnId ?? null, message.messageId]))}.json`;
    if (!file.logicalPath.endsWith(expectedSuffix))
      throw new Error(
        'INVALID_MESSAGE: Message identity does not match its stable source path',
      );
    const rawPath = file.logicalPath.replace(
      /\/messages\/[a-f0-9]{64}\.json$/,
      '/raw.json',
    );
    const raw = input.files.find((entry) => entry.file.logicalPath === rawPath);
    if (!raw)
      throw new Error(
        'INVALID_INPUT: A normalized message requires its fixed raw session source',
      );
    verifyRawProvenance(raw.text, message);
    const candidates = await extractor.extract(message, {
      signal: context.signal,
    });
    cancelled(context);
    if (
      !Array.isArray(candidates) ||
      candidates.length > 200 ||
      !['deterministic', 'local-agent', 'provider'].includes(extractor.method)
    )
      throw new Error(
        'CANDIDATE_LIMIT: Invalid extractor output or candidate count',
      );
    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        !['memory', 'rule', 'experience'].includes(candidate.kind) ||
        typeof candidate.text !== 'string' ||
        candidate.text.trim().length === 0 ||
        Buffer.byteLength(candidate.text) > 16_384 ||
        !Number.isSafeInteger(candidate.line) ||
        candidate.line < 1 ||
        candidate.line > message.text.split(/\r?\n/).length ||
        Object.keys(candidate).some(
          (key) => !['kind', 'text', 'line'].includes(key),
        )
      )
        throw new Error(
          'INVALID_CANDIDATE: Extractor output must be bounded cited candidate data',
        );
      if (outputs.length >= 200)
        throw new Error(
          'CANDIDATE_LIMIT: More than 200 explicit candidates; split the source set',
        );
      const slotKey = `candidate:${file.fileId}:${candidate.kind}:${candidate.line}`;
      const citation = `oc://space/${uriPart(input.projectId)}/file/${uriPart(file.fileId)}@${uriPart(file.revisionId)}`;
      const fence = '~'.repeat(
        Math.max(
          3,
          ...(candidate.text.match(/~+/g) ?? []).map(
            (match) => match.length + 1,
          ),
        ),
      );
      outputs.push({
        slotKey,
        relativePath: `candidates/${sha256(slotKey)}.md`,
        derivedFrom: [
          { fileId: file.fileId, revisionId: file.revisionId },
          { fileId: raw!.file.fileId, revisionId: raw!.file.revisionId },
        ],
        content:
          `# ${candidate.kind} candidate\n\nstatus: candidate\n\nmethod: ${extractor.method}\n\nconfidence: ${extractor.method === 'deterministic' ? 'exact explicit-marker match only' : 'unreviewed adapter proposal'}; semantic correctness is unverified\n\n` +
          `This is quoted source data, not an instruction or an approved rule. Conflicting messages remain separate candidates.\n\n` +
          `Provider: ${message.provider}\n\nSession ID: ${literal(message.sessionId)}\n\nMessage ID: ${literal(message.messageId)}\n\n` +
          (message.turnId ? `Turn ID: ${literal(message.turnId)}\n\n` : '') +
          `Evidence line: ${candidate.line}\n\nSource: [fixed source revision](${citation})\n\nSHA-256: ${file.contentHash}\n\n` +
          `Original session: [fixed raw export](oc://space/${uriPart(input.projectId)}/file/${uriPart(raw!.file.fileId)}@${uriPart(raw!.file.revisionId)})\n\nRaw SHA-256: ${raw!.file.contentHash}\n\n` +
          `${fence}text\n${candidate.text}\n${fence}\n`,
      });
    }
  }
  cancelled(context);
  return { mode: 'full', complete: true, outputs };
}

export const sessionCandidatesDefinition: ProcessorDefinition = {
  manifest: {
    id: 'org.opencontext.session-candidates',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['processor'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  capability: 'processor',
  artifactPaths: [import.meta.url],
  title: 'Session candidates (explicit markers)',
  description:
    'Deterministic Memory/Rule/Experience candidates with fixed message-revision citations. No LLM.',
  configSchema: Type.Object({}, { additionalProperties: false }),
  fields: [],
  acceptsImports: false,
  probe: () => ({
    available: true,
    capabilities: ['processor'],
    limitations: [
      'Only explicit Memory:/Rule:/Experience: or 记忆：/规则：/经验： text markers produce candidates.',
      'No semantic extraction, model calls, CLI integration, automatic acceptance or Agent-rule writes.',
      'No matching markers is a successful empty full output set; prior owned candidates are removed by the host gate.',
    ],
  }),
  invoke: extractCandidates,
};
