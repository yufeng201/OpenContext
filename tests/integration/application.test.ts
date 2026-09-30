import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../../apps/server/src/app.ts';
import type {
  Binding,
  Project,
  Run,
  FileEntry,
  SearchResult,
  ReadResult,
} from '../../packages/contracts/src/index.ts';
import { mergeOwnedSnapshot } from '../../packages/core/src/index.ts';

const token = 'synthetic-application-owner-token-00000000';
const headers = { authorization: 'Bearer ' + token };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-app-test-')),
    repo = resolve(root, 'repo'),
    data = resolve(root, 'data');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'],
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  git('init', '-b', 'main');
  writeFileSync(
    resolve(repo, 'README.md'),
    '# Fixture\nalpha-needle 中文上下文\n',
  );
  writeFileSync(resolve(repo, 'module.md'), 'module-needle\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  let application = createApplication({
    dataRoot: data,
    ownerToken: token,
    allowedLocalRepoRoot: root,
    autoStart: false,
  });
  cleanups.push(async () => {
    await application.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    repo,
    data,
    git,
    get application() {
      return application;
    },
    async restart() {
      await application.app.close();
      application = createApplication({
        dataRoot: data,
        ownerToken: token,
        allowedLocalRepoRoot: root,
        autoStart: false,
      });
    },
    async setup() {
      const project = (
        await application.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers,
          payload: { name: 'Fixture' },
        })
      ).json<Project>();
      const binding = (
        await application.app.inject({
          method: 'POST',
          url: '/api/projects/' + project.id + '/bindings',
          headers,
          payload: { name: 'Repo', repoUrl: repo, branch: 'main' },
        })
      ).json<Binding>();
      return { project, binding };
    },
    async run(projectId: string, bindingId: string, action = 'sync') {
      const response = await application.app.inject({
        method: 'POST',
        url:
          '/api/projects/' +
          projectId +
          '/bindings/' +
          bindingId +
          '/' +
          action,
        headers,
      });
      expect(response.statusCode).toBe(202);
      const run = response.json<Run>();
      await application.coordinator.drain();
      const complete = application.catalog.getRun(run.id)!;
      expect(complete.state, complete.error ?? '').toBe('published');
      return complete;
    },
    async search(projectId: string, query: string, freshness = 'current_only') {
      const response = await application.app.inject({
        method: 'POST',
        url: '/api/projects/' + projectId + '/search',
        headers,
        payload: { query, mode: 'grep', freshness },
      });
      expect(response.statusCode).toBe(200);
      return response.json<SearchResult>();
    },
  };
}

