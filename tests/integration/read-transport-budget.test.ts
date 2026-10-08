import { it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createApplication } from '../../apps/server/src/app.ts';
import { OpenContextClient } from '../../packages/http-client/src/index.ts';
import {
  TEXT_READ_MAX_BYTES,
  ReadResultSchema,
  type ReadResult,
  type FileEntry,
} from '../../packages/contracts/src/index.ts';
import {
  QUERY_RESPONSE_MAX_BYTES,
  READ_RESPONSE_MAX_BYTES,
  MCP_READ_RESPONSE_MAX_BYTES,
  parseQueryResponse,
} from '../../packages/contracts/src/query-api.ts';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const token = 'synthetic-read-budget-owner-0000000000';

it('16MiB UTF8 objects, including worst JSON escaping, read fully over REST/SDK/CLI/MCP; oversized objects reject and fragments keep fixed identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-read-wire-budget-'));
  const application = createApplication({
    dataRoot: root,
    ownerToken: token,
    autoStart: false,
  });
  try {
    const origin = await application.app.listen({ host: '127.0.0.1', port: 0 });
    const project = application.catalog.createProject(
      'Synthetic transport budget',
    );
    const binding = application.catalog.createBinding(project.id, {
      name: 'Synthetic bounded text',
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
    const client = new OpenContextClient({ baseUrl: origin, token });
    const headers = { authorization: 'Bearer ' + token };
    const cli = (file: FileEntry) =>
      new Promise<{ code: number | null; out: string; err: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              'scripts/opencontext.ts',
              'read',
              project.id,
              file.fileId,
              file.revisionId,
            ],
            {
              env: {
                PATH: process.env['PATH'],
                OPENCONTEXT_URL: origin,
                OPENCONTEXT_QUERY_TOKEN: token,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let out = '',
            err = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            out += String(chunk);
          });
          child.stderr.on('data', (chunk) => {
            err += String(chunk);
          });
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, out, err }));
        },
      );
    let head: string | null = null;
    for (const [name, unit, count] of [
      ['ascii', 'x', TEXT_READ_MAX_BYTES],
      ['multibyte', '🙂', TEXT_READ_MAX_BYTES / 4],
      ['quotes', '"', TEXT_READ_MAX_BYTES / 2],
      ['worst-escape', '\u0000', TEXT_READ_MAX_BYTES],
      ['oversized', 'x', TEXT_READ_MAX_BYTES + 1],
    ] as const) {
      const text = unit.repeat(count),
        object = application.store.putText(text);
      application.catalog.enqueue(binding.id, 'sync');
      const run = application.catalog.claim()!;
      const file: FileEntry = {
        ...object,
        projectId: project.id,
        bindingId: binding.id,
        fileId: randomUUID(),
        revisionId: randomUUID(),
        slotKey: name + '.md',
        logicalPath: `sources/${binding.id}/${name}.md`,
        collection: 'sources',
        ownership: 'source_managed',
        freshness: 'fresh',
        tombstone: false,
        sourceVersion: name,
        createdAt: new Date().toISOString(),
        derivedFrom: [],
      };
      const commitId = randomUUID();
      const manifestHash = application.store.manifest(
        project.id,
        commitId,
        head,
        [file],
      );
      application.catalog.publish({
        projectId: project.id,
        expectedHead: head,
        commitId,
        manifestHash,
        files: [file],
        run,
        sourceVersion: name,
      });
      head = commitId;
      const path =
        `/api/projects/${project.id}/read?` +
        new URLSearchParams({
          fileId: file.fileId,
          revisionId: file.revisionId,
        });
      const rest = await fetch(origin + path, { headers });
      const rpc = async () => {
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
                projectId: project.id,
                fileId: file.fileId,
                revisionId: file.revisionId,
              },
            },
          }),
        });
        return await r.json();
      };
      if (name === 'oversized') {
        expect(rest.status).toBe(413);
        expect((await rest.json()).error.code).toBe('BYTE_LIMIT');
        await expect(
          client.read(project.id, file.fileId, file.revisionId),
        ).rejects.toMatchObject({ code: 'BYTE_LIMIT', status: 413 });
        const command = await cli(file);
        expect(command.code).toBe(1);
        expect(command.out).toBe('');
        expect(JSON.parse(command.err).error).toBe('BYTE_LIMIT');
        const denied = await rpc();
        expect(denied.error.message).toBe('BYTE_LIMIT');
        expect(denied.result).toBeUndefined();
        continue;
      }
      const verify = (r: ReadResult) => {
        expect(Buffer.byteLength(r.text)).toBe(object.bytes);
        expect(hash(r.text)).toBe(object.contentHash);
        expect(r.file.fileId).toBe(file.fileId);
        expect(r.file.revisionId).toBe(file.revisionId);
        expect(r.citation.contentHash).toBe(object.contentHash);
        expect(r.disclosure).toBeUndefined();
      };
      expect(rest.status).toBe(200);
      const length = Number(rest.headers.get('content-length'));
      expect(length).toBeGreaterThan(QUERY_RESPONSE_MAX_BYTES);
      expect(length).toBeLessThanOrEqual(READ_RESPONSE_MAX_BYTES);
      verify(await rest.json());
      verify(await client.read(project.id, file.fileId, file.revisionId));
      const command = await cli(file);
      expect(command.code).toBe(0);
      expect(command.err).toBe('');
      verify(JSON.parse(command.out));
      const result = await rpc();
      expect(result.error).toBeUndefined();
      verify(result.result.structuredContent);
      expect(
        Buffer.byteLength(JSON.stringify(result.result)),
      ).toBeLessThanOrEqual(MCP_READ_RESPONSE_MAX_BYTES);
      expect(hash(JSON.parse(result.result.content[0].text).text)).toBe(
        object.contentHash,
      );
      console.info(
        JSON.stringify({
          case: name,
          utf8BodyBytes: object.bytes,
          restJsonBytes: length,
          fullEntries: ['REST', 'SDK', 'CLI', 'MCP'],
          verifiedHash: object.contentHash,
        }),
      );
      const fragment = await client.read(
        project.id,
        file.fileId,
        file.revisionId,
        { maxBytes: 8192 },
      );
      expect(fragment.disclosure!.returnedBytes).toBe(8192);
      expect(fragment.citation.contentHash).toBe(object.contentHash);
    }
  } finally {
    await application.app.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);

