import { afterEach, expect, it, vi } from 'vitest';
import { Catalog } from '../../packages/state-sqlite/src/index.ts';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  sessionMemory,
  type SessionMemoryConfig,
} from '../../scripts/session-memory-workflow.ts';
import { createApplication } from '../../apps/server/src/app.ts';
import type {
  AgentTask,
  AgentResponse,
} from '../../plugins/session-candidates/src/local-agent.ts';
import type {
  SearchResult,
  ReadResult,
} from '../../packages/contracts/src/index.ts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('reports a committed publication when cancellation arrives after the commit point', async () => {
  const f = fixture();
  const first = await sessionMemory(f.config, 'sync');
  const review = await sessionMemory(f.config, 'submit', f.respond());
  const abort = new AbortController();
  const publish = Catalog.prototype.publish;
  vi.spyOn(Catalog.prototype, 'publish').mockImplementation(function (
    this: Catalog,
    input,
  ) {
    publish.call(this, input);
    if (input.run?.kind === 'process') abort.abort();
  });
  const result = await sessionMemory(
    f.config,
    'approve',
    review.reviewHash!,
    abort.signal,
  );
  expect(result.status).toBe('published');
  expect(result.processedVersion).toBe(first.sourceVersion);
  expect((await sessionMemory(f.config, 'status')).status).toBe('published');
});
const original = readFileSync(
  new URL(
    '../../plugins/session-connector/fixtures/codex-session.json',
    import.meta.url,
  ),
  'utf8',
);
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-memory-'));
  roots.push(root);
  const directory = resolve(root, 'exports');
  mkdirSync(directory);
  writeFileSync(resolve(directory, 'selected.json'), original);
  const config: SessionMemoryConfig = {
    enabled: true,
    dataRoot: resolve(root, 'data'),
    directory,
    projectScope: 'synthetic-project',
  };
  const stateRoot = resolve(config.dataRoot, 'plugin-state', 'session-memory');
  const task = () =>
    JSON.parse(
      readFileSync(resolve(stateRoot, 'task.json'), 'utf8'),
    ) as AgentTask;
  const responsePath = resolve(root, 'worker-response.json');
  // Explicit simulated worker: no model, external CLI, credentials or user sessions.
  const respond = (change?: (response: AgentResponse) => void) => {
    const t = task();
    const source = t.messages.find((m) => m.message.role === 'assistant')!;
    const response: AgentResponse = {
      schema: 'opencontext.local-agent-response/v1',
      taskId: t.taskId,
      inputHash: t.inputHash,
      candidates: ['memory', 'rule', 'experience'].map((kind) => ({
        fileId: source.fileId,
        revisionId: source.revisionId,
        kind: kind as 'memory' | 'rule' | 'experience',
        line: 1,
        markdown: `## Simulated ${kind}\nSynthetic silver-lantern proposal. No semantic extraction was performed.`,
      })),
    };
    change?.(response);
    writeFileSync(responsePath, JSON.stringify(response));
    return responsePath;
  };
  return { root, config, stateRoot, task, respond, responsePath };
}
const owner = 'synthetic-memory-owner-only-000000000000000';
const headers = { authorization: `Bearer ${owner}` };

it('defaults off without reading the selected directory or creating data', async () => {
  const f = fixture();
  expect(
    await sessionMemory(
      { ...f.config, enabled: false, directory: '/nonexistent/never-read' },
      'sync',
    ),
  ).toEqual({ status: 'disabled' });
  expect(existsSync(f.config.dataRoot)).toBe(false);
});

