import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Type } from '@sinclair/typebox';
import type {
  ConnectorInvocation,
  ConnectorOutput,
  NormalizedSessionMessage,
} from '@opencontext/contracts';
import type {
  ConnectorDefinition,
  ExecutionContext,
} from '@opencontext/plugin-sdk';

type Provider = 'codex' | 'claude';
type JsonObject = Record<string, unknown>;
const MAX_IMPORT_BYTES = 1_048_576;
const MAX_MESSAGES = 2_000;
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function fail(code: string, detail: string): never {
  // Never include imported text, session IDs or payloads in diagnostics.
  throw new Error(`${code}: ${detail}`);
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_SESSION', 'Expected a JSON object');
  return value as JsonObject;
}
function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    fail('INVALID_SESSION', 'Missing or invalid stable identifier');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_SESSION', 'Expected an array');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string')
    fail('UNSUPPORTED_SESSION_CONTENT', 'Only explicit text is supported');
  return value;
}
function textBlocks(
  value: unknown,
  provider: Provider,
  preserved: Set<string>,
): string {
  if (typeof value === 'string') return value;
  return array(value)
    .map((item) => {
      const block = object(item);
      if (block['type'] === 'text') return text(block['text']);
      if (provider === 'claude' && block['type'] === 'tool_use') {
        id(block['id']);
        id(block['name']);
        object(block['input']);
      } else if (provider === 'claude' && block['type'] === 'tool_result') {
        id(block['tool_use_id']);
        if (
          block['content'] != null &&
          typeof block['content'] !== 'string' &&
          !Array.isArray(block['content'])
        )
          fail('INVALID_SESSION', 'Invalid tool result content');
      } else if (provider === 'claude' && block['type'] === 'thinking') {
        text(block['thinking']);
        text(block['signature']);
      } else if (
        provider === 'codex' &&
        [
          'image',
          'localImage',
          'audio',
          'localAudio',
          'skill',
          'mention',
        ].includes(String(block['type']))
      ) {
        // Only retain these documented UserInput variants in raw. Never follow a path/URL.
        if (
          ['localImage', 'localAudio', 'skill', 'mention'].includes(
            String(block['type']),
          )
        )
          text(block['path']);
        if (block['type'] === 'audio') text(block['url']);
        if (['skill', 'mention'].includes(String(block['type'])))
          text(block['name']);
      } else fail('UNSUPPORTED_SESSION_CONTENT', 'Unknown content block type');
      preserved.add(`${provider}_block_${String(block['type'])}_raw_only`);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
function cancelled(context: ExecutionContext): void {
  if (context.signal.aborted) fail('CANCELLED', 'Session import cancelled');
}

/** Reject known secret-bearing metadata; do not redact then claim byte preservation. */
function screen(value: unknown, depth = 0): void {
  if (depth > 64)
    fail('INVALID_SESSION', 'JSON nesting exceeds the supported limit');
  if (typeof value === 'string') {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value))
      fail(
        'SECRET_DETECTED',
        'Private key content must be excluded before import',
      );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) screen(item, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)$/i.test(
          key,
        )
      )
        fail(
          'SECRET_DETECTED',
          'Secret-bearing metadata must be excluded before import',
        );
      screen(item, depth + 1);
    }
  }
}

