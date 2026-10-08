import { it, expect } from 'vitest';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { registerMcp } from '../src/index.ts';
import type { ReadResult } from '@opencontext/contracts';
for (const mode of ['extra', 'hash', 'budget'] as const)
  it(`real MCP wire rejects ${mode} response without raw text or success audit`, async () => {
    const secret = 'PRIVATE_UPSTREAM_SENTINEL',
      text = mode === 'budget' ? secret + 'x'.repeat(16 * 1024 * 1024) : secret;
    const file = {
      fileId: 'f1',
      revisionId: 'r1',
      contentHash: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
      projectId: 'p1',
      bindingId: 'b1',
      slotKey: 'note',
      logicalPath: 'sources/note.md',
      collection: 'sources' as const,
      ownership: 'source_managed' as const,
      freshness: 'fresh' as const,
      tombstone: false,
      sourceVersion: 'v1',
      createdAt: '2026-10-02T00:00:00Z',
      derivedFrom: [],
    };
    const citation = {
      uri: 'oc://space/p1/file/f1@r1',
      projectId: 'p1',
      fileId: 'f1',
      revisionId: 'r1',
      commitId: 'c1',
      path: file.logicalPath,
      contentHash: file.contentHash,
      sourceVersion: 'v1',
    };
    const value =
      mode === 'extra'
        ? { file, text, citation, secret }
        : mode === 'hash'
          ? { file, text: text.toLowerCase(), citation }
          : { file, text, citation };
    const audits: string[] = [];
    const app = Fastify({ logger: false });
    registerMcp(app, {
      authenticate: () => ({ id: 'fixture', role: 'owner', projectId: null }),
      projects: () => [],
      tree: () => [file],
      search: () => ({
        servedCommit: 'c1',
        hits: [],
        indexCoverage: 'ready',
        degraded: false,
        mode: 'grep',
      }),
      read: () => value as ReadResult,
      audit: (_r, _t, _a, code) => audits.push(code),
    });
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(origin + '/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'context_read',
            arguments: { projectId: 'p1', fileId: 'f1', revisionId: 'r1' },
          },
        }),
      });
      const raw = await response.text();
      expect(raw.length).toBeLessThan(1000);
      expect(raw).not.toContain(secret);
      const result = JSON.parse(raw);
      expect(result.result).toBeUndefined();
      expect(result.error.message).toBe(
        mode === 'budget' ? 'BYTE_LIMIT' : 'INVALID_RESPONSE',
      );
      expect(audits).toEqual([
        mode === 'budget' ? 'BYTE_LIMIT' : 'INVALID_RESPONSE',
      ]);
    } finally {
      await app.close();
    }
  });
