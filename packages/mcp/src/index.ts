import { safeErrorCode } from '@opencontext/contracts/errors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Id, ReadSchema, SearchSchema } from '@opencontext/contracts';
import type {
  FileEntry,
  Principal,
  Project,
  ReadResult,
  SearchInput,
  SearchResult,
} from '@opencontext/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type McpHandlers = {
  audit?(
    request: FastifyRequest,
    tool: string,
    args: unknown,
    code: string,
  ): void;
  authenticate(request: FastifyRequest): Principal;
  projects(principal: Principal): Project[];
  tree(principal: Principal, projectId: string): FileEntry[];
  search(
    principal: Principal,
    projectId: string,
    input: SearchInput,
  ): SearchResult;
  read(
    principal: Principal,
    projectId: string,
    fileId: string,
    revisionId: string,
  ): ReadResult;
};

const ProjectSchema = Type.Object(
  { projectId: Id },
  { additionalProperties: false },
);
const McpSearchSchema = Type.Object(
  { projectId: Id, ...SearchSchema.properties },
  { additionalProperties: false },
);
const McpReadSchema = Type.Object(
  { projectId: Id, ...ReadSchema.properties },
  { additionalProperties: false },
);
const toolSchemas = {
  context_search: McpSearchSchema,
  context_read: McpReadSchema,
  context_tree: ProjectSchema,
};

/** Stateless authenticated HTTP transport. No OAuth, sessions, or write tools. */
export function registerMcp(app: FastifyInstance, handlers: McpHandlers): void {
  app.post('/mcp', async (request, reply) => {
    handlers.authenticate(request);
    const server = new Server(
      { name: 'opencontext', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => {
      handlers.authenticate(request);
      return {
        tools: Object.entries(toolSchemas).map(([name, schema]) => ({
          name,
          description:
            name === 'context_search'
              ? 'Search source and derived files within an explicitly authorized project. Read cited revisions before using them.'
              : name === 'context_read'
                ? 'Read a fixed file revision; current project authorization still applies.'
                : 'List current authorized project files; deleted and invalid files are excluded.',
          inputSchema: schema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        })),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, (message) => {
      try {
        const principal = handlers.authenticate(request);
        const args = message.params.arguments;
        let result: SearchResult | ReadResult | { files: FileEntry[] };
        switch (message.params.name) {
          case 'context_search': {
            if (!Value.Check(McpSearchSchema, args))
              throw new McpError(
                ErrorCode.InvalidParams,
                'Invalid search arguments',
              );
            const { projectId, ...input } = args;
            result = handlers.search(principal, projectId, input);
            break;
          }
          case 'context_read': {
            if (!Value.Check(McpReadSchema, args))
              throw new McpError(
                ErrorCode.InvalidParams,
                'Invalid read arguments',
              );
            result = handlers.read(
              principal,
              args.projectId,
              args.fileId,
              args.revisionId,
            );
            break;
          }
          case 'context_tree': {
            if (!Value.Check(ProjectSchema, args))
              throw new McpError(
                ErrorCode.InvalidParams,
                'Invalid tree arguments',
              );
            result = {
              files: handlers
                .tree(principal, args.projectId)
                .filter(
                  (file) =>
                    file.projectId === args.projectId &&
                    !file.tombstone &&
                    file.freshness !== 'invalid',
                ),
            };
            break;
          }
          default:
            throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool');
        }
        handlers.audit?.(request, message.params.name, args, 'OK');
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        handlers.audit?.(
          request,
          message.params.name,
          message.params.arguments,
          error instanceof McpError ? 'INVALID_SCHEMA' : safeErrorCode(error),
        );
        if (error instanceof McpError) {
          const known = [
            new McpError(ErrorCode.InvalidParams, 'Invalid search arguments'),
            new McpError(ErrorCode.InvalidParams, 'Invalid read arguments'),
            new McpError(ErrorCode.InvalidParams, 'Invalid tree arguments'),
            new McpError(ErrorCode.MethodNotFound, 'Unknown tool'),
          ].find(
            (candidate) =>
              candidate.code === error.code &&
              candidate.message === error.message,
          );
          if (known) throw known;
        }
        // Deliberately discard arbitrary native causes before SDK serialization.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(safeErrorCode(error));
      }
    });
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    // SDK 1.31 transport classes explicitly include undefined on optional
    // members while its Transport interface does not. Keep the compatibility
    // assertion at this vendor boundary; do not weaken project strictness.
    await server.connect(transport as Transport);
    reply.raw.once('close', () => {
      void server.close();
    });
    reply.raw.setHeader('X-Request-Id', request.id);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: ErrorCode.InternalError,
              message: 'MCP request failed',
            },
          }),
        );
      }
      await server.close();
    }
  });
  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    handler: (request, reply) => {
      handlers.authenticate(request);
      return reply
        .code(405)
        .header('allow', 'POST')
        .send({ error: 'STATELESS_POST_ONLY' });
    },
  });
}