function parse(
  raw: string,
  provider: Provider,
  projectScope: string,
): {
  sessionId: string;
  messages: NormalizedSessionMessage[];
  preserved: Set<string>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('INVALID_SESSION', 'Import is not valid JSON');
  }
  screen(parsed);
  const envelope = object(parsed);
  const expected = [
    'schema',
    'provider',
    'projectScope',
    'sessionId',
    'complete',
    'payload',
  ];
  if (
    Object.keys(envelope).length !== expected.length ||
    Object.keys(envelope).some((key) => !expected.includes(key)) ||
    envelope['schema'] !== 'opencontext.session-import/v1' ||
    envelope['provider'] !== provider
  )
    fail('INVALID_SESSION', 'Unsupported import envelope or provider');
  if (envelope['complete'] !== true)
    fail(
      'PARTIAL_SESSION',
      'An explicitly confirmed complete export is required',
    );
  if (envelope['projectScope'] !== projectScope)
    fail(
      'PROJECT_SCOPE_MISMATCH',
      'Import scope differs from the configured project scope',
    );
  const sessionId = id(envelope['sessionId']);
  const messages: NormalizedSessionMessage[] = [];
  const preserved = new Set<string>();
  const seen = new Map<string, string>();
  const add = (
    messageId: string,
    role: 'user' | 'assistant',
    content: string,
    turnId?: string,
  ): void => {
    const message: NormalizedSessionMessage = {
      schema: 'opencontext.session-message/v1',
      provider,
      projectScope,
      sessionId,
      messageId,
      ...(turnId === undefined ? {} : { turnId }),
      role,
      text: content,
    };
    const key = JSON.stringify([turnId ?? null, messageId]);
    const serialized = JSON.stringify(message);
    const previous = seen.get(key);
    if (previous !== undefined) {
      if (previous !== serialized)
        fail(
          'DUPLICATE_MESSAGE_CONFLICT',
          'A stable message ID has conflicting content',
        );
      return;
    }
    seen.set(key, serialized);
    messages.push(message);
    if (messages.length > MAX_MESSAGES)
      fail('FILE_LIMIT', 'Session contains more than 2000 normalized messages');
  };
  if (provider === 'codex') {
    const thread = object(object(envelope['payload'])['thread']);
    if (id(thread['id']) !== sessionId)
      fail(
        'SESSION_ID_MISMATCH',
        'Thread ID differs from the envelope session ID',
      );
    if (
      thread['historyMode'] !== undefined &&
      thread['historyMode'] !== 'legacy'
    )
      fail(
        'UNSUPPORTED_SESSION_HISTORY',
        'Paginated history must not masquerade as a complete thread/read response',
      );
    for (const entry of array(thread['turns'])) {
      const turn = object(entry);
      const turnId = id(turn['id']);
      if (
        !['completed', 'interrupted', 'failed'].includes(String(turn['status']))
      )
        fail('PARTIAL_SESSION', 'Only finished turns may be imported');
      if (turn['itemsView'] !== undefined && turn['itemsView'] !== 'full')
        fail(
          'PARTIAL_SESSION',
          'Summary-only turns are not complete message exports',
        );
      for (const value of array(turn['items'])) {
        const item = object(value);
        const messageId = id(item['id']);
        if (item['type'] === 'userMessage')
          add(
            messageId,
            'user',
            textBlocks(item['content'], provider, preserved),
            turnId,
          );
        else if (item['type'] === 'agentMessage')
          add(messageId, 'assistant', text(item['text']), turnId);
        else {
          // Confirmed against Codex 0.159.2 app-server ThreadItem schema. Keep
          // tool payload opaque in exact raw; never convert tool output to rules.
          const required: Record<string, string[]> = {
            hookPrompt: ['fragments'],
            functionCallOutput: ['name', 'output'],
            plan: ['text'],
            reasoning: [],
            commandExecution: ['command', 'commandActions', 'cwd', 'status'],
            fileChange: ['changes', 'status'],
            mcpToolCall: ['arguments', 'server', 'status', 'tool'],
            dynamicToolCall: ['arguments', 'status', 'tool'],
            collabAgentToolCall: [
              'agentsStates',
              'receiverThreadIds',
              'senderThreadId',
              'status',
              'tool',
            ],
            subAgentActivity: ['agentPath', 'agentThreadId', 'kind'],
            webSearch: ['query'],
            imageView: ['path'],
            sleep: ['durationMs'],
            imageGeneration: ['result', 'status'],
            enteredReviewMode: ['review'],
            exitedReviewMode: ['review'],
            contextCompaction: [],
          };
          const fields = required[String(item['type'])];
          if (!fields || fields.some((field) => !(field in item)))
            fail(
              'UNSUPPORTED_SESSION_ITEM',
              'Unknown item type or missing required item fields',
            );
          if (
            ['inProgress', 'running', 'pending'].includes(
              String(item['status']),
            )
          )
            fail('PARTIAL_SESSION', 'A tool item is still in progress');
          preserved.add(`codex_item_${String(item['type'])}_raw_only`);
        }
      }
    }
  } else {
    for (const value of array(envelope['payload'])) {
      const item = object(value);
      if (id(item['session_id']) !== sessionId)
        fail(
          'SESSION_ID_MISMATCH',
          'SDK message session_id differs from the envelope',
        );
      if (item['parent_tool_use_id'] != null || item['parent_agent_id'] != null)
        fail(
          'UNSUPPORTED_SESSION_ITEM',
          'Subagent histories require a separate explicit export contract',
        );
      const role = item['type'];
      const message = object(item['message']);
      if ((role !== 'user' && role !== 'assistant') || message['role'] !== role)
        fail(
          'INVALID_SESSION',
          'Expected a matching user or assistant message role',
        );
      add(
        id(item['uuid']),
        role,
        textBlocks(message['content'], provider, preserved),
      );
    }
  }
  if (messages.length === 0)
    fail(
      'EMPTY_SESSION',
      'Empty history is not evidence of deletion; explicitly remove the imported object instead',
    );
  return { sessionId, messages, preserved };
}