it('wire protection stays finite for declared/streamed read bodies, custom caps, other queries and over-limit multibyte bodies', async () => {
  const make = (response: Response, maxResponseBytes?: number) =>
    new OpenContextClient({
      baseUrl: 'http://localhost',
      token,
      fetch: async () => response,
      ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    });
  const headers = { 'content-type': 'application/json' };
  await expect(
    make(
      new Response('{}', {
        headers: {
          ...headers,
          'content-length': String(READ_RESPONSE_MAX_BYTES + 1),
        },
      }),
    ).read('p', 'f', 'r'),
  ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  await expect(
    make(new Response(new Uint8Array(129), { headers }), 128).read(
      'p',
      'f',
      'r',
    ),
  ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  await expect(
    make(
      new Response('[]', {
        headers: {
          ...headers,
          'content-length': String(QUERY_RESPONSE_MAX_BYTES + 1),
        },
      }),
    ).projects(),
  ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  expect(() => make(Response.json({}), READ_RESPONSE_MAX_BYTES + 1)).toThrow(
    'INVALID_RESPONSE_LIMIT',
  );
  expect(() =>
    parseQueryResponse(ReadResultSchema, {
      text: '🙂'.repeat(TEXT_READ_MAX_BYTES / 4 + 1),
    }),
  ).toThrow('BYTE_LIMIT');
});
