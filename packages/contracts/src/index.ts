import { Type, type Static } from '@sinclair/typebox';
import type { PluginInstanceLock, ExecutionLock } from './plugins.ts';
export * from './plugins.ts';

export const Id = Type.String({ minLength: 1, maxLength: 120 });
export const CollectionSchema = Type.Union([
  Type.Literal('sources'),
  Type.Literal('derived'),
  Type.Literal('authored'),
]);
export type Collection = Static<typeof CollectionSchema>;
export type Freshness = 'fresh' | 'stale' | 'invalid';
export const CreateProjectSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 80 }) },
  { additionalProperties: false },
);
export const CreateBindingSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    repoUrl: Type.String({ minLength: 1, maxLength: 2000 }),
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export const SearchSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 300 }),
    mode: Type.Optional(
      Type.Union([Type.Literal('fts'), Type.Literal('grep')]),
    ),
    freshness: Type.Optional(
      Type.Union([Type.Literal('current_only'), Type.Literal('include_stale')]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);
export const MAX_AUTH_TOKEN_LENGTH = 256;
export const LoginSchema = Type.Object(
  { token: Type.String({ minLength: 16, maxLength: MAX_AUTH_TOKEN_LENGTH }) },
  { additionalProperties: false },
);
export const ReadOptionsSchema = Type.Object(
  {
    startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 16777216 })),
    maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    section: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    outline: Type.Optional(Type.Boolean()),
    maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 65536 })),
    offsetBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 16777216 })),
  },
  { additionalProperties: false },
);
export type ReadOptions = Static<typeof ReadOptionsSchema>;
export const ReadSchema = Type.Object(
  { fileId: Id, revisionId: Id, ...ReadOptionsSchema.properties },
  { additionalProperties: false },
);
export type SearchInput = Static<typeof SearchSchema>;
export type CreateBindingInput = Static<typeof CreateBindingSchema>;
export type Principal = {
  id: string;
  role: 'owner' | 'reader';
  projectId: string | null;
};
export const ProjectSchema = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    head: Type.Union([Id, Type.Null()]),
    createdAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type Project = Static<typeof ProjectSchema>;