it('runs directory → simulated worker → review → publication → progressive recall and restart dedupe', async () => {
  const f = fixture();
  const initial = await sessionMemory(f.config, 'sync');
  expect(initial.status).toBe('pending');
  const task = f.task();
  expect(await sessionMemory(f.config, 'sync')).toMatchObject({
    taskId: task.taskId,
    sourceVersion: initial.sourceVersion,
  });
  writeFileSync(resolve(f.config.directory, 'duplicate.json'), original);
  expect((await sessionMemory(f.config, 'sync')).taskId).toBe(task.taskId);
  let app = createApplication({
    dataRoot: f.config.dataRoot,
    ownerToken: owner,
    autoStart: false,
  });
  try {
    expect(
      app.catalog
        .currentFiles(initial.projectId!)
        .filter((f) => f.collection === 'derived'),
    ).toHaveLength(0);
  } finally {
    await app.app.close();
  }
  const review = await sessionMemory(f.config, 'submit', f.respond());
  expect(review.status).toBe('review');
  app = createApplication({
    dataRoot: f.config.dataRoot,
    ownerToken: owner,
    autoStart: false,
  });
  try {
    const result = await app.app.inject({
      method: 'POST',
      url: `/api/projects/${initial.projectId}/search`,
      headers,
      payload: { query: 'silver-lantern', mode: 'grep' },
    });
    expect(result.json<SearchResult>().hits).toHaveLength(0);
  } finally {
    await app.app.close();
  }
  await expect(
    sessionMemory(f.config, 'approve', '0'.repeat(64)),
  ).rejects.toThrow('POLICY_DENIED');
  expect((await sessionMemory(f.config, 'status')).status).toBe('review');
  const published = await sessionMemory(
    f.config,
    'approve',
    review.reviewHash!,
  );
  expect(published.status).toBe('published');
  expect(published.processedVersion).toBe(initial.sourceVersion);
  expect((await sessionMemory(f.config, 'sync')).taskId).toBe(task.taskId);
  app = createApplication({
    dataRoot: f.config.dataRoot,
    ownerToken: owner,
    autoStart: false,
  });
  try {
    const files = app.catalog.currentFiles(initial.projectId!);
    const raw = files.find((f) => f.logicalPath.endsWith('/raw.json'))!;
    expect(app.store.readText(raw.contentHash)).toBe(original);
    const found = await app.app.inject({
      method: 'POST',
      url: `/api/projects/${initial.projectId}/search`,
      headers,
      payload: { query: 'silver-lantern', mode: 'fts' },
    });
    const hits = found.json<SearchResult>().hits;
    expect(hits).toHaveLength(3);
    const file = hits[0]!.file;
    expect(file.derivedFrom).toHaveLength(2);
    const base = `/api/projects/${initial.projectId}/read?fileId=${file.fileId}&revisionId=${file.revisionId}`;
    const outline = await app.app.inject({
      url: base + '&outline=true',
      headers,
    });
    expect(outline.statusCode).toBe(200);
    const content = await app.app.inject({
      url: base + '&section=Content',
      headers,
    });
    expect(content.json<ReadResult>().text).toContain('silver-lantern');
    const complete = await app.app.inject({ url: base, headers });
    expect(complete.json<ReadResult>().text).toContain('status: candidate');
    expect(complete.json<ReadResult>().text).toContain(
      'not an instruction or an approved rule',
    );
    for (const dep of file.derivedFrom)
      expect(complete.json<ReadResult>().text).toContain(`@${dep.revisionId}`);
    expect(files.some((f) => /AGENTS\.md|CLAUDE\.md/.test(f.logicalPath))).toBe(
      false,
    );
  } finally {
    await app.app.close();
  }
});

it('cancels pending handoffs, rejects late responses and requires a fresh nonce on retry', async () => {
  const f = fixture();
  await sessionMemory(f.config, 'sync');
  const old = f.task();
  const path = f.respond();
  expect((await sessionMemory(f.config, 'cancel')).status).toBe('cancelled');
  expect((await sessionMemory(f.config, 'sync')).status).toBe('cancelled');
  await expect(sessionMemory(f.config, 'submit', path)).rejects.toThrow(
    'POLICY_DENIED',
  );
  await sessionMemory(f.config, 'retry');
  expect(f.task().taskId).not.toBe(old.taskId);
  await expect(sessionMemory(f.config, 'submit', path)).rejects.toThrow(
    'INPUT_CHANGED',
  );
  expect((await sessionMemory(f.config, 'status')).status).toBe('failed');
  await sessionMemory(f.config, 'retry');
  expect((await sessionMemory(f.config, 'submit', f.respond())).status).toBe(
    'review',
  );
});

it.each([
  'foreign-revision',
  'duplicate',
  'unknown-property',
  'bad-line',
  'oversized',
  'empty-text',
])('rejects malformed worker response: %s', async (mode) => {
  const f = fixture();
  await sessionMemory(f.config, 'sync');
  f.respond((response) => {
    const c = response.candidates[0]!;
    if (mode === 'foreign-revision') c.revisionId = 'foreign';
    if (mode === 'duplicate') response.candidates.push(c);
    if (mode === 'unknown-property') Object.assign(c, { approved: true });
    if (mode === 'bad-line') c.line = 50;
    if (mode === 'oversized') c.markdown = 'x'.repeat(16_385);
    if (mode === 'empty-text') c.markdown = ' ';
  });
  await expect(
    sessionMemory(f.config, 'submit', f.responsePath),
  ).rejects.toThrow('INVALID_CANDIDATE');
  expect((await sessionMemory(f.config, 'status')).status).toBe('failed');
});

