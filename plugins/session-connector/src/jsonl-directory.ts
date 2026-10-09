import { opendir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  readLocalBytes,
  type ConnectorDefinition,
} from '@opencontext/plugin-sdk';
import { sessionDirectoryDefinition } from './directory.ts';
import { importSessions } from './index.ts';
import { parseCodexJsonl, jsonlHash } from './codex-jsonl.ts';

export const sessionJsonlDirectoryDefinition: ConnectorDefinition = {
  ...sessionDirectoryDefinition,
  manifest: {
    ...sessionDirectoryDefinition.manifest,
    id: 'org.opencontext.session-jsonl-directory',
  },
  artifactPaths: [
    ...sessionDirectoryDefinition.artifactPaths,
    import.meta.url,
    new URL('./codex-jsonl.ts', import.meta.url).href,
  ],
  title: 'Selected native Codex JSONL directory',
  description:
    'Opt-in bounded legacy text rollout prefixes from Codex 0.159.2.',
  probe: () => ({
    available: true,
    capabilities: ['connector'],
    limitations: [
      'Explicit server directory only; 32 top-level JSONL files, 1 MiB each, 10 MiB aggregate. Completed text turns only; no history bases, tools or compaction.',
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
      parsed.push(parseCodexJsonl(content, scope));
    }
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
    );
    const sessions = new Map<string, string>();
    for (const p of parsed) {
      if (sessions.has(p.sessionId)) {
        if (sessions.get(p.sessionId) !== p.raw)
          throw new Error('DUPLICATE_SESSION_CONFLICT');
        continue;
      }
      sessions.set(p.sessionId, p.raw);
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
  },
};