export type Binding = {
  id: string;
  projectId: string;
  name: string;
  instanceRef: string;
  packageRef: string;
  config: Record<string, unknown>;
  connector: PluginInstanceLock | null;
  processor: PluginInstanceLock | null;
  active: boolean;
  sourceVersion: string | null;
  lastError: string | null;
};
export const FileEntrySchema = Type.Object(
  {
    fileId: Id,
    revisionId: Id,
    contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    bytes: Type.Integer({ minimum: 0, maximum: 104857600 }),
    projectId: Id,
    bindingId: Id,
    slotKey: Type.String({ minLength: 1, maxLength: 2000 }),
    logicalPath: Type.String({ minLength: 1, maxLength: 2000 }),
    collection: CollectionSchema,
    ownership: Type.Union([
      Type.Literal('source_managed'),
      Type.Literal('generated'),
      Type.Literal('human_owned'),
    ]),
    freshness: Type.Union([
      Type.Literal('fresh'),
      Type.Literal('stale'),
      Type.Literal('invalid'),
    ]),
    tombstone: Type.Boolean(),
    sourceVersion: Type.String({ minLength: 1, maxLength: 2000 }),
    createdAt: Type.String({ minLength: 1, maxLength: 64 }),
    derivedFrom: Type.Array(
      Type.Object(
        { fileId: Id, revisionId: Id },
        { additionalProperties: false },
      ),
      { maxItems: 10000 },
    ),
  },
  { additionalProperties: false },
);
export type FileEntry = Static<typeof FileEntrySchema>;
export const CitationSchema = Type.Object(
  {
    uri: Type.String({ minLength: 1, maxLength: 2000 }),
    projectId: Id,
    fileId: Id,
    revisionId: Id,
    commitId: Id,
    path: Type.String({ minLength: 1, maxLength: 2000 }),
    contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    sourceVersion: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type Citation = Static<typeof CitationSchema>;
export const SearchHitSchema = Type.Object(
  {
    file: FileEntrySchema,
    excerpt: Type.String({ maxLength: 512 }),
    citation: CitationSchema,
    score: Type.Number(),
  },
  { additionalProperties: false },
);
export type SearchHit = Static<typeof SearchHitSchema>;
export const SearchResultSchema = Type.Object(
  {
    servedCommit: Type.Union([Id, Type.Null()]),
    hits: Type.Array(SearchHitSchema, { maxItems: 50 }),
    indexCoverage: Type.Union([Type.Literal('ready'), Type.Literal('partial')]),
    degraded: Type.Boolean(),
    mode: Type.Union([Type.Literal('fts'), Type.Literal('grep')]),
  },
  { additionalProperties: false },
);
export type SearchResult = Static<typeof SearchResultSchema>;
export const ReadResultSchema = Type.Object(
  {
    file: FileEntrySchema,
    text: Type.String({ maxLength: 16777216 }),
    citation: CitationSchema,
    outline: Type.Optional(
      Type.Array(
        Type.Object(
          {
            title: Type.String({ maxLength: 2000 }),
            line: Type.Integer({ minimum: 1 }),
            level: Type.Integer({ minimum: 1, maximum: 6 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 200 },
      ),
    ),
    disclosure: Type.Optional(
      Type.Object(
        {
          mode: Type.Union([
            Type.Literal('outline'),
            Type.Literal('full'),
            Type.Literal('lines'),
            Type.Literal('section'),
          ]),
          startLine: Type.Integer({ minimum: 1 }),
          fullBytes: Type.Integer({ minimum: 0 }),
          selectedBytes: Type.Integer({ minimum: 0 }),
          returnedBytes: Type.Integer({ minimum: 0, maximum: 65536 }),
          offsetBytes: Type.Integer({ minimum: 0 }),
          nextOffsetBytes: Type.Union([
            Type.Integer({ minimum: 0 }),
            Type.Null(),
          ]),
          nextOutlineLine: Type.Optional(
            Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
          ),
          textHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ReadResult = Static<typeof ReadResultSchema>;

export type Run = {
  id: string;
  projectId: string;
  bindingId: string;
  kind: 'sync' | 'process';
  state: 'queued' | 'running' | 'published' | 'failed' | 'superseded';
  fence: string;
  incarnation: string;
  inputCommit: string | null;
  resultCommit: string | null;
  error: string | null;
  createdAt: string;
  skipped?: { path: string; reason: string }[];
  execution?: ExecutionLock | null;
};
export type ApiFailure = {
  error: { code: string; message: string; correlationId?: string };
};

export type Capability =
  | 'connector'
  | 'trigger'
  | 'processor'
  | 'indexer'
  | 'retriever'
  | 'context-assembler'
  | 'embedding'
  | 'publisher';
export const PluginManifestSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$',
      maxLength: 160,
    }),
    version: Type.String({
      pattern:
        '^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$',
      maxLength: 80,
    }),
    protocolVersion: Type.Literal('1'),
    capabilities: Type.Array(
      Type.Union([
        Type.Literal('connector'),
        Type.Literal('trigger'),
        Type.Literal('processor'),
        Type.Literal('indexer'),
        Type.Literal('retriever'),
        Type.Literal('context-assembler'),
        Type.Literal('embedding'),
        Type.Literal('publisher'),
      ]),
      { minItems: 1, maxItems: 8, uniqueItems: true },
    ),
    location: Type.Literal('server'),
    trust: Type.Literal('official-trusted-native'),
  },
  { additionalProperties: false },
);
export type PluginManifest = Static<typeof PluginManifestSchema>;
export const PluginProbeSchema = Type.Object(
  {
    available: Type.Boolean(),
    capabilities: Type.Array(
      PluginManifestSchema.properties.capabilities.items,
      { maxItems: 8, uniqueItems: true },
    ),
    limitations: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type PluginProbeResult = Static<typeof PluginProbeSchema>;

export type PluginInstance = {
  ref: string;
  packageRef: string;
  config: Record<string, unknown>;
  capabilities: Capability[];
};
export type SourceFile = {
  relativePath: string;
  content: string;
  mime: 'text/plain' | 'text/markdown';
};
export type ConnectorInput = {
  repoUrl: string;
  branch: string;
  previousVersion: string | null;
  maxFiles: number;
  maxBytes: number;
};
export type ConnectorOutput = {
  sourceVersion: string;
  complete: true;
  files: SourceFile[];
  renames: { from: string; to: string }[];
  skipped: { path: string; reason: string }[];
};
export type ProcessorInput = {
  projectId: string;
  bindingId: string;
  inputCommitId: string;
  files: { file: FileEntry; text: string }[];
};
export type ProcessorOutput = {
  mode: 'full';
  complete: true;
  outputs: {
    slotKey: string;
    relativePath: string;
    content: string;
    derivedFrom: { fileId: string; revisionId: string }[];
  }[];
};
export type IndexDocument = { file: FileEntry; text: string };
export type IndexCandidate = {
  fileId: string;
  revisionId: string;
  score: number;
  excerpt: string;
};
export type RetrievalPort = {
  listFiles(projectId: string): FileEntry[];
  read(projectId: string, fileId: string, revisionId: string): ReadResult;
  head(projectId: string): string | null;
  candidates(projectId: string, query: string, limit: number): IndexCandidate[];
  indexReady(projectId: string): boolean;
};
