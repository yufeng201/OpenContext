import { Type, type Static } from '@sinclair/typebox';

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
    branch: Type.String({ minLength: 1, maxLength: 200, default: 'main' }),
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
export const LoginSchema = Type.Object(
  { token: Type.String({ minLength: 16, maxLength: 256 }) },
  { additionalProperties: false },
);
export const ReadSchema = Type.Object(
  { fileId: Id, revisionId: Id },
  { additionalProperties: false },
);
export type SearchInput = Static<typeof SearchSchema>;
export type CreateBindingInput = Static<typeof CreateBindingSchema>;
export type Principal = {
  id: string;
  role: 'owner' | 'reader';
  projectId: string | null;
};
export type Project = {
  id: string;
  name: string;
  head: string | null;
  createdAt: string;
};
export type Binding = {
  id: string;
  projectId: string;
  name: string;
  instanceRef: string;
  packageRef: string;
  config: { repoUrl: string; branch: string };
  active: boolean;
  sourceVersion: string | null;
  lastError: string | null;
};
export type FileEntry = {
  fileId: string;
  revisionId: string;
  contentHash: string;
  bytes: number;
  projectId: string;
  bindingId: string;
  slotKey: string;
  logicalPath: string;
  collection: Collection;
  ownership: 'source_managed' | 'generated' | 'human_owned';
  freshness: Freshness;
  tombstone: boolean;
  sourceVersion: string;
  createdAt: string;
  derivedFrom: { fileId: string; revisionId: string }[];
};
export type Citation = {
  uri: string;
  projectId: string;
  fileId: string;
  revisionId: string;
  commitId: string;
  path: string;
  contentHash: string;
  sourceVersion: string;
};
export type SearchHit = {
  file: FileEntry;
  excerpt: string;
  citation: Citation;
  score: number;
};
export type SearchResult = {
  servedCommit: string | null;
  hits: SearchHit[];
  indexCoverage: 'ready' | 'partial';
  degraded: boolean;
  mode: 'fts' | 'grep';
};
export type ReadResult = { file: FileEntry; text: string; citation: Citation };
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
export type PluginManifest = {
  id: string;
  version: string;
  protocolVersion: '1';
  capabilities: Capability[];
  location: 'server';
  trust: 'official-trusted-native';
};
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
