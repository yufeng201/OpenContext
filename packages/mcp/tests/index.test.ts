import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { search, TextIndex } from '@opencontext/retrieval';
import type {
  FileEntry,
  Principal,
  ReadResult,
  RetrievalPort,
  SearchResult,
} from '@opencontext/contracts';
import { registerMcp } from '../src/index.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const db = new DatabaseSync(':memory:');
  const index = new TextIndex(db);
  const text = 'Shared repository context: retries must be idempotent.';
  const file: FileEntry = {
    fileId: 'f1',
    revisionId: 'r1',
    contentHash: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    projectId: 'p1',
    bindingId: 'b1',
    slotKey: 'readme',
    logicalPath: 'sources/repo/README.md',
    collection: 'sources',
    ownership: 'source_managed',
    freshness: 'fresh',
    tombstone: false,
    sourceVersion: 'git-sha',
    createdAt: '2026-09-30T00:00:00Z',
    derivedFrom: [],
  };
  index.replaceProject('p1', 'c1', [{ file, text }]);
  const app = Fastify({ logger: false });
  let enabled = true;
  let authentications = 0;
  const principal: Principal = {
    id: 'reader',
    role: 'reader',
    projectId: 'p1',
  };
  function gate(p: Principal, projectId: string) {
    if (!enabled || p.projectId !== projectId) throw new Error('ACCESS_DENIED');
  }
  function read(
    p: Principal,
    projectId: string,
    fileId: string,
    revisionId: string,
  ): ReadResult {
    gate(p, projectId);
    if (fileId !== file.fileId || revisionId !== file.revisionId)
      throw new Error('NOT_FOUND');
    return {
      file,
      text,
      citation: {
        uri: `oc://project/${projectId}/file/${fileId}@${revisionId}`,
        projectId,
        fileId,
        revisionId,
        commitId: 'c1',
        path: file.logicalPath,
        contentHash: file.contentHash,
        sourceVersion: file.sourceVersion,
      },
    };
  }
  function port(p: Principal): RetrievalPort {
    return {
      head: (id) => {
        gate(p, id);
        return 'c1';
      },
      listFiles: (id) => {
        gate(p, id);
        return [file];
      },
      read: (id, fileId, rev) => read(p, id, fileId, rev),
      candidates: (id, query, limit) => {
        gate(p, id);
        return index.candidates(id, query, limit);
      },
      indexReady: (id) => {
        gate(p, id);
        return index.isReady(id, 'c1');
      },
    };
  }
  registerMcp(app, {
    authenticate: (req) => {
      authentications++;
      if (
        !enabled ||
        req.headers.authorization !== 'Bearer synthetic-test-token'
      ) {
        throw Object.assign(new Error('UNAUTHENTICATED'), { statusCode: 401 });
      }
      return principal;
    },
    projects: (p) => {
      gate(p, 'p1');
      return [
        { id: 'p1', name: 'Fixture', head: 'c1', createdAt: file.createdAt },
      ];
    },
    tree: (p, id) => {
      gate(p, id);
      return [file];
    },
    search: (p, id, input) => search(port(p), id, input),
    read,
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => {
    await app.close();
    db.close();
  });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { authorization: 'Bearer synthetic-test-token' } },
  });
  const client = new Client({ name: 'opencontext-fixture', version: '0.0.0' });
  // Same SDK optional-property compatibility boundary as the server adapter.
  await client.connect(transport as Transport);
  cleanups.push(() => client.close());
  return {
    app,
    origin,
    client,
    file,
    text,
    revoke: () => {
      enabled = false;
    },
    authentications: () => authentications,
  };
}

describe('authenticated stateless MCP over real loopback HTTP', () => {
  it('initializes, lists TypeBox tools, searches then reads a matching fixed citation', async () => {
    const f = await fixture();
    const tools = await f.client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'context_read',
      'context_search',
      'context_tree',
    ]);
    expect(
      tools.tools.every((t) => t.inputSchema.required?.includes('projectId')),
    ).toBe(true);
    const found = await f.client.callTool({
      name: 'context_search',
      arguments: { projectId: 'p1', query: 'idempotent' },
    });
    const result = found.structuredContent as SearchResult;
    expect(result.hits).toHaveLength(1);
    const citation = result.hits[0]!.citation;
    const read = await f.client.callTool({
      name: 'context_read',
      arguments: {
        projectId: 'p1',
        fileId: citation.fileId,
        revisionId: citation.revisionId,
      },
    });
    const content = read.structuredContent as ReadResult;
    expect(content.text).toBe(f.text);
    expect(content.citation).toEqual(citation);
    expect(createHash('sha256').update(content.text).digest('hex')).toBe(
      citation.contentHash,
    );
    const tree = await f.client.callTool({
      name: 'context_tree',
      arguments: { projectId: 'p1' },
    });
    expect(tree.structuredContent).toEqual({ files: [f.file] });
    expect(f.authentications()).toBeGreaterThanOrEqual(10);
  });

  it('requires explicit project scope and refuses cross-project reads and unknown fields', async () => {
    const f = await fixture();
    await expect(
      f.client.callTool({
        name: 'context_search',
        arguments: { query: 'context' },
      }),
    ).rejects.toThrow('Invalid search arguments');
    await expect(
      f.client.callTool({
        name: 'context_tree',
        arguments: { projectId: 'p2' },
      }),
    ).rejects.toThrow('ACCESS_DENIED');
    await expect(
      f.client.callTool({
        name: 'context_read',
        arguments: { projectId: 'p2', fileId: 'f1', revisionId: 'r1' },
      }),
    ).rejects.toThrow('ACCESS_DENIED');
    await expect(
      f.client.callTool({
        name: 'context_search',
        arguments: { projectId: 'p1', query: 'context', global: true },
      }),
    ).rejects.toThrow('Invalid search arguments');
    await expect(
      f.client.callTool({
        name: 'context_delete',
        arguments: { projectId: 'p1' },
      }),
    ).rejects.toThrow('Unknown tool');
  });

  it('authenticates HTTP before protocol access and rejects an already connected revoked principal', async () => {
    const f = await fixture();
    const response = await fetch(new URL('/mcp', f.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('context_search');
    f.revoke();
    await expect(
      f.client.callTool({
        name: 'context_tree',
        arguments: { projectId: 'p1' },
      }),
    ).rejects.toThrow();
    const get = await f.app.inject({ method: 'GET', url: '/mcp' });
    expect(get.statusCode).toBe(401);
  });
});
