import { afterEach, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseCodexJsonl,
  jsonlHash,
} from '../../plugins/session-connector/src/codex-jsonl.ts';
import { extractCandidates } from '../../plugins/session-candidates/src/index.ts';
import { createApplication } from '../../apps/server/src/app.ts';
import type { AgentTask } from '../../plugins/session-candidates/src/local-agent.ts';
import type {
  SearchResult,
  ReadResult,
} from '../../packages/contracts/src/index.ts';

// Synthetic data, shaped from the pinned public Rust structures, never a user rollout.
const line = (
  type: string,
  payload: Record<string, unknown>,
  ordinal?: number,
) =>
  JSON.stringify({
    timestamp: '2026-10-09T00:00:00Z',
    ...(ordinal === undefined ? {} : { ordinal }),
    type,
    payload,
  }) + '\n';
const meta = (extra = {}) =>
  line('session_meta', {
    id: '00000000-0000-4000-8000-000000000001',
    session_id: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-10-09T00:00:00Z',
    cwd: '/synthetic/not-read',
    originator: 'synthetic-fixture',
    cli_version: '0.159.2',
    source: 'cli',
    history_mode: 'legacy',
    ...extra,
  });
const turn = (id: string, text = 'Synthetic lighthouse notes') =>
  line('event_msg', { type: 'task_started', turn_id: id }) +
  line('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `Question ${id}` }],
  }) +
  line('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }) +
  line('event_msg', {
    type: 'task_complete',
    turn_id: id,
    last_agent_message: text,
  });
const original = meta() + turn('turn-1');
const parse = (text: string) =>
  parseCodexJsonl(Buffer.from(text), 'synthetic-project');
it('preserves an exact finished prefix and waits for incomplete JSON and UTF-8 tails', () => {
  const first = parse(original);
  expect(first.raw).toBe(original);
  expect(first.receipt.originalHash).toBe(jsonlHash(original));
  expect(parse(original + '{"timestamp":').canonical).toBe(first.canonical);
  expect(
    parseCodexJsonl(
      Buffer.concat([Buffer.from(original), Buffer.from([0xe4, 0xb8])]),
      'synthetic-project',
    ),
  ).toEqual(first);
  const active =
    original + line('event_msg', { type: 'task_started', turn_id: 'turn-2' });
  expect(parse(active)).toEqual(first);
  expect(parse(original + turn('turn-2')).canonical).toContain('turn-2');
  expect(() => parse(meta())).toThrow('PARTIAL_SESSION');
});
it('rejects malformed complete records, unsupported versions/history/types and conflicting identity', () => {
  for (const extra of [
    { cli_version: '0.160.0' },
    { history_mode: 'paginated' },
    { history_base: {} },
    { parent_thread_id: 'parent' },
    { source: { subagent: 'review' } },
  ])
    expect(() => parse(meta(extra) + turn('t'))).toThrow();
  for (const suffix of [
    '{broken}\n',
    line('compacted', {}),
    line('event_msg', { type: 'unknown' }),
    line('session_meta', { id: 'other' }),
  ])
    expect(() => parse(original + suffix)).toThrow();
  expect(() => parse('broken\n' + original)).toThrow();
  const a = line(
    'response_item',
    {
      type: 'message',
      id: 'same',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'A' }],
    },
    3,
  );
  const b = line(
    'response_item',
    {
      type: 'message',
      id: 'same',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'B' }],
    },
    3,
  );
  const start =
    meta() + line('event_msg', { type: 'task_started', turn_id: 't' });
  const end = line('event_msg', { type: 'task_complete', turn_id: 't' });
  expect(
    JSON.parse(parse(start + a + a + end).canonical).payload.thread.turns[0]
      .items,
  ).toHaveLength(1);
  expect(() => parse(start + a + b + end)).toThrow(
    'DUPLICATE_MESSAGE_CONFLICT',
  );
  expect(() => parse('x'.repeat(1_048_577))).toThrow('BYTE_LIMIT');
  expect(() => parse(original + '\n'.repeat(10_001))).toThrow('FILE_LIMIT');
});
it('preserves repeated text across and within turns without inventing identity', () => {
  const result = JSON.parse(parse(original + turn('turn-2')).canonical);
  expect(
    result.payload.thread.turns.map(
      (t: { items: unknown[] }) => t.items.length,
    ),
  ).toEqual([2, 2]);
  const message = line('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'identical' }],
  });
  const prefix =
    meta() + line('event_msg', { type: 'task_started', turn_id: 't' });
  const suffix = line('event_msg', { type: 'task_complete', turn_id: 't' });
  const items = JSON.parse(parse(prefix + message + message + suffix).canonical)
    .payload.thread.turns[0].items;
  expect(items).toHaveLength(2);
  expect(items[0].id).not.toBe(items[1].id);
  const identified = message.replace(
    '"role":"assistant"',
    '"id":"stable","role":"assistant"',
  );
  expect(
    JSON.parse(parse(prefix + identified + identified + suffix).canonical)
      .payload.thread.turns[0].items,
  ).toHaveLength(1);
  expect(() =>
    parse(
      prefix +
        identified +
        identified.replace('identical', 'conflicting') +
        suffix,
    ),
  ).toThrow('DUPLICATE_MESSAGE_CONFLICT');
});
const owner = 'synthetic-jsonl-test-owner-not-a-real-credential';
const headers = { authorization: `Bearer ${owner}` };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-jsonl-'));
  const directory = resolve(root, 'selected');
  mkdirSync(directory);
  const path = resolve(directory, 'rollout.jsonl');
  writeFileSync(path, original);
  const config = {
    enabled: true,
    format: 'codex-jsonl-0.159.2',
    directory,
    dataRoot: resolve(root, 'data'),
    projectScope: 'synthetic-project',
  };
  let server = createApplication({
    dataRoot: config.dataRoot,
    ownerToken: owner,
    sessionMemory: config,
    autoStart: true,
  });
  cleanup.push(async () => {
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    directory,
    config,
    get server() {
      return server;
    },
    async restart() {
      await server.app.close();
      server = createApplication({
        dataRoot: config.dataRoot,
        ownerToken: owner,
        sessionMemory: config,
        autoStart: true,
      });
    },
    async sync() {
      const r = await server.app.inject({
        method: 'POST',
        url: '/api/session-memory/sync',
        headers,
        payload: {},
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    },
    async failed() {
      const r = await server.app.inject({
        method: 'POST',
        url: '/api/session-memory/sync',
        headers,
        payload: {},
      });
      expect(r.statusCode).not.toBe(200);
    },
  };
}
it('replays appended records across restart, rejects corrupt scans atomically, and safely replaces/truncates snapshots', async () => {
  const f = fixture();
  const first = await f.sync();
  appendFileSync(f.path, '{"unfinished":');
  expect((await f.sync()).taskId).toBe(first.taskId);
  await f.restart();
  expect((await f.sync()).taskId).toBe(first.taskId);
  writeFileSync(f.path, original + turn('turn-2'));
  const second = await f.sync();
  expect(second.taskId).not.toBe(first.taskId);
  const binding = () => f.server.catalog.getBinding(second.bindingId)!;
  const version = binding().sourceVersion;
  for (const bad of [
    '{broken}\n',
    meta(),
    meta({ cli_version: '999' }) + turn('x'),
  ]) {
    writeFileSync(f.path, bad);
    await f.failed();
    expect(binding().sourceVersion).toBe(version);
  }
  writeFileSync(f.path, original);
  await f.sync();
  const files = f.server.catalog.currentFiles(first.projectId);
  expect(
    files.filter(
      (file) => !file.tombstone && file.logicalPath.includes('/messages/'),
    ),
  ).toHaveLength(2);
  // Atomic filesystem replacement is treated as a fully revalidated snapshot, not trusted by inode/mtime.
  rmSync(f.path);
  writeFileSync(f.path, original);
  const replaced = await f.sync();
  expect((await f.sync()).taskId).toBe(replaced.taskId);
  rmSync(f.path);
  symlinkSync('/synthetic/missing', f.path);
  await f.failed();
});
it('DEMO: running server JSONL append → simulated file worker → explicit approval → CLI search and fixed MCP read', async () => {
  const f = fixture();
  const origin = await f.server.app.listen({ host: '127.0.0.1', port: 0 });
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
            OPENCONTEXT_URL: origin,
            OPENCONTEXT_OWNER_TOKEN: owner,
            OPENCONTEXT_QUERY_TOKEN: owner,
          },
        })
      ).stdout,
    );
  const control = (...args: string[]) =>
    cli('scripts/session-memory-online.ts', ...args);
  const initial = await control('sync');
  appendFileSync(f.path, turn('turn-2', 'A second synthetic completed turn'));
  const next = await control('sync');
  expect(next.taskId).not.toBe(initial.taskId);
  const { task } = (await control('task')) as { task: AgentTask };
  expect(task.messages).toHaveLength(4);
  const taskPath = resolve(f.root, 'task.json');
  writeFileSync(taskPath, JSON.stringify(task));
  const workerTask = JSON.parse(readFileSync(taskPath, 'utf8')) as AgentTask;
  const message = workerTask.messages.find(
    (m) => m.message.role === 'assistant',
  )!;
  const responsePath = resolve(f.root, 'response.json');
  writeFileSync(
    responsePath,
    JSON.stringify({
      schema: 'opencontext.local-agent-response/v1',
      taskId: workerTask.taskId,
      inputHash: workerTask.inputHash,
      candidates: [
        {
          fileId: message.fileId,
          revisionId: message.revisionId,
          kind: 'memory',
          line: 1,
          markdown:
            'Synthetic quartz-harbor Markdown from simulated file worker.',
        },
      ],
    }),
  );
  const review = await control('submit', responsePath);
  const preview = await control('review');
  expect(preview.markdown).toContain('Native JSONL completed prefix');
  expect(preview.markdown).toContain('codex-rollout/0.159.2-legacy-text-v1');
  expect(
    (
      (await cli(
        'scripts/opencontext.ts',
        'search',
        initial.projectId,
        'quartz-harbor',
      )) as SearchResult
    ).hits,
  ).toHaveLength(0);
  // Test operator explicitly approves this exact task and preview hash; no Agent is executed.
  expect(
    (await control('approve', task.taskId, review.reviewHash)).status,
  ).toBe('published');
  const hits = (
    (await cli(
      'scripts/opencontext.ts',
      'search',
      initial.projectId,
      'quartz-harbor',
    )) as SearchResult
  ).hits;
  expect(hits).toHaveLength(1);
  const file = hits[0]!.file;
  const response = await fetch(new URL('/mcp', origin), {
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
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { structuredContent: ReadResult };
  };
  expect(body.result.structuredContent.text).toContain('quartz-harbor');
  expect(body.result.structuredContent.citation.revisionId).toBe(
    file.revisionId,
  );
  expect((await fetch(new URL('/api/health', origin))).status).toBe(200);
});

