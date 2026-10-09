import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ConnectorDefinition } from '@opencontext/plugin-sdk';
import {
  SessionUploadSchema,
  type SessionUpload,
} from '../../../packages/contracts/src/session-memory.ts';
import {
  parseCodexJsonl,
  jsonlHash,
  type CodexVersion,
} from './codex-jsonl.ts';
import {
  jsonlDirectoryDefinition,
  normalizedJsonlOutput,
} from './jsonl-directory.ts';

/** A text projection, not the original bytes. All conversion stays in this plugin. */
export function projectSession(
  parsed: ReturnType<typeof parseCodexJsonl>,
  version: CodexVersion,
): string {
  const canonical = JSON.parse(parsed.canonical) as {
    payload: {
      thread: {
        turns: {
          id: string;
          items: {
            id: string;
            type: string;
            content?: string;
            text?: string;
          }[];
        }[];
      };
    };
  };
  const record = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: '1970-01-01T00:00:00Z', type, payload }) + '\n';
  let output = record('session_meta', {
    id: parsed.sessionId,
    session_id: parsed.sessionId,
    timestamp: '1970-01-01T00:00:00Z',
    cwd: '[omitted]',
    originator: 'opencontext-explicit-upload',
    cli_version: version,
    source: 'cli',
    history_mode: 'legacy',
  });
  for (const turn of canonical.payload.thread.turns) {
    output += record('event_msg', { type: 'task_started', turn_id: turn.id });
    for (const item of turn.items) {
      const user = item.type === 'userMessage';
      output += record('response_item', {
        type: 'message',
        id: item.id,
        role: user ? 'user' : 'assistant',
        content: [
          {
            type: user ? 'input_text' : 'output_text',
            text: user ? item.content : item.text,
          },
        ],
      });
    }
    output += record('event_msg', { type: 'task_complete', turn_id: turn.id });
  }
  return output;
}

export function prepareSessionUpload(
  inputs: Uint8Array[],
  scope: string,
  version: CodexVersion,
): SessionUpload {
  if (!inputs.length || inputs.length > 8) throw new Error('FILE_LIMIT');
  const parsed = inputs.map((bytes) => parseCodexJsonl(bytes, scope, version));
  const upload: SessionUpload = {
    schema: 'opencontext.session-upload/v1',
    cliVersion: version,
    files: parsed
      .sort((a, b) =>
        jsonlHash(a.sessionId).localeCompare(jsonlHash(b.sessionId), 'en'),
      )
      .map((p) => ({
        content: projectSession(p, version),
        clientPrefixHash: p.receipt.originalHash,
        clientPrefixBytes: p.receipt.originalBytes,
      })),
  };
  validateSessionUpload(upload, scope, version);
  return upload;
}

export function validateSessionUpload(
  value: unknown,
  scope: string,
  version: CodexVersion,
) {
  if (!Value.Check(SessionUploadSchema, value) || value.cliVersion !== version)
    throw new Error('INVALID_IMPORT');
  if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576)
    throw new Error('BYTE_LIMIT');
  const seen = new Set<string>();
  return value.files.map((file) => {
    const p = parseCodexJsonl(Buffer.from(file.content), scope, version);
    // Enforce the exact metadata-minimized wire profile, including at the HTTP boundary.
    if (file.content !== projectSession(p, version) || seen.has(p.sessionId))
      throw new Error('INVALID_IMPORT');
    seen.add(p.sessionId);
    return {
      ...p,
      receipt: {
        ...p.receipt,
        transport: {
          profile: 'text-projection/v1' as const,
          clientPrefixHash: file.clientPrefixHash,
          clientPrefixBytes: file.clientPrefixBytes,
        },
      },
    };
  });
}

export function jsonlUploadDefinition(
  version: CodexVersion,
): ConnectorDefinition {
  const base = jsonlDirectoryDefinition(version);
  return {
    ...base,
    manifest: {
      ...base.manifest,
      id:
        version === '0.159.2'
          ? 'org.opencontext.session-jsonl-upload'
          : 'org.opencontext.session-jsonl-upload-0161',
    },
    artifactPaths: [
      ...base.artifactPaths,
      import.meta.url,
      new URL(
        '../../../packages/contracts/src/session-memory.ts',
        import.meta.url,
      ).href,
    ],
    title: 'Explicit client text projection upload',
    description:
      'One bounded selected-set upload through the owner-only session memory control.',
    configSchema: Type.Object(
      {
        enabled: Type.Boolean({ default: false }),
        projectScope: Type.String({ minLength: 1, maxLength: 120 }),
      },
      { additionalProperties: false },
    ),
    // Only the dedicated owner route can change the single atomic import selection.
    acceptsImports: true,
    probe: () => ({
      available: true,
      capabilities: ['connector'],
      limitations: [
        'Opt-in owner upload only. At most 8 selected files and 1 MiB serialized projection per set; no original machine metadata.',
      ],
    }),
    async validateImport(content, config) {
      const scope = String(config['projectScope']);
      const parsed = validateSessionUpload(JSON.parse(content), scope, version);
      await normalizedJsonlOutput(
        parsed,
        {
          config,
          previousVersion: null,
          imports: [],
          maxFiles: 500,
          maxBytes: 10_485_760,
        },
        { signal: new AbortController().signal, workDir: '' },
        scope,
      );
    },
    async invoke(input, context) {
      if (input.config['enabled'] !== true) throw new Error('POLICY_DENIED');
      if (input.imports.length !== 1 || !context.readImport)
        throw new Error('IMPORT_PORT_REQUIRED');
      const ref = input.imports[0]!;
      if (ref.bytes > 1_048_576) throw new Error('BYTE_LIMIT');
      const content = await context.readImport(ref);
      if (
        jsonlHash(content) !== ref.contentHash ||
        Buffer.byteLength(content) !== ref.bytes
      )
        throw new Error('IMPORT_HASH_MISMATCH');
      const scope = String(input.config['projectScope']);
      const parsed = validateSessionUpload(JSON.parse(content), scope, version);
      return normalizedJsonlOutput(parsed, input, context, scope);
    },
  };
}
