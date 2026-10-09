import { afterEach, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCodexJsonl } from '../../plugins/session-connector/src/codex-jsonl.ts';
import {
  prepareSessionUpload,
  validateSessionUpload,
} from '../../plugins/session-connector/src/jsonl-upload.ts';
import { uploadSessions } from '../../scripts/session-memory-upload-client.ts';
import { createApplication } from '../../apps/server/src/app.ts';
import type { AgentTask } from '../../plugins/session-candidates/src/local-agent.ts';
import type {
  SearchResult,
  ReadResult,
} from '../../packages/contracts/src/index.ts';

const original = readFileSync(
  new URL(
    '../../plugins/session-connector/fixtures/codex-0.161.0-synthetic.jsonl',
    import.meta.url,
  ),
  'utf8',
);
const scope = 'synthetic-upload-project';
const upload = (text = original) =>
  prepareSessionUpload([Buffer.from(text)], scope, '0.161.0');
const second = original
  .replace(
    'synthetic-public-schema-fixture',
    'synthetic-public-schema-fixture-2',
  )
  .replaceAll('synthetic-turn-161', 'synthetic-turn-162');
const appended = original + second.split('\n').slice(2).join('\n');
const owner = 'synthetic-upload-owner-not-real-credentials';
const headers = { authorization: `Bearer ${owner}` };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function fixture(enabled = true) {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-upload-'));
  const client = resolve(root, 'client');
  mkdirSync(client);
  const file = resolve(client, 'selected.jsonl');
  writeFileSync(file, original);
  const config = {
    enabled,
    inputMode: 'upload',
    format: 'codex-jsonl-0.161.0',
    dataRoot: resolve(root, 'server'),
    projectScope: scope,
  };
  let server = createApplication({
    dataRoot: config.dataRoot,
    ownerToken: owner,
    sessionMemory: config,
    autoStart: true,
  });
  let origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => {
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    client,
    file,
    config,
    get server() {
      return server;
    },
    get origin() {
      return origin;
    },
    async restart() {
      await server.app.close();
      server = createApplication({
        dataRoot: config.dataRoot,
        ownerToken: owner,
        sessionMemory: config,
        autoStart: true,
      });
      origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
    },
    post: (command: string, payload: Record<string, unknown>, auth = headers) =>
      server.app.inject({
        method: 'POST',
        url: '/api/session-memory/' + command,
        headers: auth,
        payload,
      }),
    async status() {
      return (
        await server.app.inject({
          method: 'GET',
          url: '/api/session-memory',
          headers,
        })
      ).json();
    },
    send: (extra: Partial<Parameters<typeof uploadSessions>[0]> = {}) =>
      uploadSessions({
        selection: file,
        kind: 'file',
        origin,
        token: owner,
        signal: new AbortController().signal,
        ...extra,
      }),
    async response() {
      const { task } = (
        await server.app.inject({
          method: 'GET',
          url: '/api/session-memory/task',
          headers,
        })
      ).json<{ task: AgentTask }>();
      const source = task.messages.find((m) => m.message.role === 'assistant')!;
      return {
        schema: 'opencontext.local-agent-response/v1',
        taskId: task.taskId,
        inputHash: task.inputHash,
        candidates: [
          {
            fileId: source.fileId,
            revisionId: source.revisionId,
            kind: 'memory',
            line: 1,
            markdown: 'Synthetic cobalt-orchard upload worker Markdown.',
          },
        ],
      };
    },
  };
}
it('pins both compatible legacy text profiles and rejects new Guardian metadata and mismatched versions', () => {
  const modern = parseCodexJsonl(Buffer.from(original), scope, '0.161.0');
  const old = parseCodexJsonl(
    Buffer.from(original.replace('0.161.0', '0.159.2')),
    scope,
    '0.159.2',
  );
  expect(modern.canonical).toBe(old.canonical);
  expect(modern.receipt.parser).toBe('codex-rollout/0.161.0-legacy-text-v1');
  expect(() => parseCodexJsonl(Buffer.from(original), scope)).toThrow(
    'UNSUPPORTED_SESSION_JSONL',
  );
  const guardian = original.replace(
    '"type":"response_item"',
    '"metadata":{"guardian_review_ids":["review"]},"type":"response_item"',
  );
  expect(() =>
    parseCodexJsonl(Buffer.from(guardian), scope, '0.161.0'),
  ).toThrow();
});
it('projects text only, preserving message identity while removing machine metadata and retaining declared prefix hash', () => {
  const packet = upload();
  const serialized = JSON.stringify(packet);
  expect(serialized).not.toContain('SYNTHETIC_METADATA_ONLY');
  expect(serialized).not.toContain('/Users/');
  expect(serialized).not.toContain('environment');
  expect(serialized).toContain('maple-harbor');
  const result = validateSessionUpload(packet, scope, '0.161.0')[0]!;
  expect(result.canonical).toBe(
    parseCodexJsonl(Buffer.from(original), scope, '0.161.0').canonical,
  );
  expect(result.receipt.transport.clientPrefixHash).not.toBe(
    result.receipt.originalHash,
  );
  expect(upload(original + '{"partial":')).toEqual(packet);
  const tampered = structuredClone(packet);
  tampered.files[0]!.content = tampered.files[0]!.content.replace(
    '[omitted]',
    '/Users/forbidden-machine-metadata',
  );
  expect(() => validateSessionUpload(tampered, scope, '0.161.0')).toThrow(
    'INVALID_IMPORT',
  );
});
it('requires enabled upload mode and owner auth, and rejects oversized bodies without imports', async () => {
  const disabled = await fixture(false);
  expect(
    (
      await disabled.post('upload', {
        expectedUploadHash: null,
        expectedUploadId: null,
        upload: upload(),
      })
    ).statusCode,
  ).toBe(403);
  const f = await fixture();
  expect((await f.post('upload', {}, {} as typeof headers)).statusCode).toBe(
    401,
  );
  const p = f.server.catalog.createProject('synthetic-reader');
  const reader = f.server.catalog.createReaderToken(p.id);
  expect(
    (await f.post('upload', {}, { authorization: `Bearer ${reader.token}` }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await f.post('upload', {
        expectedUploadHash: null,
        expectedUploadId: null,
        upload: upload(),
        extra: 'x'.repeat(2_105_345),
      })
    ).statusCode,
  ).toBe(413);
  expect((await f.status()).uploadHash).toBeNull();
  const bad = structuredClone(upload());
  bad.files[0]!.content += '{bad}\n';
  expect(
    (
      await f.post('upload', {
        expectedUploadHash: null,
        expectedUploadId: null,
        upload: bad,
      })
    ).statusCode,
  ).not.toBe(200);
  expect((await f.status()).projectId).toBeNull();
});
it('replays identical bytes after a lost response, survives restart and rejects stale selections without destroying review', async () => {
  const f = await fixture();
  let posts = 0;
  const bodies: unknown[] = [];
  const first = await f.send({
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === 'POST') {
        bodies.push(init.body);
        posts++;
        if (posts === 1) {
          await response.body?.cancel();
          throw new TypeError('synthetic lost response');
        }
      }
      return response;
    },
  });
  expect(posts).toBe(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(String(bodies[0])).not.toContain(f.client);
  await f.restart();
  expect((await f.send()).taskId).toBe(first.taskId);
  writeFileSync(f.file, appended);
  const next = await f.send();
  expect(next.taskId).not.toBe(first.taskId);
  const reviewed = await f.post('submit', await f.response());
  expect(reviewed.statusCode, reviewed.body).toBe(200);
  const stale = await f.post('upload', {
    expectedUploadHash: null,
    expectedUploadId: null,
    upload: upload(),
  });
  expect(stale.statusCode).toBe(409);
  expect((await f.status()).reviewHash).toBe(reviewed.json().reviewHash);
  expect((await f.send()).taskId).toBe(next.taskId);
  // A→B→A must not admit a delayed B operation based on the first A generation.
  writeFileSync(f.file, original);
  const restored = await f.send();
  expect(restored.uploadHash).toBe(first.uploadHash);
  expect(restored.uploadId).not.toBe(first.uploadId);
  const late = await f.post('upload', {
    expectedUploadHash: first.uploadHash,
    expectedUploadId: first.uploadId,
    upload: upload(appended),
  });
  expect(late.statusCode).toBe(409);
  expect((await f.status()).taskId).toBe(restored.taskId);
});
it('cancelled clients do not retry accepted uploads; explicit task cancellation keeps sources and cannot auto-publish', async () => {
  const f = await fixture();
  const early = new AbortController();
  early.abort();
  await expect(f.send({ signal: early.signal })).rejects.toThrow();
  expect((await f.status()).projectId).toBeNull();
  const abort = new AbortController();
  let posts = 0;
  await expect(
    f.send({
      signal: abort.signal,
      fetchImpl: async (url, init) => {
        const r = await fetch(url, init);
        if (init?.method === 'POST') {
          posts++;
          await r.body?.cancel();
          abort.abort();
          throw new DOMException('synthetic cancelled response', 'AbortError');
        }
        return r;
      },
    }),
  ).rejects.toThrow();
  expect(posts).toBe(1);
  const accepted = await f.status();
  expect(accepted.status).toBe('pending');
  expect((await f.post('cancel', { taskId: accepted.taskId })).statusCode).toBe(
    200,
  );
  expect((await f.send()).status).toBe('cancelled');
  expect(
    f.server.catalog
      .currentFiles(accepted.projectId)
      .every((file) => file.collection === 'sources'),
  ).toBe(true);
});
it('client rejects over-budget selections and middle damage before POST', async () => {
  const f = await fixture();
  writeFileSync(f.file, original + '{broken}\n');
  await expect(f.send()).rejects.toThrow();
  writeFileSync(f.file, 'x'.repeat(1_048_577));
  await expect(f.send()).rejects.toThrow('BYTE_LIMIT');
  writeFileSync(f.file, original);
  for (let i = 0; i < 8; i++)
    writeFileSync(resolve(f.client, `${i}.jsonl`), original);
  await expect(
    f.send({ kind: 'directory', selection: f.client }),
  ).rejects.toThrow('FILE_LIMIT');
  expect((await f.status()).projectId).toBeNull();
});
it('DEMO: separate client/server directories, real upload CLI, append, file worker, approval and CLI/MCP recall', async () => {
  const f = await fixture();
  const run = promisify(execFile);
  const cli = async (script: string, ...args: string[]) =>
    JSON.parse(
      (
        await run(process.execPath, [script, ...args], {
          cwd: resolve(import.meta.dirname, '../..'),
          timeout: 15_000,
          maxBuffer: 2_097_152,
          env: {
            PATH: process.env['PATH'] ?? '',
            OPENCONTEXT_URL: f.origin,
            OPENCONTEXT_OWNER_TOKEN: owner,
            OPENCONTEXT_QUERY_TOKEN: owner,
          },
        })
      ).stdout,
    );
  const initial = await cli(
    'scripts/session-memory-upload.ts',
    '--file',
    f.file,
  );
  appendFileSync(f.file, appended.slice(original.length));
  const next = await cli(
    'scripts/session-memory-upload.ts',
    '--directory',
    f.client,
  );
  expect(next.taskId).not.toBe(initial.taskId);
  const task = await cli('scripts/session-memory-online.ts', 'task');
  writeFileSync(resolve(f.root, 'task.json'), JSON.stringify(task));
  expect(
    (
      JSON.parse(readFileSync(resolve(f.root, 'task.json'), 'utf8')) as {
        task: AgentTask;
      }
    ).task.messages,
  ).toHaveLength(4);
  const response = resolve(f.root, 'response.json');
  writeFileSync(response, JSON.stringify(await f.response()));
  const reviewed = await cli(
    'scripts/session-memory-online.ts',
    'submit',
    response,
  );
  const preview = await cli('scripts/session-memory-online.ts', 'review');
  expect(preview.markdown).toContain(
    'Client original prefix SHA-256 (unverified declaration)',
  );
  expect(preview.markdown).not.toContain('SYNTHETIC_METADATA_ONLY');
  expect(
    (
      (await cli(
        'scripts/opencontext.ts',
        'search',
        initial.projectId,
        'cobalt-orchard',
      )) as SearchResult
    ).hits,
  ).toHaveLength(0);
  expect(
    (
      await cli(
        'scripts/session-memory-online.ts',
        'approve',
        next.taskId,
        reviewed.reviewHash,
      )
    ).status,
  ).toBe('published');
  const hits = (
    (await cli(
      'scripts/opencontext.ts',
      'search',
      initial.projectId,
      'cobalt-orchard',
    )) as SearchResult
  ).hits;
  expect(hits).toHaveLength(1);
  const file = hits[0]!.file;
  const mcp = await fetch(new URL('/mcp', f.origin), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'context_read',
        arguments: {
          projectId: initial.projectId,
          fileId: file.fileId,
          revisionId: file.revisionId,
        },
      },
    }),
  });
  expect(mcp.status).toBe(200);
  const result = (await mcp.json()) as {
    result: { structuredContent: ReadResult };
  };
  expect(result.result.structuredContent.text).toContain('cobalt-orchard');
  expect(result.result.structuredContent.citation.revisionId).toBe(
    file.revisionId,
  );
  expect((await fetch(new URL('/api/health', f.origin))).status).toBe(200);
});