it('candidate provenance rejects a forged receipt and retains all four fixed dependencies', async () => {
  const f = fixture();
  const status = await f.sync();
  const input = {
    config: {},
    projectId: status.projectId,
    bindingId: status.bindingId,
    inputCommitId: f.server.catalog.head(status.projectId)!,
    files: f.server.catalog.currentFiles(status.projectId).map((file) => ({
      file,
      text: f.server.store.readText(file.contentHash),
    })),
  };
  const context = { signal: new AbortController().signal, workDir: f.root };
  const extractor = {
    method: 'local-agent' as const,
    extract: async () => [
      { kind: 'memory' as const, line: 1, text: 'synthetic candidate' },
    ],
  };
  const output = await extractCandidates(input, context, extractor);
  expect(output.outputs).toHaveLength(2);
  expect(
    output.outputs.every((candidate) => candidate.derivedFrom.length === 4),
  ).toBe(true);
  const receipt = input.files.find((entry) =>
    entry.file.logicalPath.endsWith('/transform.json'),
  )!;
  const proof = JSON.parse(receipt.text);
  proof.originalHash = '0'.repeat(64);
  receipt.text = JSON.stringify(proof);
  receipt.file = {
    ...receipt.file,
    contentHash: jsonlHash(receipt.text),
    bytes: Buffer.byteLength(receipt.text),
  };
  await expect(extractCandidates(input, context, extractor)).rejects.toThrow(
    'INVALID_MESSAGE',
  );
});