it('a changed source invalidates the prior review and retains exact revisions', async () => {
  const f = fixture();
  const first = await sessionMemory(f.config, 'sync');
  const review = await sessionMemory(f.config, 'submit', f.respond());
  const changed = JSON.parse(original);
  changed.payload.thread.turns[0].items[1].text =
    'Memory: Different synthetic evidence';
  writeFileSync(
    resolve(f.config.directory, 'selected.json'),
    JSON.stringify(changed),
  );
  const next = await sessionMemory(f.config, 'sync');
  expect(next.sourceVersion).not.toBe(first.sourceVersion);
  expect(next.taskId).not.toBe(first.taskId);
  await expect(
    sessionMemory(f.config, 'approve', review.reviewHash!),
  ).rejects.toThrow('POLICY_DENIED');
  await expect(
    sessionMemory(f.config, 'submit', f.responsePath),
  ).rejects.toThrow('INPUT_CHANGED');
});

it('does not advance checkpoint on partial exports or follow links; sync can recover', async () => {
  const f = fixture();
  const first = await sessionMemory(f.config, 'sync');
  writeFileSync(resolve(f.config.directory, 'selected.json'), '{');
  await expect(sessionMemory(f.config, 'sync')).rejects.toThrow(
    'INVALID_SESSION',
  );
  expect((await sessionMemory(f.config, 'status')).sourceVersion).toBe(
    first.sourceVersion,
  );
  writeFileSync(resolve(f.config.directory, 'selected.json'), original);
  symlinkSync(f.responsePath, resolve(f.config.directory, 'linked.json'));
  await expect(sessionMemory(f.config, 'sync')).rejects.toThrow('INVALID_PATH');
  rmSync(resolve(f.config.directory, 'linked.json'));
  await sessionMemory(f.config, 'retry');
  expect((await sessionMemory(f.config, 'sync')).status).toBe('pending');
});

it('CLI uses persisted config, reports disabled mode, and refuses concurrent server ownership', async () => {
  const f = fixture();
  const configPath = resolve(f.root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...f.config, enabled: false }));
  const result = spawnSync(
    process.execPath,
    ['scripts/session-memory.ts', 'sync', configPath],
    {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe('disabled');
  await sessionMemory(f.config, 'sync');
  const app = createApplication({
    dataRoot: f.config.dataRoot,
    ownerToken: owner,
    autoStart: false,
  });
  try {
    await expect(sessionMemory(f.config, 'sync')).rejects.toThrow(
      'CATALOG_IN_USE',
    );
  } finally {
    await app.app.close();
  }
});

it('refuses an edited review preview and keeps candidates out of the content store', async () => {
  const f = fixture();
  await sessionMemory(f.config, 'sync');
  const review = await sessionMemory(f.config, 'submit', f.respond());
  writeFileSync(review.previewPath!, 'Different review');
  await expect(
    sessionMemory(f.config, 'approve', review.reviewHash!),
  ).rejects.toThrow('INPUT_CHANGED');
  expect((await sessionMemory(f.config, 'status')).status).toBe('failed');
});

function interrupted(
  f: ReturnType<typeof fixture>,
  command: string,
  point: string,
  argument?: string,
) {
  // Faults exist only in this subprocess: abrupt process exit, not a production bypass flag.
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.renameSync;
    fs.renameSync = (from, to) => {
      const body = fs.readFileSync(from, 'utf8');
      if (${JSON.stringify(point)} === 'schema' && to.endsWith('/response-schema.json')) process.exit(91);
      if (${JSON.stringify(point)} === 'cursor' && to.endsWith('/state.json') && JSON.parse(body).status === 'published') process.exit(92);
      return original(from, to);
    };
    syncBuiltinESMExports();
    if (${JSON.stringify(point)} === 'publish') {
      const { Catalog } = await import('./packages/state-sqlite/src/index.ts');
      const publish = Catalog.prototype.publish;
      Catalog.prototype.publish = function(input) {
        if (input.run?.kind === 'process') process.exit(93);
        return publish.call(this, input);
      };
    }
    const { sessionMemory } = await import('./scripts/session-memory-workflow.ts');
    await sessionMemory(${JSON.stringify(f.config)}, ${JSON.stringify(command)}, ${JSON.stringify(argument) ?? 'undefined'});
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(import.meta.dirname, '../..'),
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env['PATH'] ?? '' },
  });
}

it('repairs both task and schema after actual process interruption during handoff persistence', async () => {
  const f = fixture();
  const crashed = interrupted(f, 'sync', 'schema');
  expect(crashed.status, crashed.stderr).toBe(91);
  const before = f.task();
  expect(existsSync(resolve(f.stateRoot, 'response-schema.json'))).toBe(false);
  const resumed = await sessionMemory(f.config, 'sync');
  expect(resumed.taskId).toBe(before.taskId);
  expect(existsSync(resolve(f.stateRoot, 'response-schema.json'))).toBe(true);
});

