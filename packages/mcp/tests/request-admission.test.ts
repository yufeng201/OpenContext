import { it, expect } from 'vitest';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { registerMcp } from '../src/index.ts';
import type { ReadResult } from '@opencontext/contracts';
const sentinel = 'SYNTHETIC_PRIVATE_BATCH_SENTINEL';
const text = 'Synthetic single read';
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
  createdAt: '2026-10-08T00:00:00Z',
  derivedFrom: [],
};
const read: ReadResult = {
  file,
  text,
  citation: {
    uri: 'oc://space/p1/file/f1@r1',
    projectId: 'p1',
    fileId: 'f1',
    revisionId: 'r1',
    commitId: 'c1',
    path: file.logicalPath,
    contentHash: file.contentHash,
    sourceVersion: file.sourceVersion,
  },
};
const call = (id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: {
    name: 'context_read',
    arguments: { projectId: 'p1', fileId: 'f1', revisionId: 'r1' },
  },
});
async function fixture() {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  const executions = { read: 0, search: 0, tree: 0 },
    audits: string[] = [];
  let authentications = 0;
  registerMcp(app, {
    authenticate: () => {
      authentications++;
      return { id: 'synthetic', role: 'owner', projectId: null };
    },
    projects: () => [],
    tree: () => {
      executions.tree++;
      return [file];
    },
    search: () => {
      executions.search++;
      return {
        servedCommit: 'c1',
        hits: [],
        indexCoverage: 'ready',
        degraded: false,
        mode: 'grep',
      };
    },
    read: () => {
      executions.read++;
      return read;
    },
    audit: (_r, _t, _a, code) => audits.push(code),
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const post = async (body: unknown) =>
    await fetch(origin + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
  return {
    app,
    post,
    executions,
    audits,
    authentications: () => authentications,
  };
}
it('rejects every batch before transport/tool execution, including 100 reads and initialize/notification mixtures, with a closed safe error', async () => {
  const f = await fixture();
  try {
    const initialize = {
      jsonrpc: '2.0',
      id: sentinel,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: sentinel, version: '1' },
      },
    };
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    const batches = [
      [],
      [call()],
      [call(sentinel), call(2)],
      Array.from({ length: 100 }, (_, i) => call(i)),
      [initialize, call()],
      [notification, call()],
      [initialize, notification, call()],
    ];
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(65536);
      const response = await f.post(batch);
      expect(response.status).toBe(400);
      const raw = await response.text();
      expect(raw).not.toContain(sentinel);
      expect(raw).not.toContain(text);
      expect(raw.length).toBeLessThan(200);
      expect(JSON.parse(raw)).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'MCP_BATCH_UNSUPPORTED' },
      });
      expect(f.executions).toEqual({ read: 0, search: 0, tree: 0 });
      expect(f.audits).toEqual([]);
    }
    expect(f.authentications()).toBe(batches.length);
  } finally {
    await f.app.close();
  }
});
it('single initialization/notification and fixed read remain normal after batch refusals', async () => {
  const f = await fixture();
  try {
    expect((await f.post([call(), call(2)])).status).toBe(400);
    const initialized = await f.post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'synthetic', version: '1' },
      },
    });
    expect(initialized.status).toBe(200);
    expect((await initialized.json()).result.protocolVersion).toBe(
      '2025-03-26',
    );
    const notified = await f.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe('');
    expect(f.executions.read).toBe(0);
    const response = await f.post(call());
    expect(response.status).toBe(200);
    expect((await response.json()).result.structuredContent).toEqual(read);
    expect(f.executions.read).toBe(1);
    expect(f.audits).toEqual(['OK']);
  } finally {
    await f.app.close();
  }
});
