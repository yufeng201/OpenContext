import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { isErrorCode } from './errors.ts';
import {
  Id,
  SearchSchema,
  ReadSchema,
  ProjectSchema,
  FileEntrySchema,
  ReadResultSchema,
  SearchResultSchema,
  type FileEntry,
  type Citation,
  type ReadOptions,
  type ReadResult,
} from './index.ts';

export const ReadQuerySchema = Type.Object(
  {
    fileId: Id,
    revisionId: Id,
    section: ReadSchema.properties.section,
    outline: Type.Optional(
      Type.Union([Type.Literal('true'), Type.Literal('false')]),
    ),
    ...Object.fromEntries(
      ['startLine', 'maxLines', 'maxBytes', 'offsetBytes'].map((key) => [
        key,
        Type.Optional(Type.String({ pattern: '^(0|[1-9][0-9]{0,7})$' })),
      ]),
    ),
  },
  { additionalProperties: false },
);
export function parseReadQuery(
  value: Record<string, unknown>,
): Static<typeof ReadSchema> {
  if (!Value.Check(ReadQuerySchema, value)) throw new Error('INVALID_SCHEMA');
  const parsed = Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      ['startLine', 'maxLines', 'maxBytes', 'offsetBytes'].includes(k)
        ? Number(v)
        : k === 'outline'
          ? v === 'true'
          : v,
    ]),
  );
  if (!Value.Check(ReadSchema, parsed)) throw new Error('INVALID_SCHEMA');
  return parsed;
}

/** Bind an opt-in projected response to the caller's declared selection/budget. */
export function assertReadSelection(
  result: ReadResult,
  selector: ReadOptions,
): void {
  const requested = Object.entries(selector).filter(
    ([, value]) => value !== undefined,
  );
  if (!requested.length) {
    if (result.disclosure) throw new Error('INVALID_RESPONSE');
    return;
  }
  const d = result.disclosure;
  const mode = selector.outline
    ? 'outline'
    : selector.section
      ? 'section'
      : selector.startLine !== undefined || selector.maxLines !== undefined
        ? 'lines'
        : 'full';
  if (
    !d ||
    d.mode !== mode ||
    d.returnedBytes > (selector.maxBytes ?? 8192) ||
    d.offsetBytes !== (selector.offsetBytes ?? 0) ||
    (['lines', 'outline'].includes(mode) &&
      d.startLine !== (selector.startLine ?? 1))
  )
    throw new Error('INVALID_RESPONSE');
  if (
    selector.outline &&
    (!result.outline ||
      new TextEncoder().encode(JSON.stringify(result.outline)).length >
        (selector.maxBytes ?? 8192) ||
      result.text !== '')
  )
    throw new Error('INVALID_RESPONSE');
}

