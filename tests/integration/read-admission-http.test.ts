import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { createApplication } from '../../apps/server/src/app.ts';
import type { FileEntry } from '../../packages/contracts/src/index.ts';
const owner = 'opencontext-demo-owner-loopback-only-2026',
  headers = { authorization: 'Bearer ' + owner };
async function fixture(timeout = 15000) {
  const root = mkdtempSync(join(tmpdir(), 'oc-read-admission-'));
  const a = createApplication({
    dataRoot: root,
    ownerToken: owner,
    dataMode: 'demo',
    autoStart: false,
    readResponseTimeoutMs: timeout,
  });
  const ended = new Set<string>();
  a.app.addHook('onResponse', (request, _reply, done) => {
    ended.add(request.id);
    done();
  });
  const p = a.catalog.createProject('Synthetic permit fixture'),
    b = a.catalog.createBinding(p.id, {
      name: 'Synthetic',
      connector: {
        ref: 'fixture-connector@1',
        packageRef: 'test.connector@1.0.0',
        packageDigest: 'c'.repeat(64),
        configHash: 'd'.repeat(64),
        capability: 'connector',
        config: {},
      },
      processor: {
        ref: 'fixture-processor@1',
        packageRef: 'test.processor@1.0.0',
        packageDigest: 'e'.repeat(64),
        configHash: 'f'.repeat(64),
        capability: 'processor',
        config: {},
      },
    });
  const files: FileEntry[] = ['small', 'medium'].map((name) => ({
    ...a.store.putText(
      name === 'small' ? 'small synthetic file' : '\u0000'.repeat(1048576),
    ),
    projectId: p.id,
    bindingId: b.id,
    fileId: randomUUID(),
    revisionId: randomUUID(),
    slotKey: name + '.md',
    logicalPath: `sources/${b.id}/${name}.md`,
    collection: 'sources',
    ownership: 'source_managed',
    freshness: 'fresh',
    tombstone: false,
    sourceVersion: 'fixture',
    createdAt: new Date().toISOString(),
    derivedFrom: [],
  }));
  a.catalog.enqueue(b.id, 'sync');
  const run = a.catalog.claim()!,
    commitId = randomUUID();
  a.catalog.publish({
    projectId: p.id,
    expectedHead: null,
    commitId,
    manifestHash: a.store.manifest(p.id, commitId, null, files),
    files,
    run,
    sourceVersion: 'fixture',
  });
  const origin = await a.app.listen({ host: '127.0.0.1', port: 0 }),
    file = files[1]!;
  const path =
    `/api/projects/${p.id}/read?` +
    new URLSearchParams({ fileId: file.fileId, revisionId: file.revisionId });
  const rpc = async (fragment = false) => {
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_read',
          arguments: {
            projectId: p.id,
            fileId: file.fileId,
            revisionId: file.revisionId,
            ...(fragment ? { maxBytes: 64 } : {}),
          },
        },
      }),
    });
    return await r.json();
  };
  const held = async (kind: 'rest' | 'mcp' = 'rest') =>
    await new Promise<{ req: ClientRequest; res: IncomingMessage }>(
      (resolve, reject) => {
        const body =
          kind === 'mcp'
            ? JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'context_read',
                  arguments: {
                    projectId: p.id,
                    fileId: file.fileId,
                    revisionId: file.revisionId,
                  },
                },
              })
            : undefined;
        const req = httpRequest(
          origin + (kind === 'mcp' ? '/mcp' : path),
          {
            method: kind === 'mcp' ? 'POST' : 'GET',
            headers: {
              ...headers,
              ...(body
                ? {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                  }
                : {}),
            },
            agent: false,
          },
          (res) => {
            res.on('error', () => {});
            res.pause();
            resolve({ req, res });
          },
        );
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy());
        if (body) req.write(body);
        req.end();
      },
    );
  const clean = async () => {
    await a.app.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { a, p, file, origin, path, rpc, held, clean, ended };
}
it.each(['rest', 'mcp'] as const)(
  'held %s shares a heavy permit through backpressure, reserves fragments and releases on client cancel/error',
  async (kind) => {
    const f = await fixture(),
      read = vi.spyOn(f.a.store, 'readText');
    let held: Awaited<ReturnType<typeof f.held>> | undefined;
    try {
      held = await f.held(kind);
      expect(held.res.statusCode).toBe(200);
      expect(f.a.readAdmission.snapshot().heavy).toBe(1);
      expect(read).toHaveBeenCalledTimes(1);
      const busy = await fetch(f.origin + f.path, { headers });
      expect(busy.status).toBe(429);
      expect(busy.headers.get('retry-after')).toBe('1');
      expect((await busy.json()).error.code).toBe('RESOURCE_BUSY');
      const denied = await f.rpc();
      expect(denied.error.message).toBe('RESOURCE_BUSY');
      expect(denied.result).toBeUndefined();
      expect(read).toHaveBeenCalledTimes(1);
      const fragment = await f.rpc(true);
      expect(fragment.result.structuredContent.disclosure.returnedBytes).toBe(
        64,
      );
      expect(fragment.result.structuredContent.citation.revisionId).toBe(
        f.file.revisionId,
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(f.a.readAdmission.snapshot()).toEqual({
        heavy: 1,
        light: 0,
        lightProjects: 0,
      });
      held.req.destroy();
      held.res.destroy();
      await vi.waitFor(
        () => expect(f.a.readAdmission.snapshot().heavy).toBe(0),
        {
          timeout: 2000,
        },
      );
      read.mockImplementationOnce(() => {
        throw new Error('CORRUPT_OBJECT');
      });
      const failed = await fetch(f.origin + f.path, { headers });
      expect(failed.status).toBe(500);
      expect((await failed.json()).error.code).toBe('CORRUPT_OBJECT');
      expect(f.a.readAdmission.snapshot()).toEqual({
        heavy: 0,
        light: 0,
        lightProjects: 0,
      });
      const valid = await fetch(f.origin + f.path, { headers });
      expect(valid.status).toBe(200);
      await valid.arrayBuffer();
      const requestId = valid.headers.get('x-request-id');
      expect(requestId).toBeTruthy();
      // Client EOF can precede the server's finish callback on another socket.
      // Verify the declared server lifecycle, not only the consumer microtask.
      await vi.waitFor(
        () => {
          expect(f.ended.has(requestId!)).toBe(true);
          expect(f.a.readAdmission.snapshot().heavy).toBe(0);
        },
        { timeout: 2000 },
      );
    } finally {
      held?.req.destroy();
      held?.res.destroy();
      read.mockRestore();
      await f.clean();
    }
  },
);
it('an idle read response deadline terminates transport and releases its permit', async () => {
  const f = await fixture(1000);
  let held: Awaited<ReturnType<typeof f.held>> | undefined;
  try {
    held = await f.held();
    expect(f.a.readAdmission.snapshot().heavy).toBe(1);
    await vi.waitFor(() => expect(f.a.readAdmission.snapshot().heavy).toBe(0), {
      timeout: 3000,
      interval: 20,
    });
    held.res.resume();
    expect(f.a.readAdmission.snapshot()).toEqual({
      heavy: 0,
      light: 0,
      lightProjects: 0,
    });
    const fragment = await f.rpc(true);
    expect(fragment.result.structuredContent.disclosure.returnedBytes).toBe(64);
  } finally {
    held?.req.destroy();
    held?.res.destroy();
    await f.clean();
  }
});
