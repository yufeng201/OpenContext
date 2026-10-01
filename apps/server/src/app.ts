import Fastify, { type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import {
  CreateProjectSchema,
  CreateBindingSchema,
  SearchSchema,
  LoginSchema,
  ReadSchema,
  MAX_AUTH_TOKEN_LENGTH,
  CreatePluginBindingSchema,
  ImportUploadSchema,
} from '@opencontext/contracts';
import type {
  CreateBindingInput,
  Principal,
  ReadResult,
  SearchInput,
  CreatePluginBindingInput,
  ImportUploadInput,
} from '@opencontext/contracts';
import { Catalog } from '@opencontext/state-sqlite';
import { FileStore } from '@opencontext/storage-fs';
import { search } from '@opencontext/retrieval';
import { registerMcp } from '@opencontext/mcp';
import { Coordinator } from './coordinator.ts';
import type { StaticRegistry } from '@opencontext/plugin-host';
import type { FeishuChatOptions } from '@opencontext/feishu-chat';
import { Type } from '@sinclair/typebox';
import {
  createDefaultRegistry,
  bindingSelection,
  prepareLegacyBinding,
} from './plugins.ts';

export type ApplicationOptions = {
  dataRoot: string;
  dataMode?: 'demo' | 'private';
  ownerToken: string;
  allowedLocalRepoRoot?: string;
  webRoot?: string;
  autoStart?: boolean;
  registry?: StaticRegistry;
  /** Reviewed server-side dependency injection; never accepted by a client body. */
  feishu?: Omit<FeishuChatOptions, 'stateRoot'>;
};
export function createApplication(options: ApplicationOptions) {
  if (options.ownerToken.length < 32) throw new Error('OWNER_TOKEN_TOO_SHORT');
  if (options.ownerToken.length > MAX_AUTH_TOKEN_LENGTH)
    throw new Error('OWNER_TOKEN_TOO_LONG');
  const registry =
    options.registry ?? createDefaultRegistry(options.dataRoot, options.feishu);
  mkdirSync(options.dataRoot, { recursive: true, mode: 0o700 });
  const catalog = new Catalog(resolve(options.dataRoot, 'control.sqlite'), {
    mode: options.dataMode ?? 'private',
  });
  try {
    catalog.migrateLegacyBindings((binding) =>
      prepareLegacyBinding(registry, binding),
    );
  } catch (error) {
    catalog.close();
    throw error;
  }
  const store = new FileStore(options.dataRoot);
  const coordinator = new Coordinator(
    catalog,
    store,
    options.dataRoot,
    registry,
    options.allowedLocalRepoRoot,
  );
  const app = Fastify({
    logger: false,
    bodyLimit: 65_536,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const currentCredentials = new WeakMap<Principal, string>();
  function credential(request: FastifyRequest): string {
    const header = request.headers.authorization;
    if (header) return header.startsWith('Bearer ') ? header.slice(7) : '';
    const item = request.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('oc_session='));
    try {
      return item ? decodeURIComponent(item.slice('oc_session='.length)) : '';
    } catch {
      return '';
    }
  }
  function authenticate(request: FastifyRequest): Principal {
    const token = credential(request),
      principal = catalog.authenticate(token, options.ownerToken);
    if (!principal) throw new Error('UNAUTHORIZED');
    currentCredentials.set(principal, token);
    return principal;
  }
  function authorize(
    principal: Principal,
    projectId?: string,
    ownerOnly = false,
  ): void {
    // Revalidate the credential at every service gate, including reads after a
    // search candidate and every MCP tool invocation.
    const token = currentCredentials.get(principal);
    const now = token && catalog.authenticate(token, options.ownerToken);
    if (!now) throw new Error('UNAUTHORIZED');
    if (ownerOnly && now.role !== 'owner') throw new Error('FORBIDDEN');
    if (projectId && now.role !== 'owner' && now.projectId !== projectId)
      throw new Error('FORBIDDEN');
    if (projectId && !catalog.getProject(projectId))
      throw new Error('NOT_FOUND');
  }
  const services = {
    authenticate,
    projects(principal: Principal) {
      authorize(principal);
      return catalog
        .listProjects()
        .filter(
          (p) => principal.role === 'owner' || p.id === principal.projectId,
        );
    },
    tree(principal: Principal, projectId: string) {
      authorize(principal, projectId);
      return catalog
        .currentFiles(projectId)
        .filter(
          (file) =>
            !file.tombstone &&
            file.freshness !== 'invalid' &&
            catalog.getBinding(file.bindingId)?.active,
        );
    },
    read(
      principal: Principal,
      projectId: string,
      fileId: string,
      revisionId: string,
    ): ReadResult {
      authorize(principal, projectId);
      const currentFiles = new Map(
        catalog.currentFiles(projectId).map((file) => [file.fileId, file]),
      );
      const current = currentFiles.get(fileId);
      // Explicit source history survives deletion. Invalid derived content does
      // not become readable again when a later full output set tombstones it.
      if (
        !current ||
        !catalog.getBinding(current.bindingId)?.active ||
        (current.freshness === 'invalid' &&
          !(current.collection === 'sources' && current.tombstone))
      )
        throw new Error('NOT_FOUND');
      const revision = catalog.getRevision(projectId, fileId, revisionId);
      if (
        !revision ||
        revision.derivedFrom.some((dep) => {
          const origin = currentFiles.get(dep.fileId);
          return (
            !origin ||
            !catalog.getBinding(origin.bindingId)?.active ||
            origin.tombstone ||
            origin.freshness === 'invalid'
          );
        })
      )
        throw new Error('NOT_FOUND');
      // Evaluate the requested revision. Regenerating a current output cannot
      // make an older output (or its old inputs) fresh again.
      const freshness: ReadResult['file']['freshness'] =
        current.freshness === 'invalid'
          ? 'invalid'
          : current.revisionId !== revisionId ||
              current.freshness === 'stale' ||
              revision.derivedFrom.some((dep) => {
                const origin = currentFiles.get(dep.fileId)!;
                return (
                  origin.revisionId !== dep.revisionId ||
                  origin.freshness !== 'fresh'
                );
              })
            ? 'stale'
            : 'fresh';
      const file: ReadResult['file'] = {
        ...(current.revisionId === revisionId ? current : revision),
        freshness,
      };
      const commitId =
        current.revisionId === revisionId
          ? catalog.head(projectId)
          : catalog.getRevisionCommit(projectId, fileId, revisionId);
      if (!commitId) throw new Error('NOT_FOUND');
      const text = store.readText(file.contentHash);
      authorize(principal, projectId);
      return {
        file,
        text,
        citation: {
          uri: 'oc://space/' + projectId + '/file/' + fileId + '@' + revisionId,
          projectId,
          fileId,
          revisionId,
          commitId,
          path: file.logicalPath,
          contentHash: file.contentHash,
          sourceVersion: file.sourceVersion,
        },
      };
    },
    search(principal: Principal, projectId: string, input: SearchInput) {
      authorize(principal, projectId);
      return search(
        {
          listFiles: (id) => services.tree(principal, id),
          read: (id, file, revision) =>
            services.read(principal, id, file, revision),
          head: (id) => {
            authorize(principal, id);
            return catalog.head(id);
          },
          candidates: (id, query, limit) => {
            authorize(principal, id);
            return coordinator.index.candidates(id, query, limit);
          },
          indexReady: (id) => {
            authorize(principal, id);
            const head = catalog.head(id);
            return !!head && coordinator.index.isReady(id, head);
          },
        },
        projectId,
        input,
      );
    },
  };
  app.addHook('onRequest', (request, _reply, done) => {
    const host = request.headers.host ?? '';
    let hostname: string;
    try {
      hostname = new URL('http://' + host).hostname;
    } catch {
      return done(new Error('UNTRUSTED_HOST'));
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname))
      return done(new Error('UNTRUSTED_HOST'));
    const origin = request.headers.origin;
    if (origin && origin !== 'http://' + host && origin !== 'https://' + host)
      return done(new Error('UNTRUSTED_ORIGIN'));
    done();
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : '';
    const frameworkCode =
      error && typeof error === 'object' && 'code' in error ? error.code : null;
    const code =
      frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? 'PAYLOAD_TOO_LARGE'
        : frameworkCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
            frameworkCode === 'FST_ERR_CTP_EMPTY_JSON_BODY'
          ? 'INVALID_JSON'
          : error && typeof error === 'object' && 'validation' in error
            ? 'INVALID_SCHEMA'
            : /^[A-Z][A-Z0-9_]+$/.test(message)
              ? message
              : 'INTERNAL_ERROR';
    const status =
      code === 'PAYLOAD_TOO_LARGE'
        ? 413
        : code === 'UNAUTHORIZED'
          ? 401
          : ['FORBIDDEN', 'UNTRUSTED_HOST', 'UNTRUSTED_ORIGIN'].includes(code)
            ? 403
            : code === 'NOT_FOUND'
              ? 404
              : [
                    'HEAD_MOVED',
                    'OUTPUT_CONFLICT',
                    'LEASE_LOST',
                    'BINDING_REVOKED',
                    'IMPORT_CONFLICT',
                    'INPUT_CHANGED',
                    'PLUGIN_LOCK_MISMATCH',
                    'PLUGIN_ARTIFACT_CHANGED',
                  ].includes(code)
                ? 409
                : code === 'INVALID_SCHEMA' ||
                    /^(PARTIAL_|UNSUPPORTED_|EMPTY_|DUPLICATE_|PROJECT_SCOPE_|SESSION_ID_|SECRET_)/.test(
                      code,
                    ) ||
                    code.startsWith('INVALID_') ||
                    [
                      'IMPORT_LIMIT',
                      'IMPORTS_NOT_SUPPORTED',
                      'PLUGIN_NOT_FOUND',
                      'UNKNOWN_PLUGIN',
                      'PLUGIN_CAPABILITY_MISMATCH',
                      'CAPABILITY_OR_INSTANCE_MISMATCH',
                      'CAPABILITY_MISSING',
                      'PLUGIN_UNAVAILABLE',
                      'CONNECTION_TEST_UNSUPPORTED',
                    ].includes(code)
                  ? 400
                  : 500;
    void reply.code(status).send({
      error: {
        code,
        message:
          code === 'INTERNAL_ERROR' ? 'Request could not be completed' : code,
        correlationId: randomUUID(),
      },
    });
  });
  app.get('/api/health', () => ({ status: 'ok', schemaVersion: 1 }));
  app.post<{ Body: { token: string } }>(
    '/api/session',
    { schema: { body: LoginSchema } },
    (request, reply) => {
      const principal = catalog.authenticate(
        request.body.token,
        options.ownerToken,
      );
      if (!principal) throw new Error('UNAUTHORIZED');
      reply.header(
        'Set-Cookie',
        'oc_session=' +
          encodeURIComponent(request.body.token) +
          '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800',
      );
      return principal;
    },
  );
  app.get('/api/session', (request) => authenticate(request));
  app.delete('/api/session', (_request, reply) => {
    reply.header(
      'Set-Cookie',
      'oc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );
    return { ok: true };
  });
  app.get('/api/projects', (request) =>
    services.projects(authenticate(request)),
  );
  app.post<{ Body: { name: string } }>(
    '/api/projects',
    { schema: { body: CreateProjectSchema } },
    (request) => {
      authorize(authenticate(request), undefined, true);
      return catalog.createProject(request.body.name);
    },
  );
  type ProjectParams = { id: string };
  type BindingParams = { id: string; bindingId: string };
  app.get('/api/plugins', (request) => {
    authorize(authenticate(request), undefined, true);
    return registry.list();
  });
  app.get<{ Params: ProjectParams }>(
    '/api/projects/:id/bindings',
    (request) => {
      const principal = authenticate(request);
      authorize(principal, request.params.id);
      return catalog
        .listBindings(request.params.id)
        .filter((binding) => principal.role === 'owner' || binding.active);
    },
  );
  app.post<{
    Params: ProjectParams;
    Body: CreateBindingInput | CreatePluginBindingInput;
  }>(
    '/api/projects/:id/bindings',
    {
      schema: {
        body: Type.Union([CreateBindingSchema, CreatePluginBindingSchema]),
      },
    },
    async (request) => {
      authorize(authenticate(request), request.params.id, true);
      const selection = bindingSelection(request.body);
      const context = options.allowedLocalRepoRoot
        ? { allowedLocalRepoRoot: options.allowedLocalRepoRoot }
        : {};
      const connector = await registry.prepare(
        selection.connector,
        'connector',
        context,
      );
      const processor = await registry.prepare(
        selection.processor,
        'processor',
        context,
      );
      return catalog.createBinding(request.params.id, {
        name: selection.name,
        connector,
        processor,
      });
    },
  );
  function bindingGate(request: FastifyRequest<{ Params: BindingParams }>) {
    authorize(authenticate(request), request.params.id, true);
    const binding = catalog.getBinding(request.params.bindingId);
    if (!binding || binding.projectId !== request.params.id)
      throw new Error('NOT_FOUND');
    return binding;
  }
  app.get<{ Params: BindingParams }>(
    '/api/projects/:id/bindings/:bindingId/imports',
    (request) => {
      return catalog.listImports(bindingGate(request).id);
    },
  );
  app.post<{ Params: BindingParams }>(
    '/api/projects/:id/bindings/:bindingId/test-connection',
    async (request) => {
      const binding = bindingGate(request);
      if (!binding.active) throw new Error('BINDING_REVOKED');
      if (!binding.connector) throw new Error('CONNECTION_TEST_UNSUPPORTED');
      const result = await registry.testConnection(
        binding.connector,
        AbortSignal.timeout(15_000),
      );
      const current = bindingGate(request);
      if (!current.active) throw new Error('BINDING_REVOKED');
      return result;
    },
  );
  app.post<{ Params: BindingParams; Body: ImportUploadInput }>(
    '/api/projects/:id/bindings/:bindingId/imports',
    { bodyLimit: 2_105_344, schema: { body: ImportUploadSchema } },
    async (request) => {
      const binding = bindingGate(request);
      if (!binding.active) throw new Error('BINDING_REVOKED');
      if (
        !binding.connector ||
        !registry.resolve(binding.connector, 'connector').acceptsImports
      )
        throw new Error('IMPORTS_NOT_SUPPORTED');
      if (Buffer.byteLength(request.body.content) > 1_048_576)
        throw new Error('PAYLOAD_TOO_LARGE');
      try {
        JSON.parse(request.body.content);
      } catch {
        throw new Error('INVALID_JSON');
      }
      try {
        await registry.validateImport(binding.connector, request.body.content);
      } catch (error) {
        const code =
          error instanceof Error
            ? /^[A-Z][A-Z0-9_]+(?::|$)/
                .exec(error.message)?.[0]
                .replace(/:$/, '')
            : undefined;
        // Do not retain arbitrary native-plugin diagnostics containing imported
        // text or credentials in the HTTP error chain; expose only a stable code.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(code ?? 'INVALID_IMPORT');
      }
      bindingGate(request);
      if (!catalog.getBinding(binding.id)?.active)
        throw new Error('BINDING_REVOKED');
      const object = store.putText(request.body.content);
      return catalog.putImport(
        binding.id,
        {
          id: randomUUID(),
          filename: request.body.filename,
          ...object,
        },
        request.body.expectedObjectId ?? null,
      );
    },
  );
  app.delete<{ Params: BindingParams & { objectId: string } }>(
    '/api/projects/:id/bindings/:bindingId/imports/:objectId',
    (request) => {
      catalog.removeImport(bindingGate(request).id, request.params.objectId);
      return { ok: true };
    },
  );
  for (const [action, kind] of [
    ['sync', 'sync'],
    ['process', 'process'],
  ] as const) {
    app.post<{ Params: BindingParams }>(
      '/api/projects/:id/bindings/:bindingId/' + action,
      (request, reply) => {
        const binding = bindingGate(request);
        const run = catalog.enqueue(binding.id, kind);
        reply.code(202);
        return run;
      },
    );
  }
  app.delete<{ Params: BindingParams }>(
    '/api/projects/:id/bindings/:bindingId',
    (request) => {
      catalog.revokeBinding(bindingGate(request).id);
      return { ok: true };
    },
  );
  app.get<{ Params: ProjectParams }>('/api/projects/:id/runs', (request) => {
    const principal = authenticate(request);
    authorize(principal, request.params.id);
    return catalog
      .listRuns(request.params.id)
      .filter(
        (run) =>
          principal.role === 'owner' ||
          catalog.getBinding(run.bindingId)?.active,
      );
  });
  app.get<{ Params: ProjectParams }>('/api/projects/:id/tree', (request) =>
    services.tree(authenticate(request), request.params.id),
  );
  app.post<{ Params: ProjectParams; Body: SearchInput }>(
    '/api/projects/:id/search',
    { schema: { body: SearchSchema } },
    (request) =>
      services.search(authenticate(request), request.params.id, request.body),
  );
  app.get<{
    Params: ProjectParams;
    Querystring: { fileId: string; revisionId: string };
  }>(
    '/api/projects/:id/read',
    { schema: { querystring: ReadSchema } },
    (request) =>
      services.read(
        authenticate(request),
        request.params.id,
        request.query.fileId,
        request.query.revisionId,
      ),
  );
  app.post<{ Params: ProjectParams }>('/api/projects/:id/tokens', (request) => {
    authorize(authenticate(request), request.params.id, true);
    return catalog.createReaderToken(request.params.id);
  });
  app.delete<{ Params: { tokenId: string } }>(
    '/api/tokens/:tokenId',
    (request) => {
      authorize(authenticate(request), undefined, true);
      catalog.revokeToken(request.params.tokenId);
      return { ok: true };
    },
  );
  registerMcp(app, services);
  const webRoot = resolve(options.webRoot ?? 'apps/web/dist');
  app.get('/*', (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/mcp'))
      throw new Error('NOT_FOUND');
    let path: string;
    try {
      path = resolve(
        webRoot,
        '.' + new URL(request.url, 'http://localhost').pathname,
      );
    } catch {
      throw new Error('NOT_FOUND');
    }
    if (relative(webRoot, path).startsWith('..')) throw new Error('NOT_FOUND');
    if (!existsSync(path) || !extname(path))
      path = resolve(webRoot, 'index.html');
    if (!existsSync(path))
      return reply
        .code(503)
        .type('text/plain')
        .send('Web not built. Run pnpm build.');
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    return reply
      .type(types[extname(path)] ?? 'application/octet-stream')
      .header('X-Content-Type-Options', 'nosniff')
      .send(readFileSync(path));
  });
  app.addHook('onClose', async () => {
    await coordinator.stop();
    catalog.close();
  });
  if (options.autoStart !== false) coordinator.start();
  return { app, catalog, store, coordinator, services };
}
