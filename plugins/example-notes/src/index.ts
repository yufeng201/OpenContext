import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  ConnectorDefinition,
  ProcessorDefinition,
} from '@opencontext/plugin-sdk';
const NoteSchema = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 2000 }) },
  { additionalProperties: false },
);
function note(content: string): string {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('INVALID_JSON');
  }
  if (!Value.Check(NoteSchema, value)) throw new Error('INVALID_PLUGIN_INPUT');
  return value.text;
}
/** Developer-reviewed offline example, never added to the default registry. */
export const notesConnector: ConnectorDefinition = {
  capability: 'connector',
  manifest: {
    id: 'example.notes',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['connector'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  artifactPaths: [import.meta.url],
  title: 'Example notes',
  description: 'Explicit JSON imports only; deterministic offline sample.',
  configSchema: Type.Object(
    { prefix: Type.String({ minLength: 1, maxLength: 80 }) },
    { additionalProperties: false },
  ),
  fields: [{ key: 'prefix', label: 'Prefix', kind: 'text', default: 'Notes' }],
  acceptsImports: true,
  recommendedProcessorRef: 'example.notes-summary@0.1.0',
  probe: () => ({
    available: true,
    capabilities: ['connector'],
    limitations: ['Static developer example; no collector, model or sandbox.'],
  }),
  validateImport(content, _config, context) {
    if (context?.signal.aborted) throw new Error('CANCELLED');
    note(content);
  },
  async invoke(input, context) {
    const files = [];
    for (const object of input.imports) {
      if (context.signal.aborted) throw new Error('CANCELLED');
      if (!context.readImport) throw new Error('IMPORT_ACCESS_DENIED');
      const text = note(await context.readImport(object));
      files.push({
        relativePath: object.id + '.md',
        content: '# ' + String(input.config['prefix']) + '\n' + text + '\n',
        mime: 'text/markdown' as const,
      });
    }
    return {
      sourceVersion:
        'example:' +
        createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      complete: true,
      files,
      renames: [],
      skipped: [],
    };
  },
};
export const notesProcessor: ProcessorDefinition = {
  capability: 'processor',
  manifest: {
    id: 'example.notes-summary',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['processor'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  artifactPaths: [import.meta.url],
  title: 'Example candidates',
  description: 'Deterministic file copy with fixed lineage.',
  configSchema: Type.Object(
    { heading: Type.String({ minLength: 1, maxLength: 80 }) },
    { additionalProperties: false },
  ),
  fields: [
    { key: 'heading', label: 'Heading', kind: 'text', default: 'Candidate' },
  ],
  acceptsImports: false,
  probe: () => ({
    available: true,
    capabilities: ['processor'],
    limitations: ['No semantic extraction or paid model.'],
  }),
  async invoke(input, context) {
    if (context.signal.aborted) throw new Error('CANCELLED');
    return {
      mode: 'full',
      complete: true,
      outputs: input.files.map(({ file, text }) => ({
        slotKey: file.fileId,
        relativePath: file.fileId + '.md',
        content: '# ' + String(input.config['heading']) + '\n' + text,
        derivedFrom: [{ fileId: file.fileId, revisionId: file.revisionId }],
      })),
    };
  },
};