export async function importSessions(
  provider: Provider,
  input: ConnectorInvocation,
  context: ExecutionContext,
): Promise<ConnectorOutput> {
  cancelled(context);
  const projectScope = input.config['projectScope'];
  if (
    typeof projectScope !== 'string' ||
    projectScope.length < 1 ||
    projectScope.length > 120 ||
    Object.keys(input.config).length !== 1 ||
    !Number.isSafeInteger(input.maxFiles) ||
    input.maxFiles < 1 ||
    input.maxFiles > 10_000 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    input.maxBytes > 104_857_600 ||
    input.imports.length > 32
  )
    fail('INVALID_CONFIG', 'Invalid scope, import count or snapshot limits');
  const files: ConnectorOutput['files'] = [];
  const skipped: ConnectorOutput['skipped'] = [];
  const sessions = new Map<string, string>();
  let totalBytes = 0;
  const push = (relativePath: string, content: string): void => {
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > input.maxBytes)
      fail('BYTE_LIMIT', 'Complete session snapshot exceeds its byte limit');
    if (files.length >= input.maxFiles)
      fail('FILE_LIMIT', 'Complete session snapshot exceeds its file limit');
    files.push({ relativePath, content, mime: 'text/plain' });
  };
  for (const ref of input.imports) {
    await yieldToEventLoop();
    cancelled(context);
    if (!context.readImport)
      fail(
        'IMPORT_PORT_REQUIRED',
        'The host must provide locked import access',
      );
    if (
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.bytes > MAX_IMPORT_BYTES
    )
      fail('BYTE_LIMIT', 'An import must contain between 1 byte and 1 MiB');
    const raw = await context.readImport(ref);
    cancelled(context);
    if (
      Buffer.byteLength(raw) !== ref.bytes ||
      sha256(raw) !== ref.contentHash ||
      Buffer.from(raw).toString('utf8') !== raw
    )
      fail(
        'IMPORT_HASH_MISMATCH',
        'Import bytes do not match the locked UTF-8 object',
      );
    const { sessionId, messages, preserved } = parse(
      raw,
      provider,
      projectScope,
    );
    const old = sessions.get(sessionId);
    if (old !== undefined) {
      if (old !== raw)
        fail(
          'DUPLICATE_SESSION_CONFLICT',
          'One session has different exports in the same selected set',
        );
      continue;
    }
    sessions.set(sessionId, raw);
    const base = `sessions/${provider}/${sha256(sessionId)}`;
    push(`${base}/raw.json`, raw);
    for (const reason of [...preserved].sort())
      skipped.push({ path: `${base}/raw.json`, reason });
    for (const message of messages) {
      const messageKey = JSON.stringify([
        message.turnId ?? null,
        message.messageId,
      ]);
      push(
        `${base}/messages/${sha256(messageKey)}.json`,
        `${JSON.stringify(message)}\n`,
      );
    }
  }
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en'),
  );
  cancelled(context);
  return {
    sourceVersion: sha256(
      JSON.stringify(
        files.map((file) => [file.relativePath, sha256(file.content)]),
      ),
    ),
    complete: true,
    files,
    renames: [],
    skipped: skipped.sort((a, b) =>
      `${a.path}:${a.reason}`.localeCompare(`${b.path}:${b.reason}`, 'en'),
    ),
  };
}

function definition(provider: Provider): ConnectorDefinition {
  return {
    manifest: {
      id: `org.opencontext.${provider}-sessions`,
      version: '0.1.0',
      protocolVersion: '1',
      capabilities: ['connector'],
      location: 'server',
      trust: 'official-trusted-native',
    },
    capability: 'connector',
    artifactPaths: [import.meta.url],
    title: `${provider === 'codex' ? 'Codex' : 'Claude'} session import`,
    description:
      'Import an explicitly approved versioned JSON export; no automatic collection or model calls.',
    configSchema: Type.Object(
      { projectScope: Type.String({ minLength: 1, maxLength: 120 }) },
      { additionalProperties: false },
    ),
    fields: [
      {
        key: 'projectScope',
        label: 'Export project scope',
        kind: 'text',
        placeholder: 'synthetic-project',
      },
    ],
    acceptsImports: true,
    recommendedProcessorRef: 'org.opencontext.session-candidates@0.1.0',
    probe: () => ({
      available: true,
      capabilities: ['connector'],
      limitations: [
        'Explicit opencontext.session-import/v1 uploads only; no local session scanning or CLI invocation.',
        'Finished top-level conversations only. Known tool/non-text items stay in exact raw with explicit diagnostics; unknown or incomplete exports reject the whole sync.',
        'Raw approved JSON is preserved exactly. Known credential metadata is rejected, but arbitrary secrets require user review.',
      ],
    }),
    validateImport(content, config) {
      if (typeof config['projectScope'] !== 'string')
        fail('INVALID_CONFIG', 'Missing project scope');
      if (Buffer.byteLength(content) > MAX_IMPORT_BYTES)
        fail('BYTE_LIMIT', 'Import exceeds 1 MiB');
      parse(content, provider, config['projectScope']);
    },
    invoke: (input, context) => importSessions(provider, input, context),
  };
}

export const codexSessionDefinition = definition('codex');
export const claudeSessionDefinition = definition('claude');
