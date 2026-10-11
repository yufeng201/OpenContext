import { afterEach, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { SessionEvidenceSchema } from '../../packages/contracts/src/index.ts';
import { codexSessionDefinition } from '../../plugins/session-connector/src/index.ts';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import {
  parseCodexJsonl,
  jsonlHash,
} from '../../plugins/session-connector/src/codex-jsonl.ts';
import {
  prepareSessionUpload,
  validateSessionUpload,
} from '../../plugins/session-connector/src/jsonl-upload.ts';
import {
  explicitMarkerExtractor,
  extractCandidates,
} from '../../plugins/session-candidates/src/index.ts';
import { prepareWorker, runWorker } from '../../scripts/local-agent-worker.ts';
import { submitWorker } from '../../scripts/local-agent-submit.ts';
import { createApplication } from '../../apps/server/src/app.ts';
import type { AgentTask } from '../../plugins/session-candidates/src/local-agent.ts';
import type { NormalizedSessionMessage } from '../../packages/contracts/src/index.ts';
const scope = 'synthetic-complex';
const original = readFileSync(
  new URL(
    '../../plugins/session-connector/fixtures/codex-0.161.0-complex-synthetic.jsonl',
    import.meta.url,
  ),
  'utf8',
);
const parse = (text = original) =>
  parseCodexJsonl(Buffer.from(text), scope, '0.161.0');
const records = () =>
  original
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
const serialize = (items: unknown[]) =>
  items.map((item) => JSON.stringify(item) + '\n').join('');
const items = (text = original) =>
  JSON.parse(parse(text).canonical).payload.thread.turns.flatMap(
    (t: { items: Record<string, unknown>[] }) => t.items,
  ) as {
    role?: string;
    evidence?: NonNullable<NormalizedSessionMessage['evidence']>;
    text?: string;
    type: string;
  }[];
it('pairs interleaved text calls/results, retains source order/hashes and marks summary coverage without replaying replacement history', () => {
  const parsed = parse();
  const all = items();
  expect(all.map((i) => i.type)).toEqual([
    'userMessage',
    'opencontextEvidence',
    'opencontextEvidence',
    'opencontextEvidence',
    'opencontextEvidence',
    'opencontextEvidence',
    'agentMessage',
  ]);
  const tools = all.filter((i) => i.role === 'tool');
  expect(tools).toHaveLength(4);
  for (const item of tools) {
    const e = item.evidence!;
    if (!('pairedLine' in e)) throw new Error('Expected paired tool evidence');
    const pair = tools.find((t) => t.evidence!.sourceLine === e.pairedLine)!;
    expect('callId' in pair.evidence! && pair.evidence.callId).toBe(e.callId);
    expect(pair.evidence!.sourceHash).toBe(e.pairedHash);
    expect(e.sourceHash).toBe(
      jsonlHash(original.split('\n')[e.sourceLine - 1]! + '\n'),
    );
  }
  const summary = all.find((i) => i.role === 'summary')!;
  const e = summary.evidence!;
  if (e.kind !== 'compaction') throw new Error('Expected compaction evidence');
  expect(e.observedThroughLine).toBe(10);
  expect(e.observedPrefixHash).toBe(
    jsonlHash(original.split('\n').slice(0, 10).join('\n') + '\n'),
  );
  expect(e.coverage).toContain('unknown');
  expect(summary.text).not.toContain('Quoted replacement snapshot');
  expect(parsed.raw).toBe(original);
  expect(parsed.receipt.rawOnly).toEqual({
    'response:reasoning': 1,
    'event:exec_command_begin': 1,
    'event:exec_command_end': 1,
  });
});
it('does not treat tool or summary marker text as deterministic rules', () => {
  for (const item of items().filter((i) => i.role)) {
    const message = {
      schema: 'opencontext.session-message/v1',
      provider: 'codex',
      projectScope: scope,
      sessionId: 's',
      messageId: 'm',
      role: item.role,
      text: 'Rule: synthetic untrusted instruction',
    } as NormalizedSessionMessage;
    expect(
      explicitMarkerExtractor.extract(message, {
        signal: new AbortController().signal,
      }),
    ).toEqual([]);
  }
});
it('waits on active tool/truncated UTF-8 tails, rejects malformed complete lines, unpaired results and mismatched identities', () => {
  const first = parse();
  const tail = serialize([
    {
      timestamp: 'x',
      ordinal: 13,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'next' },
    },
    {
      timestamp: 'x',
      ordinal: 14,
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'pending',
        name: 'tool',
        arguments: '{}',
      },
    },
  ]);
  expect(parse(original + tail + '{"unfinished":').canonical).toBe(
    first.canonical,
  );
  expect(
    parseCodexJsonl(
      Buffer.concat([Buffer.from(original), Buffer.from([0xe4, 0xb8])]),
      scope,
      '0.161.0',
    ),
  ).toEqual(first);
  expect(() => parse(original + '{broken}\n')).toThrow('INVALID_SESSION_JSONL');
  for (const mutate of [
    (r: ReturnType<typeof records>) => {
      r.splice(4, 1);
    },
    (r: ReturnType<typeof records>) => {
      r[8].payload.call_id = 'orphan';
    },
    (r: ReturnType<typeof records>) => {
      r[8].payload.name = 'wrong';
    },
    (r: ReturnType<typeof records>) => {
      r[8].payload.type = 'custom_tool_call_output';
    },
  ]) {
    const r = records();
    mutate(r);
    expect(() => parse(serialize(r))).toThrow('UNSUPPORTED_SESSION_JSONL');
  }
  const missing = records().filter(
    (r) => r.payload.type !== 'function_call_output',
  );
  expect(() => parse(serialize(missing))).toThrow('PARTIAL_SESSION');
});
it('deduplicates exact ordinal or call repeats but rejects conflicts, unknown formats, encrypted/media outputs and budgets', () => {
  const r = records();
  r.splice(5, 0, r[4]);
  expect(items(serialize(r)).map((i) => [i.type, i.role, i.text])).toEqual(
    items().map((i) => [i.type, i.role, i.text]),
  );
  const conflict = records();
  conflict.splice(5, 0, {
    ...conflict[4],
    payload: { ...conflict[4].payload, arguments: 'different' },
  });
  expect(() => parse(serialize(conflict))).toThrow(
    'DUPLICATE_MESSAGE_CONFLICT',
  );
  for (const mutate of [
    (r: ReturnType<typeof records>) => {
      r[8].payload.output = [
        { type: 'input_image', image_url: 'https://invalid.test/image' },
      ];
    },
    (r: ReturnType<typeof records>) => {
      r[4].payload.encrypted_function_args = ['opaque'];
    },
    (r: ReturnType<typeof records>) => {
      r[4].payload.arguments = { cmd: 'not a wire string' };
    },
    (r: ReturnType<typeof records>) => {
      r[10].payload.replacement_history_metadata = [];
    },
    (r: ReturnType<typeof records>) => {
      r[10].payload.message = '';
    },
    (r: ReturnType<typeof records>) => {
      r[10].payload.retained_context = { unknown: true };
    },
    (r: ReturnType<typeof records>) => {
      r[10].payload.replacement_history = [
        { type: 'compaction', encrypted_content: 'opaque' },
      ];
    },
    (r: ReturnType<typeof records>) => {
      r[9].payload.type = 'turn_aborted';
    },
    (r: ReturnType<typeof records>) => {
      r[9].payload.type = 'unknown_event';
    },
  ]) {
    const r = records();
    mutate(r);
    expect(() => parse(serialize(r))).toThrow();
  }
  expect(() => parse('x'.repeat(1048577))).toThrow('BYTE_LIMIT');
  expect(() => parse(original + '\n'.repeat(10001))).toThrow('FILE_LIMIT');
  expect(() =>
    parseCodexJsonl(
      Buffer.from(original.replace('0.161.0', '0.159.2')),
      scope,
      '0.159.2',
    ),
  ).toThrow('UNSUPPORTED_SESSION_JSONL');
});
it('requires kind-specific evidence and refuses archive claims through ordinary v1 imports', async () => {
  const canonical = parse().canonical;
  await expect(
    Promise.resolve().then(() =>
      codexSessionDefinition.validateImport!(canonical, {
        projectScope: scope,
      }),
    ),
  ).rejects.toThrow('UNSUPPORTED_SESSION_ITEM');
  const e = items().find((item) => item.role === 'tool')!.evidence!;
  expect(Value.Check(SessionEvidenceSchema, e)).toBe(true);
  expect(
    Value.Check(SessionEvidenceSchema, {
      ...e,
      coverage: 'observed-prefix-only; exact-model-coverage-unknown',
    }),
  ).toBe(false);
  const missing = { ...e } as Record<string, unknown>;
  delete missing['pairedHash'];
  expect(Value.Check(SessionEvidenceSchema, missing)).toBe(false);
});
it('handles no-ordinal call repeats and post-turn compaction as bounded archive checkpoints', () => {
  const r = records().map(({ ordinal: _ordinal, ...record }) => record);
  r.splice(5, 0, r[4]);
  expect(
    items(serialize(r)).filter((item) => item.role === 'tool'),
  ).toHaveLength(4);
  const checkpoint = serialize([
    {
      timestamp: 'x',
      ordinal: 13,
      type: 'compacted',
      payload: {
        message: 'Synthetic manual summary; exact model coverage unknown.',
      },
    },
  ]);
  const result = parse(original + checkpoint);
  expect(result.raw).toBe(original + checkpoint);
  expect(JSON.parse(result.canonical).payload.thread.turns[1].id).toBe(
    'opencontext-compaction:13',
  );
  expect(
    items(original + checkpoint).filter((item) => item.role === 'summary'),
  ).toHaveLength(2);
});
it('round trips upload as paired records, retains ordinal duplicate semantics and strips private UI/reasoning metadata', () => {
  const r = records();
  r[5].payload.command = ['PRIVATE_UI_ONLY'];
  r[3].payload.encrypted_content = 'PRIVATE_REASONING_ONLY';
  r[10].payload.replacement_history = [
    {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'PRIVATE_NESTED_SYSTEM /Users/synthetic/private',
        },
      ],
    },
  ];
  r.splice(5, 0, r[4]);
  const upload = prepareSessionUpload(
    [Buffer.from(serialize(r))],
    scope,
    '0.161.0',
  );
  expect(JSON.stringify(upload)).not.toContain('PRIVATE_');
  const checked = validateSessionUpload(upload, scope, '0.161.0')[0]!;
  const canonical = JSON.parse(checked.canonical).payload.thread.turns[0].items;
  expect(
    canonical.filter((i: { role?: string }) => i.role === 'tool'),
  ).toHaveLength(4);
  expect(checked.raw).toContain('function_call_output');
  expect(checked.raw).toContain('compacted');
  const bad = structuredClone(upload);
  bad.files[0]!.content = bad.files[0]!.content.replace(
    '"call_id":"call-a","output"',
    '"call_id":"orphan","output"',
  );
  expect(() => validateSessionUpload(bad, scope, '0.161.0')).toThrow();
});
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length) await cleanup.pop()!();
});
it('DEMO: complex upload → fake executable → reviewed Markdown → progressive recall and fixed native provenance, across restart and cancellation', async () => {
  vi.stubEnv('OPENCONTEXT_OWNER_TOKEN', undefined);
  vi.stubEnv('OPENCONTEXT_QUERY_TOKEN', undefined);
  const root = mkdtempSync(resolve(tmpdir(), 'oc-complex-e2e-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const owner = 'synthetic-complex-owner-not-real-credentials';
  const headers = { authorization: `Bearer ${owner}` };
  const config = {
    enabled: true,
    inputMode: 'upload',
    format: 'codex-jsonl-0.161.0',
    dataRoot: resolve(root, 'data'),
    projectScope: scope,
  };
  let app = createApplication({
    dataRoot: config.dataRoot,
    ownerToken: owner,
    sessionMemory: config,
    autoStart: true,
  });
  cleanup.push(() => app.app.close());
  let origin = await app.app.listen({ host: '127.0.0.1', port: 0 });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(
      new URL('/api/session-memory' + path, origin),
      {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const upload = prepareSessionUpload(
    [Buffer.from(original)],
    scope,
    '0.161.0',
  );
  const post = { expectedUploadHash: null, expectedUploadId: null, upload };
  const first = await request('POST', '/upload', post);
  expect(first.status).toBe(200);
  expect((await request('POST', '/upload', post)).body.taskId).toBe(
    first.body.taskId,
  );
  await app.app.close();
  app = createApplication({
    dataRoot: config.dataRoot,
    ownerToken: owner,
    sessionMemory: config,
    autoStart: true,
  });
  origin = await app.app.listen({ host: '127.0.0.1', port: 0 });
  const task = (await request('GET', '/task')).body.task as AgentTask;
  expect(task.messages.map((m) => m.message.role)).toEqual([
    'user',
    'tool',
    'tool',
    'tool',
    'tool',
    'summary',
    'assistant',
  ]);
  const input = {
    config: {},
    projectId: first.body.projectId,
    bindingId: first.body.bindingId,
    inputCommitId: app.catalog.head(first.body.projectId)!,
    files: app.catalog
      .currentFiles(first.body.projectId)
      .map((file) => ({ file, text: app.store.readText(file.contentHash) })),
  };
  const extraction = { method: 'local-agent' as const, extract: () => [] };
  const context = { signal: new AbortController().signal, workDir: root };
  await expect(
    extractCandidates(
      {
        ...input,
        files: input.files.filter(
          (entry) => !entry.file.logicalPath.endsWith('/raw.jsonl'),
        ),
      },
      context,
      extraction,
    ),
  ).rejects.toThrow('INVALID_MESSAGE');
  for (const [kind, key] of [
    ['tool_result', 'sourceHash'],
    ['tool_result', 'pairedHash'],
    ['compaction', 'observedPrefixHash'],
  ]) {
    const forged = structuredClone(input);
    const message = forged.files.find(
      (entry) =>
        entry.file.logicalPath.includes('/messages/') &&
        JSON.parse(entry.text).evidence?.kind === kind,
    )!;
    const normalized = JSON.parse(message.text);
    normalized.evidence[key!] = '0'.repeat(64);
    message.text = JSON.stringify(normalized) + '\n';
    const raw = forged.files.find((entry) =>
      entry.file.logicalPath.endsWith('/raw.json'),
    )!;
    const canonical = JSON.parse(raw.text);
    const item = canonical.payload.thread.turns
      .flatMap(
        (turn: { items: { id: string; evidence: unknown }[] }) => turn.items,
      )
      .find((item: { id: string }) => item.id === normalized.messageId)!;
    item.evidence = normalized.evidence;
    raw.text = JSON.stringify(canonical);
    const proof = forged.files.find((entry) =>
      entry.file.logicalPath.endsWith('/transform.json'),
    )!;
    const receipt = JSON.parse(proof.text);
    receipt.canonicalHash = jsonlHash(raw.text);
    proof.text = JSON.stringify(receipt);
    for (const entry of [message, raw, proof])
      entry.file = {
        ...entry.file,
        contentHash: jsonlHash(entry.text),
        bytes: Buffer.byteLength(entry.text),
      };
    await expect(
      extractCandidates(forged, context, extraction),
    ).rejects.toThrow('INVALID_MESSAGE');
  }
  const path = resolve(root, 'task.json');
  writeFileSync(path, JSON.stringify(task));
  const { job } = prepareWorker(path);
  cleanup.push(() => rmSync(job, { recursive: true, force: true }));
  const fake = resolve(root, 'fake.mjs');
  writeFileSync(
    fake,
    `
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);if(args[0]==='--version'){console.log('codex-cli 0.161.0');process.exit(0)}
let stdin='';for await(const c of process.stdin)stdin+=c;const task=JSON.parse(stdin.split('Evidence JSON follows:\\n')[1]);
const m=task.messages.find(m=>m.message.evidence?.kind==='tool_result'&&m.message.evidence.callId==='call-a');
writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({schema:'opencontext.local-agent-response/v1',taskId:task.taskId,inputHash:task.inputHash,candidates:[{fileId:m.fileId,revisionId:m.revisionId,line:1,kind:'memory',markdown:'# Synthetic cedar dossier\\n\\nComplex-worker-orchid conclusion requires review.'}]}));`,
  );
  await runWorker(
    job,
    { execute: true },
    { file: process.execPath, prefix: [fake] },
  );
  const review = await submitWorker(job, {
    origin,
    token: owner,
    signal: new AbortController().signal,
  });
  expect(review.status).toBe('review');
  const preview = (await request('GET', '/review')).body;
  expect(preview.markdown).toContain('archive-v2');
  expect(preview.markdown).toContain('tool / tool_result');
  expect(preview.markdown).toContain('Paired JSONL line:');
  const badUpload = structuredClone(upload);
  badUpload.files[0]!.content += '{bad}\n';
  expect(
    (
      await request('POST', '/upload', {
        expectedUploadHash: first.body.uploadHash,
        expectedUploadId: first.body.uploadId,
        upload: badUpload,
      })
    ).status,
  ).not.toBe(200);
  expect((await request('GET', '/review')).body.reviewHash).toBe(
    preview.reviewHash,
  );
  expect(
    app.catalog
      .currentFiles(first.body.projectId)
      .some((f) => f.collection === 'derived'),
  ).toBe(false);
  expect(
    (
      await request('POST', '/approve', {
        taskId: review.taskId,
        reviewHash: review.reviewHash,
      })
    ).status,
  ).toBe(200);
  const derived = app.catalog
    .currentFiles(first.body.projectId)
    .find((f) => f.collection === 'derived')!;
  const query = async (args: Record<string, unknown>) => {
    const r = await fetch(new URL('/mcp', origin), {
      method: 'POST',
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
        params: { name: 'context_read', arguments: args },
      }),
      signal: AbortSignal.timeout(10000),
    });
    expect(r.status).toBe(200);
    return (await r.json()).result.structuredContent;
  };
  const full = await query({
    projectId: first.body.projectId,
    fileId: derived.fileId,
    revisionId: derived.revisionId,
  });
  expect(full.text).toContain('Complex-worker-orchid');
  expect(full.text).toContain('fixed original');
  const outline = await query({
    projectId: first.body.projectId,
    fileId: derived.fileId,
    revisionId: derived.revisionId,
    outline: true,
  });
  expect(outline.citation.revisionId).toBe(derived.revisionId);
  expect(outline.disclosure.mode).toBe('outline');
  const section = await query({
    projectId: first.body.projectId,
    fileId: derived.fileId,
    revisionId: derived.revisionId,
    section: 'Content',
    maxBytes: 256,
  });
  expect(section.text).toContain('Complex-worker-orchid');
  expect(Buffer.byteLength(section.text)).toBeLessThanOrEqual(256);
  const search = await promisify(execFile)(
    process.execPath,
    [
      'scripts/opencontext.ts',
      'search',
      first.body.projectId,
      'Complex-worker-orchid',
    ],
    {
      cwd: resolve(import.meta.dirname, '../..'),
      timeout: 10000,
      maxBuffer: 1048576,
      env: {
        PATH: process.env['PATH'] ?? '',
        OPENCONTEXT_URL: origin,
        OPENCONTEXT_QUERY_TOKEN: owner,
      },
    },
  );
  expect(
    JSON.parse(search.stdout).hits.some(
      (hit: { file: { fileId: string } }) => hit.file.fileId === derived.fileId,
    ),
  ).toBe(true);
  const sources = app.catalog.currentFiles(first.body.projectId);
  const raw = sources.find((f) => f.logicalPath.endsWith('/raw.jsonl'))!;
  expect(app.store.readText(raw.contentHash)).toContain('"call_id":"call-a"');
  const receipt = sources.find((f) =>
    f.logicalPath.endsWith('/transform.json'),
  )!;
  expect(JSON.parse(app.store.readText(receipt.contentHash)).originalHash).toBe(
    jsonlHash(app.store.readText(raw.contentHash)),
  );
  const retry = await request('POST', '/upload', {
    expectedUploadHash: first.body.uploadHash,
    expectedUploadId: first.body.uploadId,
    upload: prepareSessionUpload(
      [
        Buffer.from(
          original.replace('Inspect the synthetic', 'Reinspect the synthetic'),
        ),
      ],
      scope,
      '0.161.0',
    ),
  });
  expect(retry.status).toBe(200);
  expect(
    (await request('POST', '/cancel', { taskId: retry.body.taskId })).status,
  ).toBe(200);
  await expect(
    submitWorker(job, {
      origin,
      token: owner,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
});
