import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createApplication } from '../../../apps/server/src/app.ts';
import { OpenContextClient } from '../../../packages/http-client/src/index.ts';
import {
  parseQueryResponse,
  FilePageSchema,
} from '../../../packages/contracts/src/query-api.ts';
it('live REST/SDK/CLI/MCP share bounded file pages, fixed reads and stale/revoked cursor rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-page-protocol-')),
    repo = join(root, 'repo'),
    owner = 'synthetic-pagination-owner-0000000000';
  mkdirSync(repo);
  const git = (...a: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...a,
      ],
      {
        cwd: repo,
        stdio: 'ignore',
        env: {
          PATH: process.env['PATH'],
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        timeout: 5000,
      },
    );
  git('init', '-b', 'main');
  for (let n = 0; n < 5; n++)
    writeFileSync(join(repo, `file-${n}.md`), `page_unique_${n}`);
  git('add', '.');
  git('commit', '-m', 'Synthetic');
  const app = createApplication({
    dataRoot: join(root, 'data'),
    ownerToken: owner,
    allowedLocalRepoRoot: root,
    autoStart: false,
  });
  let mcp: Client | undefined;
  try {
    const origin = await app.app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { authorization: 'Bearer ' + owner };
    const p = (
      await app.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: 'Pages' },
      })
    ).json();
    const b = (
      await app.app.inject({
        method: 'POST',
        url: `/api/projects/${p.id}/bindings`,
        headers,
        payload: { name: 'Repo', repoUrl: repo },
      })
    ).json();
    const sync = async () => {
      await app.app.inject({
        method: 'POST',
        url: `/api/projects/${p.id}/bindings/${b.id}/sync`,
        headers,
      });
      await app.coordinator.drain();
    };
    await sync();
    const reader = app.catalog.createReaderToken(p.id),
      sdk = new OpenContextClient({ baseUrl: origin, token: reader.token });
    const full = await sdk.tree(p.id),
      first = await sdk.filesPage(p.id, { limit: 2 });
    expect(first.files).toEqual(full.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await sdk.filesPage(p.id, {
        limit: 2,
        cursor: first.nextCursor!,
      }),
      third = await sdk.filesPage(p.id, {
        limit: 2,
        cursor: second.nextCursor!,
      });
    expect([...first.files, ...second.files, ...third.files]).toEqual(full);
    expect(third.nextCursor).toBeNull();
    await sdk.read(p.id, first.files[0]!.fileId, first.files[0]!.revisionId);
    mcp = new Client({ name: 'page-conformance', version: '0.1.0' });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: 'Bearer ' + reader.token } },
      }) as Transport,
    );
    const tools = await mcp.listTools();
    expect(
      tools.tools.every((t) => t.outputSchema?.['type'] === 'object'),
    ).toBe(true);
    const result = await mcp.callTool({
      name: 'context_tree',
      arguments: { projectId: p.id, limit: 2 },
    });
    expect(
      parseQueryResponse(FilePageSchema, result.structuredContent, {
        projectId: p.id,
        limit: 2,
      }),
    ).toEqual(first);
    const cli = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((resolve) => {
      const c = spawn(
        process.execPath,
        ['scripts/opencontext.ts', 'files', p.id, '2', first.nextCursor!],
        {
          env: {
            PATH: process.env['PATH'],
            OPENCONTEXT_URL: origin,
            OPENCONTEXT_QUERY_TOKEN: reader.token,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '',
        err = '';
      c.stdout.on('data', (x) => (out += x));
      c.stderr.on('data', (x) => (err += x));
      c.on('close', (code) => resolve({ code, out, err }));
    });
    expect(cli.code).toBe(0);
    expect(JSON.parse(cli.out)).toEqual(second);
    expect(cli.err).toBe('');
    for (const query of [
      'limit=0',
      'limit=201',
      'limit=2&extra=secret',
      'cursor=bad',
    ]) {
      const r = await fetch(origin + `/api/projects/${p.id}/files?` + query, {
        headers: { authorization: 'Bearer ' + reader.token },
      });
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).not.toContain('secret');
    }
    const unknown = await fetch(
      origin + `/api/projects/${p.id}/tree?cursor=ignored`,
      { headers: { authorization: 'Bearer ' + reader.token } },
    );
    expect(unknown.status).toBe(400);
    const other = app.catalog.createProject('Other');
    await expect(
      sdk.filesPage(other.id, { cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    writeFileSync(join(repo, 'file-0.md'), 'new pinned version');
    git('add', '.');
    git('commit', '-m', 'Update');
    await sync();
    await expect(
      sdk.filesPage(p.id, { cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: 'CURSOR_STALE', status: 409 });
    const current = await sdk.filesPage(p.id, { limit: 2 });
    app.catalog.revokeBinding(b.id);
    await expect(
      sdk.filesPage(p.id, { cursor: current.nextCursor! }),
    ).rejects.toMatchObject({ code: 'CURSOR_STALE', status: 409 });
    expect((await sdk.filesPage(p.id)).files).toEqual([]);
    app.catalog.revokeToken(reader.id);
    await expect(sdk.filesPage(p.id)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
  } finally {
    await mcp?.close();
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
