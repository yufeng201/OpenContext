import { createHash, randomUUID } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import {
  readLocalText,
  type ConnectorDefinition,
} from '@opencontext/plugin-sdk';
import type { ImportedObjectRef } from '@opencontext/contracts';
import { importSessions } from './index.ts';

/** Registered only by the explicit offline operator workflow, never the default HTTP registry. */
export const sessionDirectoryDefinition: ConnectorDefinition = {
  manifest: {
    id: 'org.opencontext.session-directory',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['connector'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  capability: 'connector',
  artifactPaths: [
    import.meta.url,
    new URL('./index.ts', import.meta.url).href,
    new URL('../../../packages/plugin-sdk/src/local-files.ts', import.meta.url)
      .href,
  ],
  title: 'Selected Codex export directory',
  description: 'Opt-in, bounded complete exports; no native session discovery.',
  configSchema: Type.Object(
    {
      enabled: Type.Boolean({ default: false }),
      directory: Type.String({ minLength: 1, maxLength: 4096 }),
      projectScope: Type.String({ minLength: 1, maxLength: 120 }),
    },
    { additionalProperties: false },
  ),
  fields: [],
  acceptsImports: false,
  probe: () => ({
    available: true,
    capabilities: ['connector'],
    limitations: [
      'Offline operator only. At most 32 top-level complete v1 JSON exports, 1 MiB each, 10 MiB total.',
      'Empty directories, links and non-JSON entries reject the scan. Native rollout JSONL is unsupported.',
    ],
  }),
  async invoke(input, context) {
    if (input.config['enabled'] !== true) throw new Error('POLICY_DENIED');
    const directory = input.config['directory'];
    if (
      typeof directory !== 'string' ||
      !isAbsolute(directory) ||
      realpathSync(directory) !== resolve(directory)
    )
      throw new Error('INVALID_PATH');
    const entries: string[] = [];
    for await (const entry of await opendir(directory)) {
      context.signal.throwIfAborted();
      if (!entry.isFile() || !entry.name.endsWith('.json'))
        throw new Error('INVALID_PATH');
      entries.push(entry.name);
      if (entries.length > 32) throw new Error('FILE_LIMIT');
    }
    if (!entries.length) throw new Error('EMPTY_SESSION');
    const contents = new Map<string, string>();
    const imports: ImportedObjectRef[] = [];
    let bytes = 0;
    for (const filename of entries.sort()) {
      context.signal.throwIfAborted();
      const content = readLocalText(resolve(directory, filename), 1_048_576);
      bytes += Buffer.byteLength(content);
      if (bytes > 10_485_760) throw new Error('BYTE_LIMIT');
      const contentHash = createHash('sha256').update(content).digest('hex');
      contents.set(contentHash, content);
      imports.push({
        id: randomUUID(),
        filename,
        contentHash,
        bytes: Buffer.byteLength(content),
      });
    }
    return importSessions(
      'codex',
      {
        ...input,
        config: { projectScope: input.config['projectScope'] },
        imports,
      },
      {
        ...context,
        readImport: async (ref) => contents.get(ref.contentHash)!,
      },
    );
  },
};