export const QUERY_RESPONSE_MAX_BYTES = 16777216;
export const ProjectsSchema = Type.Array(ProjectSchema, { maxItems: 20000 });
export const TreeSchema = Type.Array(FileEntrySchema, { maxItems: 20000 });
export const EmptyQuerySchema = Type.Object(
  {},
  { additionalProperties: false },
);
export const FilePageInputSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export const FilePageQuerySchema = Type.Object(
  {
    limit: Type.Optional(
      Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' }),
    ),
    cursor: FilePageInputSchema.properties.cursor,
  },
  { additionalProperties: false },
);
export type FilePageInput = Static<typeof FilePageInputSchema>;
export const FilePageSchema = Type.Object(
  {
    servedCommit: Type.Union([Id, Type.Null()]),
    files: Type.Array(FileEntrySchema, { maxItems: 200 }),
    nextCursor: Type.Union([
      Type.String({ minLength: 1, maxLength: 2000 }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type FilePage = Static<typeof FilePageSchema>;
export const QueryErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ pattern: '^[A-Z][A-Z0-9_]+$', maxLength: 80 }),
        message: Type.String({ maxLength: 200 }),
        correlationId: Type.String({
          pattern:
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export function parseQueryError(
  value: unknown,
): Static<typeof QueryErrorSchema> {
  if (
    !Value.Check(QueryErrorSchema, value) ||
    !isErrorCode(value.error.code) ||
    (value.error.message !== value.error.code &&
      !(
        value.error.code === 'INTERNAL_ERROR' &&
        value.error.message === 'Request could not be completed'
      ))
  )
    throw new Error('INVALID_RESPONSE');
  return value;
}
export function parseQueryResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  scope: {
    projectId?: string;
    fileId?: string;
    revisionId?: string;
    limit?: number;
  } = {},
): Static<T> {
  if (!Value.Check(schema, value)) throw new Error('INVALID_RESPONSE');
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    QUERY_RESPONSE_MAX_BYTES
  )
    throw new Error('RESPONSE_TOO_LARGE');
  const file = (f: FileEntry, history = false) => {
    if (
      (scope.projectId && f.projectId !== scope.projectId) ||
      (f.tombstone &&
        !(history && f.collection === 'sources' && f.freshness !== 'fresh')) ||
      (f.freshness === 'invalid' &&
        !(history && f.collection === 'sources' && f.tombstone))
    )
      throw new Error('INVALID_RESPONSE');
  };
  const citation = (f: FileEntry, c: Citation, history = false) => {
    file(f, history);
    for (const key of [
      'projectId',
      'fileId',
      'revisionId',
      'contentHash',
      'sourceVersion',
    ] as const)
      if (f[key] !== c[key]) throw new Error('INVALID_RESPONSE');
    if (
      c.path !== f.logicalPath ||
      c.uri !== `oc://space/${f.projectId}/file/${f.fileId}@${f.revisionId}`
    )
      throw new Error('INVALID_RESPONSE');
  };
  if ((schema as TSchema) === TreeSchema) {
    for (const f of value as FileEntry[]) file(f);
  } else if ((schema as TSchema) === ReadResultSchema) {
    const r = value as Static<typeof ReadResultSchema>;
    citation(r.file, r.citation, true);
    const d = r.disclosure;
    if (r.outline && d?.mode !== 'outline') throw new Error('INVALID_RESPONSE');
    if (d?.mode === 'outline') {
      if (
        !r.outline ||
        r.text !== '' ||
        d.selectedBytes !== 0 ||
        d.offsetBytes !== 0 ||
        d.nextOffsetBytes !== null ||
        d.nextOutlineLine === undefined ||
        r.outline.some(
          (h, index) =>
            h.line < d.startLine ||
            (index > 0 && h.line <= r.outline![index - 1]!.line),
        ) ||
        (d.nextOutlineLine !== null &&
          d.nextOutlineLine <= (r.outline.at(-1)?.line ?? d.startLine - 1))
      )
        throw new Error('INVALID_RESPONSE');
    }

    if (
      d &&
      (d.fullBytes !== r.file.bytes ||
        d.selectedBytes > d.fullBytes ||
        d.offsetBytes + d.returnedBytes > d.selectedBytes ||
        (d.nextOffsetBytes === null
          ? d.offsetBytes + d.returnedBytes !== d.selectedBytes
          : d.nextOffsetBytes !== d.offsetBytes + d.returnedBytes ||
            d.nextOffsetBytes >= d.selectedBytes))
    )
      throw new Error('INVALID_RESPONSE');
    if (
      (scope.fileId && r.file.fileId !== scope.fileId) ||
      (scope.revisionId && r.file.revisionId !== scope.revisionId) ||
      new TextEncoder().encode(r.text).length !==
        (r.disclosure?.returnedBytes ?? r.file.bytes)
    )
      throw new Error('INVALID_RESPONSE');
  } else if ((schema as TSchema) === SearchResultSchema) {
    const r = value as Static<typeof SearchResultSchema>;
    if (
      r.hits.length > (scope.limit ?? 50) ||
      r.hits.reduce((n, h) => n + h.excerpt.length, 0) > 4096
    )
      throw new Error('INVALID_RESPONSE');
    for (const h of r.hits) {
      citation(h.file, h.citation);
      if (h.citation.commitId !== r.servedCommit || !Number.isFinite(h.score))
        throw new Error('INVALID_RESPONSE');
    }
  } else if ((schema as TSchema) === FilePageSchema) {
    const r = value as FilePage;
    if (r.files.length > (scope.limit ?? 200))
      throw new Error('INVALID_RESPONSE');
    for (const f of r.files) file(f);
  }
  return value;
}

/** Query surface only. Mutations keep their existing owner-only gates. */
export const QueryRoutes = {
  projects: '/api/projects',
  tree: '/api/projects/:id/tree',
  search: '/api/projects/:id/search',
  read: '/api/projects/:id/read',
  files: '/api/projects/:id/files',
} as const;

export function projectQueryPath(route: string, projectId: string): string {
  if (
    typeof projectId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(projectId)
  )
    throw new Error('INVALID_PROJECT_ID');
  return route.replace(':id', encodeURIComponent(projectId));
}

const projectParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: Id,
};
const error = {
  description:
    'Current authorization or request rejected; no content returned.',
  content: {
    'application/json': {
      schema: QueryErrorSchema,
    },
  },
};
const response = (description: string, schema: object) => ({
  description,
  content: { 'application/json': { schema } },
});
// Request and response schemas are shared with runtime REST/SDK/MCP validation.
export const QueryOpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'OpenContext query API',
    version: '0.1.0-preview',
    description:
      'Controlled loopback preview. Query subset; REST/MCP recheck current project/source authorization, including historical reads. Responses use shared strict TypeBox schemas. Not a complete management API or production readiness claim.',
  },
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      SearchInput: SearchSchema,
      ReadInput: ReadSchema,
      File: FileEntrySchema,
      SearchResult: SearchResultSchema,
      ReadResult: ReadResultSchema,
      Error: QueryErrorSchema,
      FilePage: FilePageSchema,
    },
  },
  paths: {
    [QueryRoutes.files.replace(':id', '{id}')]: {
      get: {
        operationId: 'pageFiles',
        parameters: [
          projectParameter,
          ...Object.entries(FilePageInputSchema.properties).map(
            ([name, schema]) => ({
              name,
              in: 'query',
              required: false,
              schema,
            }),
          ),
        ],
        responses: {
          '200': response(
            'Snapshot-pinned authorized file page; cursor invalidated by head or visibility changes.',
            FilePageSchema,
          ),
          '400': error,
          '401': error,
          '403': error,
          '404': error,
          '409': error,
        },
      },
    },
    [QueryRoutes.projects.replace(':id', '{id}')]: {
      get: {
        operationId: 'listProjects',
        responses: {
          '200': response('Authorized projects only.', ProjectsSchema),
          '401': error,
        },
      },
    },
    [QueryRoutes.tree.replace(':id', '{id}')]: {
      get: {
        operationId: 'listFiles',
        parameters: [projectParameter],
        responses: {
          '200': response(
            'Current authorized files; FileEntry[]; invalid/tombstoned entries omitted.',
            TreeSchema,
          ),
          '401': error,
          '403': error,
          '404': error,
        },
      },
    },
    [QueryRoutes.search.replace(':id', '{id}')]: {
      post: {
        operationId: 'search',
        parameters: [projectParameter],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: SearchSchema } },
        },
        responses: {
          '200': response(
            'SearchResult with fixed revision citations.',
            SearchResultSchema,
          ),
          '400': error,
          '401': error,
          '403': error,
          '404': error,
        },
      },
    },
    [QueryRoutes.read.replace(':id', '{id}')]: {
      get: {
        operationId: 'readRevision',
        parameters: [
          projectParameter,
          ...Object.entries(ReadSchema.properties).map(([name, schema]) => ({
            name,
            in: 'query',
            required: (ReadSchema.required as readonly string[]).includes(name),
            schema,
          })),
        ],
        responses: {
          '200': response(
            'ReadResult; supplied immutable revision, current source/project gate.',
            ReadResultSchema,
          ),
          '400': error,
          '401': error,
          '403': error,
          '404': error,
        },
      },
    },
  },
};
