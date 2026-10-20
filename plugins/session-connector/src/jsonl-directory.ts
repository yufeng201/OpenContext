import { opendir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  readLocalBytes,
  type ConnectorDefinition,
} from '@opencontext/plugin-sdk';
import { sessionDirectoryDefinition } from './directory.ts';
import { importSessions } from './index.ts';
import type { ConnectorInvocation } from '@opencontext/contracts';
import type { ExecutionContext } from '@opencontext/plugin-sdk';
import {
  parseCodexJsonl,
  jsonlHash,
  type CodexVersion,
} from './codex-jsonl.ts';

export function jsonlDirectoryDefinition(
  version: CodexVersion,
): ConnectorDefinition {
  return {
    ...sessionDirectoryDefinition,
    manifest: {
      ...sessionDirectoryDefinition.manifest,
      id:
        version === '0.159.2'
          ? 'org.opencontext.session-jsonl-directory'
          : 'org.opencontext.session-jsonl-directory-0161',
    },
    artifactPaths: [
      ...sessionDirectoryDefinition.artifactPaths,
      import.meta.url,
      new URL('./codex-jsonl.ts', import.meta.url).href,
      new URL('./codex-records.ts', import.meta.url).href,
    ],
    title: 'Selected native Codex JSONL directory',
    description: `Opt-in bounded legacy rollout archive prefixes from Codex ${version}.`,
    probe: () => ({
      available: true,
      capabilities: ['connector'],
      limitations: [
        'Explicit server directory only; 32 top-level JSONL files, 1 MiB each, 10 MiB aggregate. Completed turns only; 0.161.0 supports paired text tools and limited textual compaction evidence. No inherited history or model-context reconstruction.',
      ],
    }),
    async invoke(input, context) {
      if (input.config['enabled'] !== true) throw new Error('POLICY_DENIED');
      const directory = input.config['directory'];
      const scope = input.config['projectScope'];
      if (
        typeof directory !== 'string' ||
        typeof scope !== 'string' ||
        !isAbsolute(directory) ||
        realpathSync(directory) !== resolve(directory)
      )
        throw new Error('INVALID_PATH');
      const names: string[] = [];
      for await (const entry of await opendir(directory)) {
        context.signal.throwIfAborted();
        if (!entry.isFile() || !entry.name.endsWith('.jsonl'))
          throw new Error('INVALID_PATH');
        names.push(entry.name);
        if (names.length > 32) throw new Error('FILE_LIMIT');
      }
      if (!names.length) throw new Error('EMPTY_SESSION');
      const parsed = [];
      let bytes = 0;
      for (const name of names.sort()) {
        context.signal.throwIfAborted();
        const content = readLocalBytes(resolve(directory, name), 1_048_576);
        bytes += content.byteLength;
        if (bytes > 10_485_760) throw new Error('BYTE_LIMIT');
        parsed.push(parseCodexJsonl(content, scope, version));
      }
      return normalizedJsonlOutput(parsed, input, context, scope);
    },
  };
}
export const sessionJsonlDirectoryDefinition =
  jsonlDirectoryDefinition('0.159.2');
export const sessionJsonl0161DirectoryDefinition =
  jsonlDirectoryDefinition('0.161.0');

export async function normalizedJsonlOutput(
  parsed: ReturnType<typeof parseCodexJsonl>[],
  input: ConnectorInvocation,
  context: ExecutionContext,
  scope: string,
) {
  const contents = new Map(
    parsed.map((p) => [jsonlHash(p.canonical), p.canonical]),
  );
  const output = await importSessions(
    'codex',
    {
      ...input,
      config: { projectScope: scope },
      imports: parsed.map((p, i) => ({
        id: String(i),
        filename: `${i}.json`,
        contentHash: jsonlHash(p.canonical),
        bytes: Buffer.byteLength(p.canonical),
      })),
    },
    { ...context, readImport: async (ref) => contents.get(ref.contentHash)! },
    true,
  );
  const sessions = new Map<string, string>();
  for (const p of parsed) {
    if (sessions.has(p.sessionId)) {
      if (sessions.get(p.sessionId) !== p.raw)
        throw new Error('DUPLICATE_SESSION_CONFLICT');
      continue;
    }
    sessions.set(p.sessionId, p.raw);
    for (const [kind, count] of Object.entries(p.receipt.rawOnly ?? {}))
      output.skipped.push({
        path: `sessions/codex/${jsonlHash(p.sessionId)}/raw.jsonl`,
        reason: `raw_only:${kind}:${count}`,
      });
    const base = `sessions/codex/${jsonlHash(p.sessionId)}`;
    output.files.push(
      {
        relativePath: `${base}/raw.jsonl`,
        content: p.raw,
        mime: 'text/plain',
      },
      {
        relativePath: `${base}/transform.json`,
        content: JSON.stringify(p.receipt),
        mime: 'text/plain',
      },
    );
  }
  if (output.files.length > input.maxFiles) throw new Error('FILE_LIMIT');
  if (
    output.files.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0) >
    input.maxBytes
  )
    throw new Error('BYTE_LIMIT');
  output.files.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, 'en'),
  );
  output.sourceVersion = jsonlHash(
    JSON.stringify(
      output.files.map((f) => [f.relativePath, jsonlHash(f.content)]),
    ),
  );
  return output;
}