describe('actual server + Git + durable files + index + processor', () => {
  it('publishes a fixed revision, is idempotent, preserves rename identity and deletes stale recall', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    const initialHead = f.application.catalog.head(project.id);
    const initial = (await f.search(project.id, 'alpha-needle')).hits[0]!;
    expect(initial.file.collection).toBe('sources');
    expect(f.application.catalog.pendingOutbox()).toHaveLength(0);
    await f.run(project.id, binding.id);
    expect(f.application.catalog.head(project.id)).toBe(initialHead);
    const revisionPath = resolve(
      f.data,
      'content/revisions',
      initial.file.fileId,
      initial.file.revisionId + '.json',
    );
    const historicalBytes = readFileSync(revisionPath);
    renameSync(resolve(f.repo, 'README.md'), resolve(f.repo, 'renamed.md'));
    f.git('add', '-A');
    f.git('commit', '-m', 'rename');
    await f.run(project.id, binding.id);
    const renamed = (await f.search(project.id, 'alpha-needle')).hits[0]!;
    expect(renamed.file.fileId).toBe(initial.file.fileId);
    expect(renamed.file.logicalPath).toMatch(/renamed.md$/);
    expect(readFileSync(revisionPath)).toEqual(historicalBytes);
    writeFileSync(resolve(f.repo, 'renamed.md'), 'new-needle\n');
    f.git('add', '.');
    f.git('commit', '-m', 'modify');
    await f.run(project.id, binding.id);
    expect((await f.search(project.id, 'alpha-needle')).hits).toHaveLength(0);
    const history = await f.application.app.inject({
      method: 'GET',
      url:
        '/api/projects/' +
        project.id +
        '/read?fileId=' +
        initial.file.fileId +
        '&revisionId=' +
        initial.file.revisionId,
      headers,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json<ReadResult>().text).toContain('alpha-needle');
    expect(history.json<ReadResult>().citation.commitId).toBe(initialHead);
    rmSync(resolve(f.repo, 'renamed.md'));
    f.git('add', '-A');
    f.git('commit', '-m', 'delete');
    await f.run(project.id, binding.id);
    expect((await f.search(project.id, 'new-needle')).hits).toHaveLength(0);
    expect(
      f.application.catalog
        .currentFiles(project.id)
        .find((file) => file.fileId === initial.file.fileId)?.tombstone,
    ).toBe(true);
  });
  it('recalls generated Markdown with sources, invalidates removed dependencies, and publishes full output deletions', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    await f.run(project.id, binding.id, 'process');
    const hits = (await f.search(project.id, 'module-needle')).hits;
    expect(new Set(hits.map((hit) => hit.file.collection))).toEqual(
      new Set(['sources', 'derived']),
    );
    const oldDerived = hits.find((hit) => hit.file.collection === 'derived')!;
    writeFileSync(resolve(f.repo, 'module.md'), 'updated-module-needle\n');
    f.git('add', '.');
    f.git('commit', '-m', 'change source while no processor');
    await f.run(project.id, binding.id);
    const current = f.application.catalog
      .currentFiles(project.id)
      .find((file) => file.fileId === oldDerived.file.fileId)!;
    expect(current.freshness).toBe('stale');
    expect(
      (await f.search(project.id, 'module-needle')).hits.every(
        (hit) => hit.file.freshness === 'fresh',
      ),
    ).toBe(true);
    expect(
      (await f.search(project.id, 'module-needle', 'include_stale')).hits.some(
        (hit) => hit.file.freshness === 'stale',
      ),
    ).toBe(true);
    rmSync(resolve(f.repo, 'module.md'));
    f.git('add', '-A');
    f.git('commit', '-m', 'remove module');
    await f.run(project.id, binding.id);
    expect(
      (await f.search(project.id, 'module-needle', 'include_stale')).hits,
    ).toHaveLength(0);
    await f.run(project.id, binding.id, 'process');
    expect(
      f.application.catalog
        .currentFiles(project.id)
        .find((file) => file.fileId === oldDerived.file.fileId)?.tombstone,
    ).toBe(true);
  });
  it('keeps invalid derived history denied after full output cleanup over REST and MCP', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    await f.run(project.id, binding.id, 'process');
    const hits = (await f.search(project.id, 'module-needle')).hits;
    const derived = hits.find((hit) => hit.file.collection === 'derived')!.file;
    const source = hits.find((hit) => hit.file.collection === 'sources')!.file;
    const reader = f.application.catalog.createReaderToken(project.id);
    const readHeaders = { authorization: 'Bearer ' + reader.token };
    let origin = await f.application.app.listen({ host: '127.0.0.1', port: 0 });
    const readRest = async (file: FileEntry) => {
      const url = new URL('/api/projects/' + project.id + '/read', origin);
      url.searchParams.set('fileId', file.fileId);
      url.searchParams.set('revisionId', file.revisionId);
      const response = await fetch(url, { headers: readHeaders });
      return { status: response.status, body: await response.text() };
    };
    const readMcp = async () => {
      const response = await fetch(new URL('/mcp', origin), {
        method: 'POST',
        headers: {
          ...readHeaders,
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
              projectId: project.id,
              fileId: derived.fileId,
              revisionId: derived.revisionId,
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        error?: { message: string };
        result?: { structuredContent: ReadResult };
      };
    };
    expect((await readRest(derived)).status).toBe(200);
    expect((await readMcp()).result?.structuredContent.text).toContain(
      'module-needle',
    );
    rmSync(resolve(f.repo, 'module.md'));
    f.git('add', '-A');
    f.git('commit', '-m', 'remove source of historical derived content');
    await f.run(project.id, binding.id);
    const assertDenied = async () => {
      const response = await readRest(derived);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain('module-needle');
      const mcp = await readMcp();
      expect(mcp.error?.message).toBe('NOT_FOUND');
      expect(mcp.result).toBeUndefined();
      expect(JSON.stringify(mcp)).not.toContain('module-needle');
    };
    await assertDenied();
    await f.run(project.id, binding.id, 'process');
    expect(
      f.application.catalog
        .currentFiles(project.id)
        .find((file) => file.fileId === derived.fileId)?.tombstone,
    ).toBe(true);
    await assertDenied();
    // Direct authorized source history remains supported; this exemption must
    // never propagate through derivedFrom to stale generated excerpts.
    const history = await readRest(source);
    expect(history.status).toBe(200);
    expect(history.body).toContain('module-needle');
    await f.restart();
    origin = await f.application.app.listen({ host: '127.0.0.1', port: 0 });
    await assertDenied();
  });
  it('survives restart with queued work, fixed citations and persistent index', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    f.application.catalog.enqueue(binding.id, 'sync');
    await f.restart();
    await f.application.coordinator.drain();
    const first = (await f.search(project.id, 'alpha-needle')).hits[0]!;
    const head = f.application.catalog.head(project.id);
    await f.restart();
    expect(f.application.catalog.head(project.id)).toBe(head);
    expect(
      (await f.search(project.id, 'alpha-needle')).hits[0]?.citation,
    ).toEqual(first.citation);
  });
  it('denies unauthenticated/cross-project access, immediately revokes tokens and source descendants', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    await f.run(project.id, binding.id, 'process');
    const reader = f.application.catalog.createReaderToken(project.id);
    const other = f.application.catalog.createProject('Other');
    const readHeaders = { authorization: 'Bearer ' + reader.token };
    expect((await f.application.app.inject('/api/projects')).statusCode).toBe(
      401,
    );
    expect(
      (
        await f.application.app.inject({
          method: 'GET',
          url: '/api/projects/' + other.id + '/tree',
          headers: readHeaders,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.application.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: readHeaders,
          payload: { name: 'Denied' },
        })
      ).statusCode,
    ).toBe(403);
    const hit = (await f.search(project.id, 'alpha-needle')).hits.find(
      (item) => item.file.collection === 'derived',
    )!;
    f.application.catalog.revokeBinding(binding.id);
    expect(
      (await f.search(project.id, 'alpha-needle', 'include_stale')).hits,
    ).toHaveLength(0);
    expect(
      (
        await f.application.app.inject({
          method: 'GET',
          url:
            '/api/projects/' +
            project.id +
            '/read?fileId=' +
            hit.file.fileId +
            '&revisionId=' +
            hit.file.revisionId,
          headers: readHeaders,
        })
      ).statusCode,
    ).toBe(404);
    f.application.catalog.revokeToken(reader.id);
    expect(
      (
        await f.application.app.inject({
          method: 'GET',
          url: '/api/projects/' + project.id + '/tree',
          headers: readHeaders,
        })
      ).statusCode,
    ).toBe(401);
  });
  it('keeps the live identity when a rename reuses a tombstoned path and is synced again', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    const initial = f.application.catalog
      .currentFiles(project.id)
      .sort((a, b) => a.fileId.localeCompare(b.fileId));
    const retired = initial[0]!,
      retained = initial[1]!;
    const destination = retired.slotKey,
      source = retained.slotKey;
    rmSync(resolve(f.repo, destination));
    f.git('add', '-A');
    f.git('commit', '-m', 'remove destination');
    await f.run(project.id, binding.id);
    f.git('mv', source, destination);
    f.git('commit', '-m', 'reuse old path');
    await f.run(project.id, binding.id);
    const head = f.application.catalog.head(project.id);
    expect(
      f.application.catalog
        .currentFiles(project.id)
        .find((file) => !file.tombstone)?.fileId,
    ).toBe(retained.fileId);
    await f.run(project.id, binding.id);
    expect(
      f.application.catalog
        .currentFiles(project.id)
        .find((file) => !file.tombstone)?.fileId,
    ).toBe(retained.fileId);
    expect(f.application.catalog.head(project.id)).toBe(head);
  });
  it('marks generated navigation stale on rename or membership change, but not on a no-op sync', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    await f.run(project.id, binding.id, 'process');
    await f.run(project.id, binding.id);
    expect(
      f.application.catalog
        .currentFiles(project.id)
        .filter((file) => file.collection === 'derived')
        .every((file) => file.freshness === 'fresh'),
    ).toBe(true);
    const original = f.application.catalog
      .currentFiles(project.id)
      .find((file) => file.slotKey === 'README.md')!;
    f.git('mv', 'README.md', 'RENAMED.md');
    f.git('commit', '-m', 'rename input');
    await f.run(project.id, binding.id);
    expect(
      f.application.catalog
        .currentFiles(project.id)
        .find((file) => file.fileId === original.fileId)?.revisionId,
    ).toBe(original.revisionId);
    expect(
      (await f.search(project.id, 'README.md')).hits.filter(
        (hit) => hit.file.collection === 'derived',
      ),
    ).toHaveLength(0);
    expect(
      (await f.search(project.id, 'README.md', 'include_stale')).hits.some(
        (hit) => hit.file.freshness === 'stale',
      ),
    ).toBe(true);
    await f.run(project.id, binding.id, 'process');
    expect(
      (await f.search(project.id, 'RENAMED.md')).hits.some(
        (hit) => hit.file.collection === 'derived',
      ),
    ).toBe(true);
    writeFileSync(resolve(f.repo, 'NEW.md'), 'new-membership-needle');
    f.git('add', '.');
    f.git('commit', '-m', 'add input');
    await f.run(project.id, binding.id);
    const index = f.application.catalog
      .currentFiles(project.id)
      .find(
        (file) => file.collection === 'derived' && file.slotKey === 'index',
      );
    expect(index?.freshness).toBe('stale');
    await f.run(project.id, binding.id, 'process');
    const updated = f.application.catalog
      .currentFiles(project.id)
      .find(
        (file) => file.collection === 'derived' && file.slotKey === 'index',
      )!;
    expect(updated.freshness).toBe('fresh');
    expect(f.application.store.readText(updated.contentHash)).toContain(
      'NEW.md',
    );
  });
  it('rejects corrupt content and keeps the old head on a failed immutable write', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    const hit = (await f.search(project.id, 'alpha-needle')).hits[0]!;
    const blob = resolve(
      f.data,
      'content/blobs',
      hit.file.contentHash.slice(0, 2),
      hit.file.contentHash,
    );
    writeFileSync(blob, 'corruption');
    const response = await f.application.app.inject({
      method: 'GET',
      url:
        '/api/projects/' +
        project.id +
        '/read?fileId=' +
        hit.file.fileId +
        '&revisionId=' +
        hit.file.revisionId,
      headers,
    });
    expect(response.statusCode).toBe(500);
    const oldHead = f.application.catalog.head(project.id);
    const run = f.application.catalog.enqueue(binding.id, 'sync');
    await f.application.coordinator.drain();
    expect(f.application.catalog.getRun(run.id)?.state).toBe('failed');
    expect(f.application.catalog.head(project.id)).toBe(oldHead);
  });
  it('rejects a changed persisted input manifest before processing or publishing', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    const head = f.application.catalog.head(project.id)!;
    const path = resolve(f.data, 'content/commits', project.id, head + '.json');
    // Valid JSON with the same IDs must still fail the catalog hash check.
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + ' ');
    const run = f.application.catalog.enqueue(binding.id, 'process');
    await f.application.coordinator.drain();
    expect(f.application.catalog.getRun(run.id)?.error).toBe(
      'CORRUPT_MANIFEST',
    );
    expect(f.application.catalog.getRun(run.id)?.state).toBe('failed');
    expect(f.application.catalog.head(project.id)).toBe(head);
    expect(
      f.application.catalog
        .currentFiles(project.id)
        .some((file) => file.collection === 'derived'),
    ).toBe(false);
  });
  it('does not publish when manifest persistence fails before the DB gate', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    const head = f.application.catalog.head(project.id);
    const snapshot = f.application.catalog.currentFiles(project.id);
    writeFileSync(resolve(f.repo, 'README.md'), 'not-yet-visible\n');
    f.git('add', '.');
    f.git('commit', '-m', 'candidate');
    const manifest = vi
      .spyOn(f.application.store, 'manifest')
      .mockImplementation(() => {
        throw new Error('IO_ERROR');
      });
    const run = f.application.catalog.enqueue(binding.id, 'sync');
    await f.application.coordinator.drain();
    expect(f.application.catalog.getRun(run.id)?.state).toBe('failed');
    expect(f.application.catalog.head(project.id)).toBe(head);
    expect(f.application.catalog.currentFiles(project.id)).toEqual(snapshot);
    expect((await f.search(project.id, 'not-yet-visible')).hits).toHaveLength(
      0,
    );
    manifest.mockRestore();
    await f.run(project.id, binding.id);
    expect((await f.search(project.id, 'not-yet-visible')).hits).toHaveLength(
      1,
    );
  });
  it('keeps an index failure in durable outbox and recovers it after restart', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    const replace = vi
      .spyOn(f.application.coordinator.index, 'replaceProject')
      .mockImplementation(() => {
        throw new Error('INDEX_FAILURE');
      });
    await f.run(project.id, binding.id);
    expect(f.application.catalog.pendingOutbox()).toHaveLength(1);
    const fallback = await f.search(project.id, 'alpha-needle');
    expect(fallback.hits).toHaveLength(1);
    expect(fallback.indexCoverage).toBe('partial');
    replace.mockRestore();
    await f.restart();
    await f.application.coordinator.drain();
    expect(f.application.catalog.pendingOutbox()).toHaveLength(0);
    expect((await f.search(project.id, 'alpha-needle')).indexCoverage).toBe(
      'ready',
    );
  });
  it('hides revoked source configuration and run metadata from a project reader', async () => {
    const f = fixture(),
      { project, binding } = await f.setup();
    await f.run(project.id, binding.id);
    const reader = f.application.catalog.createReaderToken(project.id);
    const readerHeaders = { authorization: 'Bearer ' + reader.token };
    f.application.catalog.revokeBinding(binding.id);
    for (const endpoint of ['bindings', 'runs']) {
      const response = await f.application.app.inject({
        url: '/api/projects/' + project.id + '/' + endpoint,
        headers: readerHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      const owner = await f.application.app.inject({
        url: '/api/projects/' + project.id + '/' + endpoint,
        headers,
      });
      expect(owner.json()).toHaveLength(1);
    }
  });
  it('rejects secret-bearing source URLs before any catalog persistence', async () => {
    const f = fixture(),
      { project } = await f.setup();
    const before = f.application.catalog.listBindings(project.id).length;
    for (const repoUrl of [
      'https://fixture:SYNTHETIC-ONLY@example.invalid/repo.git',
      'https://example.invalid/repo.git?token=SYNTHETIC-ONLY',
      'https://example.invalid/repo.git#SYNTHETIC-ONLY',
    ]) {
      const response = await f.application.app.inject({
        method: 'POST',
        url: '/api/projects/' + project.id + '/bindings',
        headers,
        payload: { name: 'must not persist', repoUrl, branch: 'main' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('SYNTHETIC-ONLY');
      expect(f.application.catalog.listBindings(project.id)).toHaveLength(
        before,
      );
    }
  });
  it('returns safe 400/413 input errors instead of an internal server error', async () => {
    const f = fixture();
    for (const [payload, status, code] of [
      ['{', 400, 'INVALID_JSON'],
      [JSON.stringify({ query: 'x'.repeat(70000) }), 413, 'PAYLOAD_TOO_LARGE'],
    ] as const) {
      const response = await f.application.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...headers, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
    }
  });
  it('blocks cross-origin browser mutations and malformed contract payloads', async () => {
    const f = fixture();
    expect(
      (
        await f.application.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: { ...headers, origin: 'https://evil.invalid' },
          payload: { name: 'Denied' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.application.app.inject({
          method: 'POST',
          url: '/api/projects',
          headers,
          payload: { name: 'Valid name with unknown field', unknown: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.application.app.inject({
          url: '/api/health',
          headers: { host: 'evil.invalid' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

it('full output ownership protects authored promotion and does not mutate input snapshots', () => {
  const base: FileEntry = {
    fileId: 'f',
    revisionId: 'r',
    contentHash: 'a'.repeat(64),
    bytes: 1,
    projectId: 'p',
    bindingId: 'b',
    slotKey: 'module',
    logicalPath: 'authored/note.md',
    collection: 'authored',
    ownership: 'human_owned',
    freshness: 'fresh',
    tombstone: false,
    sourceVersion: 'sha',
    createdAt: 'now',
    derivedFrom: [],
  };
  expect(() =>
    mergeOwnedSnapshot(
      [base],
      [
        {
          ...base,
          collection: 'derived',
          ownership: 'generated',
          logicalPath: 'derived/b/note.md',
          revisionId: 'r2',
        },
      ],
      'b',
      'derived',
    ),
  ).toThrow('OUTPUT_CONFLICT');
  expect(mergeOwnedSnapshot([base], [], 'b', 'derived')).toEqual([base]);
  expect(base.tombstone).toBe(false);
});
