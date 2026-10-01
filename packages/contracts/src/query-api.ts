import { Type } from '@sinclair/typebox';
import { Id, SearchSchema, ReadSchema } from './index.ts';

/** Query surface only. Mutations keep their existing owner-only gates. */
export const QueryRoutes = {
  projects: '/api/projects',
  tree: '/api/projects/:id/tree',
  search: '/api/projects/:id/search',
  read: '/api/projects/:id/read',
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
      schema: Type.Object({
        error: Type.Object({
          code: Type.String(),
          message: Type.String(),
          correlationId: Type.String(),
        }),
      }),
    },
  },
};
const response = (description: string, schema: object) => ({
  description,
  content: { 'application/json': { schema } },
});
// Shapes of query responses remain the exported FileEntry/SearchResult/ReadResult
// contracts. This first document deliberately covers requests/auth, not all APIs.
export const QueryOpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'OpenContext query API',
    version: '0.1.0-preview',
    description:
      'Controlled loopback preview. Query subset; REST/MCP recheck current project/source authorization, including historical reads. Response shapes: exported contracts. Not a complete management API or production readiness claim.',
  },
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: { SearchInput: SearchSchema, ReadInput: ReadSchema },
  },
  paths: {
    [QueryRoutes.projects.replace(':id', '{id}')]: {
      get: {
        operationId: 'listProjects',
        responses: {
          '200': response(
            'Authorized projects only.',
            Type.Array(
              Type.Object({
                id: Id,
                name: Type.String(),
                head: Type.Union([Type.String(), Type.Null()]),
                createdAt: Type.String(),
              }),
            ),
          ),
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
            Type.Array(Type.Object({}, { additionalProperties: true })),
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
            Type.Object({}, { additionalProperties: true }),
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
            required: true,
            schema,
          })),
        ],
        responses: {
          '200': response(
            'ReadResult; supplied immutable revision, current source/project gate.',
            Type.Object({}, { additionalProperties: true }),
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