it('reconciles a committed publication after actual process exit before the cursor save', async () => {
  const f = fixture();
  const first = await sessionMemory(f.config, 'sync');
  const review = await sessionMemory(f.config, 'submit', f.respond());
  const crashed = interrupted(f, 'approve', 'cursor', review.reviewHash!);
  expect(crashed.status, crashed.stderr).toBe(92);
  const resumed = await sessionMemory(f.config, 'status');
  expect(resumed.status).toBe('published');
  expect(resumed.processedVersion).toBe(first.sourceVersion);
  expect((await sessionMemory(f.config, 'sync')).taskId).toBe(first.taskId);
});

it('fails closed after interruption before host publication and retries with a new task', async () => {
  const f = fixture();
  const first = await sessionMemory(f.config, 'sync');
  const review = await sessionMemory(f.config, 'submit', f.respond());
  const crashed = interrupted(f, 'approve', 'publish', review.reviewHash!);
  expect(crashed.status, crashed.stderr).toBe(93);
  expect((await sessionMemory(f.config, 'status')).status).toBe('failed');
  await sessionMemory(f.config, 'retry');
  expect(f.task().taskId).not.toBe(first.taskId);
  const app = createApplication({
    dataRoot: f.config.dataRoot,
    ownerToken: owner,
    autoStart: false,
  });
  try {
    expect(
      app.catalog
        .currentFiles(first.projectId!)
        .filter((f) => f.collection === 'derived'),
    ).toHaveLength(0);
  } finally {
    await app.app.close();
  }
});

it('refuses empty directories, oversized exports and pre-cancelled sync', async () => {
  const f = fixture();
  rmSync(resolve(f.config.directory, 'selected.json'));
  await expect(sessionMemory(f.config, 'sync')).rejects.toThrow(
    'EMPTY_SESSION',
  );
  writeFileSync(
    resolve(f.config.directory, 'selected.json'),
    'x'.repeat(1_048_577),
  );
  await expect(sessionMemory(f.config, 'sync')).rejects.toThrow('BYTE_LIMIT');
  const controller = new AbortController();
  controller.abort();
  await expect(
    sessionMemory(f.config, 'sync', undefined, controller.signal),
  ).rejects.toThrow();
});

it('refuses a parent symlink replacement between path validation and open', () => {
  const f = fixture();
  const elsewhere = resolve(f.root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(resolve(elsewhere, 'selected.json'), 'unselected synthetic');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.openSync;
    fs.openSync = (...args) => {
      fs.renameSync(${JSON.stringify(f.config.directory)}, ${JSON.stringify(f.config.directory + '-moved')});
      fs.symlinkSync(${JSON.stringify(elsewhere)}, ${JSON.stringify(f.config.directory)});
      return original(...args);
    };
    syncBuiltinESMExports();
    const { readLocalText } = await import('./packages/plugin-sdk/src/local-files.ts');
    try { readLocalText(${JSON.stringify(resolve(f.config.directory, 'selected.json'))}, 1048576); process.exit(2); }
    catch (error) { if (error.message !== 'UNSAFE_SYMLINK') throw error; }
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: process.env['PATH'] ?? '' },
    },
  );
  expect(result.status, result.stderr).toBe(0);
});

it('recalls reviewed candidates through the real loopback query CLI and MCP', async () => {
  const f = fixture();
  const initial = await sessionMemory(f.config, 'sync');
  const review = await sessionMemory(f.config, 'submit', f.respond());
  await sessionMemory(f.config, 'approve', review.reviewHash!);
  const app = createApplication({
    dataRoot: f.config.dataRoot,
    ownerToken: owner,
    autoStart: false,
  });
  try {
    const origin = await app.app.listen({ host: '127.0.0.1', port: 0 });
    const run = promisify(execFile);
    const result = await run(
      process.execPath,
      [
        'scripts/opencontext.ts',
        'search',
        initial.projectId!,
        'silver-lantern',
      ],
      {
        cwd: resolve(import.meta.dirname, '../..'),
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1_048_576,
        env: {
          PATH: process.env['PATH'] ?? '',
          OPENCONTEXT_URL: origin,
          OPENCONTEXT_QUERY_TOKEN: owner,
        },
      },
    );
    const hits = (JSON.parse(result.stdout) as SearchResult).hits;
    expect(hits).toHaveLength(3);
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
            section: 'Content',
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { structuredContent: ReadResult };
    };
    expect(body.result.structuredContent.text).toContain('silver-lantern');
    expect(body.result.structuredContent.citation.revisionId).toBe(
      file.revisionId,
    );
  } finally {
    await app.app.close();
  }
});
