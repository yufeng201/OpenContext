import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createApplication } from '../../apps/server/src/app.ts';
import {
  OpenContextClient,
  OpenContextError,
} from '../../packages/http-client/src/index.ts';
import {
  QueryOpenApi,
  QueryRoutes,
  projectQueryPath,
} from '../../packages/contracts/src/query-api.ts';
import type {
  Project,
  Binding,
  FileEntry,
} from '../../packages/contracts/src/index.ts';

it('SDK rejects credential URLs, plaintext remote origins and unsafe project path segments', () => {
  const token = 'synthetic-query-client-token';
  for (const baseUrl of [
    'http://example.com',
    'http://user:pass@localhost',
    'http://localhost/?token=x',
    'file:///tmp/x',
    'http://localhost/api',
  ])
    expect(() => new OpenContextClient({ baseUrl, token })).toThrow();
  for (const id of ['', '..', '../other', 'a/b', 'a%2Fb'])
    expect(() => projectQueryPath(QueryRoutes.read, id)).toThrow(
      'INVALID_PROJECT_ID',
    );
  expect(projectQueryPath(QueryRoutes.tree, 'project-123')).toBe(
    '/api/projects/project-123/tree',
  );
});
it('does not follow redirects or reveal arbitrary error bodies', async () => {
  let init: RequestInit | undefined;
  const token = 'synthetic-query-client-token';
  const client = new OpenContextClient({
    baseUrl: 'http://localhost:4310',
    token,
    fetch: async (_url, options) => {
      init = options;
      return new Response(
        JSON.stringify({
          error: {
            code: 'secret ' + token,
            message: token,
            correlationId: token,
          },
        }),
        { status: 403 },
      );
    },
  });
  await expect(client.projects()).rejects.toMatchObject({
    status: 403,
    code: 'HTTP_ERROR',
    message: 'HTTP_ERROR',
    correlationId: undefined,
  });
  expect(init?.redirect).toBe('error');
  expect(init?.credentials).toBe('omit');
});
it('REST, SDK, MCP and CLI share fixed reads and current permission gates on a live synthetic server', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-query-access-'));
  const repo = resolve(root, 'repo');
  mkdirSync(repo);
  const token = 'synthetic-query-owner-token-0000000000';
  const headers = { authorization: 'Bearer ' + token };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd: repo,
        env: {
          PATH: process.env['PATH'],
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdio: 'ignore',
      },
    );
  git('init', '-b', 'main');
  writeFileSync(resolve(repo, 'README.md'), '# Synthetic\nquery-sdk-needle\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const app = createApplication({
    dataRoot: resolve(root, 'data'),
    ownerToken: token,
    allowedLocalRepoRoot: root,
    autoStart: false,
  });
  try {
    const baseUrl = await app.app.listen({ host: '127.0.0.1', port: 0 });
    const project = (
      await app.app.inject({
        method: 'POST',
        url: QueryRoutes.projects,
        headers,
        payload: { name: 'Query fixture' },
      })
    ).json<Project>();
    const binding = (
      await app.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/bindings`,
        headers,
        payload: { name: 'Synthetic', repoUrl: repo, branch: 'main' },
      })
    ).json<Binding>();
    await app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/bindings/${binding.id}/sync`,
      headers,
    });
    await app.coordinator.drain();
    const reader = app.catalog.createReaderToken(project.id);
    const client = new OpenContextClient({ baseUrl, token: reader.token });
    const tree = await client.tree(project.id);
    expect(tree.length).toBe(1);
    const file = tree[0]!;
    const hit = (
      await client.search(project.id, {
        query: 'query-sdk-needle',
        mode: 'grep',
      })
    ).hits[0]!;
    expect(hit.file.revisionId).toBe(file.revisionId);
    const fixed = await client.read(project.id, file.fileId, file.revisionId);
    expect(fixed.text).toContain('query-sdk-needle');
    expect(fixed.citation.contentHash).toBe(file.contentHash);
    const rest = (
      await app.app.inject({
        url:
          projectQueryPath(QueryRoutes.read, project.id) +
          '?' +
          new URLSearchParams({
            fileId: file.fileId,
            revisionId: file.revisionId,
          }),
        headers: { authorization: 'Bearer ' + reader.token },
      })
    ).json();
    expect(rest).toEqual(fixed);
    const mcp = async (name: string, args: Record<string, unknown>) =>
      (
        await app.app.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            authorization: 'Bearer ' + reader.token,
            accept: 'application/json, text/event-stream',
          },
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          },
        })
      ).json();
    const mcpRead = await mcp('context_read', {
      projectId: project.id,
      fileId: file.fileId,
      revisionId: file.revisionId,
    });
    expect(mcpRead.result.structuredContent).toEqual(fixed);
    const mcpSearch = await mcp('context_search', {
      projectId: project.id,
      query: 'query-sdk-needle',
      mode: 'grep',
    });
    expect(
      mcpSearch.result.structuredContent.hits.map(
        (h: { file: FileEntry }) => h.file,
      ),
    ).toEqual([hit.file]);
    const spec = (await app.app.inject({ url: '/api/openapi.json' })).json();
    expect(spec).toEqual(JSON.parse(JSON.stringify(QueryOpenApi)));
    expect(
      spec.paths['/api/projects/{id}/search'].post.requestBody.content[
        'application/json'
      ].schema.additionalProperties,
    ).toBe(false);
    const cli = async (...args: string[]) =>
      await new Promise<{ code: number | null; out: string; err: string }>(
        (done) => {
          const child = spawn(
            process.execPath,
            ['scripts/opencontext.ts', ...args],
            {
              env: {
                PATH: process.env['PATH'],
                OPENCONTEXT_URL: baseUrl,
                OPENCONTEXT_QUERY_TOKEN: reader.token,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let out = '',
            err = '';
          child.stdout.on('data', (chunk) => (out += String(chunk)));
          child.stderr.on('data', (chunk) => (err += String(chunk)));
          child.on('close', (code) => done({ code, out, err }));
        },
      );
    const output = await cli('read', project.id, file.fileId, file.revisionId);
    expect(output.code).toBe(0);
    expect(JSON.parse(output.out)).toEqual(fixed);
    expect(output.err).not.toContain(reader.token);
    const deniedWrite = await app.app.inject({
      method: 'POST',
      url: QueryRoutes.projects,
      headers: { authorization: 'Bearer ' + reader.token },
      payload: { name: 'denied' },
    });
    expect(deniedWrite.statusCode).toBe(403);
    const other = app.catalog.createProject('Other');
    await expect(client.tree(other.id)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    writeFileSync(
      resolve(repo, 'README.md'),
      '# Synthetic\nupdated-sdk-needle\n',
    );
    git('add', '.');
    git('commit', '-m', 'update');
    await app.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/bindings/${binding.id}/sync`,
      headers,
    });
    await app.coordinator.drain();
    expect(
      (await client.read(project.id, file.fileId, file.revisionId)).text,
    ).toBe(fixed.text);
    app.catalog.revokeBinding(binding.id);
    await expect(
      client.read(project.id, file.fileId, file.revisionId),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(
      (
        await client.search(project.id, {
          query: 'query-sdk-needle',
          freshness: 'include_stale',
        })
      ).hits,
    ).toEqual([]);
    const fail = await cli('read', project.id, file.fileId, file.revisionId);
    expect(fail.code).toBe(1);
    expect(JSON.parse(fail.err)).toMatchObject({
      error: 'NOT_FOUND',
      status: 404,
    });
    expect(fail.err + fail.out).not.toContain(reader.token);
    expect(fail.err + fail.out).not.toContain('query-sdk-needle');
    app.catalog.revokeToken(reader.id);
    await expect(client.projects()).rejects.toBeInstanceOf(OpenContextError);
    await expect(client.projects()).rejects.toMatchObject({ status: 401 });
  } finally {
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
