import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../../apps/server/src/app.ts';
import { StaticRegistry } from '../../packages/plugin-host/src/index.ts';
import { markdownDefinition } from '../../plugins/markdown-processor/src/index.ts';
import type { ConnectorDefinition } from '../../packages/plugin-sdk/src/index.ts';
import { Catalog } from '../../packages/state-sqlite/src/index.ts';
import { auditEvent } from '../../apps/server/src/audit.ts';
import { parseAuditEvent } from '../../packages/contracts/src/audit.ts';
const owner = 'synthetic-audit-owner-0000000000000000';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oc-audit-')),
    data = join(root, 'data'),
    web = join(root, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), 'synthetic');
  const definition: ConnectorDefinition = {
    manifest: {
      id: 'fixture.audit',
      version: '1.0.0',
      protocolVersion: '1',
      capabilities: ['connector'],
      location: 'server',
      trust: 'official-trusted-native',
    },
    capability: 'connector',
    artifactPaths: [import.meta.url],
    title: 'synthetic',
    description: 'offline',
    configSchema: Type.Object({}, { additionalProperties: false }),
    fields: [],
    acceptsImports: true,
    probe: () => ({
      available: true,
      capabilities: ['connector'],
      limitations: [],
    }),
    invoke: async () => ({
      sourceVersion: 'one',
      complete: true,
      files: [
        {
          relativePath: 'README.md',
          content: 'synthetic audit file',
          mime: 'text/markdown',
        },
      ],
      renames: [],
      skipped: [],
    }),
  };
  const registry = new StaticRegistry([definition, markdownDefinition]);
  let app = createApplication({
    dataRoot: data,
    webRoot: web,
    ownerToken: owner,
    registry,
    autoStart: false,
  });
  cleanups.push(async () => {
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    token = owner,
  ) =>
    app.app.inject({
      method,
      url,
      headers: { authorization: 'Bearer ' + token },
      ...(payload === undefined ? {} : { payload }),
    });
  return {
    get app() {
      return app;
    },
    call,
    async restart() {
      await app.app.close();
      app = createApplication({
        dataRoot: data,
        webRoot: web,
        ownerToken: owner,
        registry,
        autoStart: false,
      });
    },
  };
}
it('structured audit records management/import/fixed REST+MCP reads/denials without queries, text or credentials', async () => {
  const f = fixture();
  const project = (
    await f.call('POST', '/api/projects', { name: 'PRIVATE_PROJECT_NAME' })
  ).json();
  const binding = (
    await f.call('POST', '/api/projects/' + project.id + '/bindings', {
      name: 'PRIVATE_SOURCE_NAME',
      connector: { packageRef: 'fixture.audit@1.0.0', config: {} },
      processor: { packageRef: 'org.opencontext.markdown@0.1.0', config: {} },
    })
  ).json();
  expect(binding.id).toBeDefined();
  const imported = (
    await f.call(
      'POST',
      '/api/projects/' + project.id + '/bindings/' + binding.id + '/imports',
      {
        filename: 'private-filename.json',
        content: JSON.stringify({ text: 'PRIVATE_IMPORT_BODY' }),
      },
    )
  ).json();
  expect(imported.id).toBeDefined();
  const queued = await f.call(
    'POST',
    '/api/projects/' + project.id + '/bindings/' + binding.id + '/sync',
  );
  expect(queued.statusCode).toBe(202);
  const run = queued.json();
  await f.app.coordinator.drain();
  const file = f.app.catalog
    .currentFiles(project.id)
    .find((file) => file.collection === 'sources')!;
  const tokenResponse = await f.call(
    'POST',
    '/api/projects/' + project.id + '/tokens',
  );
  const reader = tokenResponse.json();
  const readUrl =
    '/api/projects/' +
    project.id +
    '/read?' +
    new URLSearchParams({ fileId: file.fileId, revisionId: file.revisionId });
  expect(
    (await f.call('GET', readUrl, undefined, reader.token)).statusCode,
  ).toBe(200);
  const mcp = await f.app.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: 'Bearer ' + reader.token,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
    },
    payload: {
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
    },
  });
  expect(mcp.statusCode).toBe(200);
  expect(mcp.body).toContain('synthetic audit file');
  expect(
    (
      await f.call(
        'POST',
        '/api/projects/' + project.id + '/search',
        { query: 'PRIVATE_SEARCH_QUERY' },
        reader.token,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await f.call(
        'DELETE',
        '/api/projects/' + project.id + '/bindings/' + binding.id,
        undefined,
        reader.token,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (await f.call('GET', '/api/audit', undefined, reader.token)).statusCode,
  ).toBe(403);
  expect((await f.call('GET', '/api/audit?limit=1001')).statusCode).toBe(400);
  expect(
    (
      await f.call(
        'DELETE',
        '/api/projects/' + project.id + '/bindings/' + binding.id,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await f.call('GET', readUrl, undefined, reader.token)).statusCode,
  ).toBe(404);
  const exportResponse = await f.call('GET', '/api/audit?limit=1000');
  expect(exportResponse.statusCode).toBe(200);
  const exported = exportResponse.json();
  for (const secret of [
    owner,
    reader.token,
    'PRIVATE_PROJECT_NAME',
    'PRIVATE_SOURCE_NAME',
    'PRIVATE_SEARCH_QUERY',
    'PRIVATE_IMPORT_BODY',
    'private-filename.json',
    'synthetic audit file',
  ])
    expect(exportResponse.body).not.toContain(secret);
  for (const event of exported.events)
    expect(() =>
      parseAuditEvent(
        Object.fromEntries(
          Object.entries(event).filter(([key]) => key !== 'sequence'),
        ),
      ),
    ).not.toThrow();
  expect(exported.tamperEvident).toBe(false);
  expect(exported.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'source.create',
        target: expect.objectContaining({ bindingId: binding.id }),
      }),
      expect.objectContaining({
        action: 'import.create',
        target: expect.objectContaining({ objectId: imported.id }),
      }),
      expect.objectContaining({
        action: 'token.create',
        target: expect.objectContaining({ tokenId: reader.id }),
      }),
      expect.objectContaining({
        action: 'source.revoke',
        actor: { id: reader.id, role: 'reader' },
        result: 'denied',
        code: 'FORBIDDEN',
      }),
      expect.objectContaining({
        action: 'source.revoke',
        actor: { id: 'owner', role: 'owner' },
        result: 'success',
      }),
      expect.objectContaining({
        action: 'file.read',
        code: 'NOT_FOUND',
        result: 'denied',
      }),
    ]),
  );
  const reads = exported.events.filter(
    (event: { action: string; code: string }) =>
      event.action === 'file.read' && event.code === 'OK',
  );
  expect(reads).toHaveLength(2);
  expect(reads[0].target.revisionId).toBe(file.revisionId);
  expect(reads[1].requestId).toBe(mcp.headers['x-request-id']);
  const enqueue = exported.events.find(
      (event: { action: string }) => event.action === 'task.enqueue',
    ),
    completed = exported.events.find(
      (event: { action: string }) => event.action === 'task.complete',
    );
  expect(enqueue.jobId).toBe(run.id);
  expect(completed.jobId).toBe(run.id);
  expect(completed.requestId).toBe(queued.headers['x-request-id']);
  expect(completed.result).toBe('success');
  expect(completed.actor.role).toBe('system');
  const stable = (
    await f.call(
      'GET',
      '/api/audit?after=' +
        exported.nextCursor +
        '&until=' +
        exported.snapshotSequence,
    )
  ).json();
  expect(stable.events).toEqual([]);
  await f.restart();
  const restarted = (await f.call('GET', '/api/audit')).json();
  expect(
    restarted.events.some((event: { id: string }) => event.id === reads[0].id),
  ).toBe(true);
});
it('anonymous failure cannot spoof request ID or leak tokens/invalid targets into audit', async () => {
  const f = fixture();
  const response = await f.app.app.inject({
    url: '/api/projects',
    headers: {
      authorization: 'Bearer PRIVATE_AUTH_SECRET',
      'x-request-id': 'PRIVATE_FORGED_ID',
    },
  });
  expect(response.statusCode).toBe(401);
  const exported = (await f.call('GET', '/api/audit')).json();
  const denial = exported.events.find(
    (event: { code: string }) => event.code === 'UNAUTHORIZED',
  );
  expect(denial.actor).toEqual({ id: 'anonymous', role: 'anonymous' });
  expect(denial.requestId).toBe(response.headers['x-request-id']);
  expect(JSON.stringify(exported)).not.toMatch(
    /PRIVATE_AUTH_SECRET|PRIVATE_FORGED_ID/,
  );
});
it('audit is bounded by30-day/10000-event retention with gap-visible cursors, schema refuses sensitive extra fields', () => {
  const catalog = new Catalog(':memory:');
  try {
    const event = auditEvent(
      'test.operation',
      undefined,
      {},
      'success',
      'OK',
      randomUUID(),
    );
    expect(() => parseAuditEvent({ ...event, query: 'PRIVATE' })).toThrow(
      'INVALID_AUDIT_EVENT',
    );
    catalog.db.exec('BEGIN');
    const insert = catalog.db.prepare(
      'INSERT INTO audit_events(time,event_json) VALUES(?,?)',
    );
    for (let n = 0; n < 10002; n++)
      insert.run(event.time, JSON.stringify({ ...event, id: randomUUID() }));
    const old = {
      ...event,
      id: randomUUID(),
      time: '2000-01-01T00:00:00.000Z',
    };
    insert.run(old.time, JSON.stringify(old));
    catalog.db.exec('COMMIT');
    expect(
      catalog.auditEvents(0, 1000).events.some((event) => event.id === old.id),
    ).toBe(false);
    catalog.appendAudit({ ...event, id: randomUUID() });
    expect(
      catalog.db.prepare('SELECT count(*) AS count FROM audit_events').get()?.[
        'count'
      ],
    ).toBe(10000);
    const page = catalog.auditEvents(0, 2);
    expect(page.oldestSequence).toBeGreaterThan(1);
    expect(page.nextCursor).toBe(page.events[1]!.sequence);
    expect(
      catalog.auditEvents(page.nextCursor, 1).events[0]!.sequence,
    ).toBeGreaterThan(page.nextCursor);
  } finally {
    catalog.close();
  }
});
it('audit append failure degrades owner readiness without exposing database details', async () => {
  const f = fixture();
  f.app.catalog.db.exec('DROP TABLE audit_events');
  expect((await f.call('GET', '/api/projects')).statusCode).toBe(200);
  const response = await f.call('GET', '/api/readiness');
  expect(response.statusCode).toBe(503);
  expect(response.json().audit).toEqual({
    ok: false,
    code: 'AUDIT_UNAVAILABLE',
    pending: 0,
    maxPending: 10000,
    suspended: false,
    readGap: true,
    readGapPersisted: true,
  });
  expect(response.body).not.toContain('no such table');
});
