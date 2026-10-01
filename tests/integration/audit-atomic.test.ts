import { afterEach, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { TextIndex } from '../../packages/retrieval/src/index.ts';
import { FileStore } from '../../packages/storage-fs/src/index.ts';
import { DatabaseSync } from 'node:sqlite';
import {
  inspectStorage,
  createBackup,
  verifyBackup,
  restoreBackup,
} from '../../packages/state-sqlite/src/maintenance.ts';
import { Catalog } from '../../packages/state-sqlite/src/index.ts';
import { StaticRegistry } from '../../packages/plugin-host/src/index.ts';
import { repoDefinition } from '../../plugins/repo-connector/src/index.ts';
import { markdownDefinition } from '../../plugins/markdown-processor/src/index.ts';
import { AuditDispatcher } from '../../apps/server/src/audit-dispatcher.ts';
import { auditEvent } from '../../apps/server/src/audit.ts';
import { createApplication } from '../../apps/server/src/app.ts';
const owner = 'synthetic-atomic-audit-owner-000000000000';
const headers = { authorization: 'Bearer ' + owner };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oc-audit-atomic-')),
    path = join(root, 'control.sqlite');
  let catalog = new Catalog(path),
    closed = false;
  const project = catalog.createProject('PRIVATE_PROJECT_NAME'),
    registry = new StaticRegistry([repoDefinition, markdownDefinition]);
  const prepared = () => ({
    name: 'PRIVATE_SOURCE_NAME',
    connector: registry.prepareSync(
      {
        packageRef: 'org.opencontext.repo@0.1.0',
        config: { repoUrl: 'https://example.org/repo', branch: 'main' },
      },
      'connector',
    ),
    processor: registry.prepareSync(
      { packageRef: 'org.opencontext.markdown@0.1.0', config: {} },
      'processor',
    ),
  });
  const binding = catalog.createBinding(project.id, prepared()),
    reader = catalog.createReaderToken(project.id);
  catalog.deliverAuditBatch();
  catalog.db.exec('DELETE FROM audit_events');
  const close = () => {
    if (!closed) {
      catalog.close();
      closed = true;
    }
  };
  cleanups.push(async () => {
    close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    project,
    binding,
    reader,
    prepared,
    get catalog() {
      return catalog;
    },
    close,
    reopen() {
      close();
      catalog = new Catalog(path);
      closed = false;
      return catalog;
    },
  };
}
const count = (catalog: Catalog, table: string) =>
  Number(catalog.db.prepare('SELECT count(*) AS n FROM ' + table).get()?.['n']);
it('audit intent failure rolls back source/token/import/queue mutations, with stable private diagnostics', () => {
  const f = fixture(),
    catalog = f.catalog;
  const original = catalog.putImport(f.binding.id, {
    id: randomUUID(),
    filename: 'private.json',
    contentHash: 'a'.repeat(64),
    bytes: 1,
  });
  catalog.deliverAuditBatch();
  catalog.db.exec('DELETE FROM audit_events');
  catalog.db.exec(
    "CREATE TRIGGER refuse_intent BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT,'PRIVATE_NATIVE_DIAGNOSTIC'); END;",
  );
  for (const operation of [
    () => catalog.revokeBinding(f.binding.id),
    () => catalog.revokeToken(f.reader.id),
    () => catalog.createReaderToken(f.project.id),
    () => catalog.createProject('PRIVATE_FAILED_NAME'),
    () => catalog.createBinding(f.project.id, f.prepared()),
    () => catalog.enqueue(f.binding.id, 'sync'),
    () => catalog.removeImport(f.binding.id, original.id),
    () =>
      catalog.putImport(
        f.binding.id,
        {
          id: randomUUID(),
          filename: 'private.json',
          contentHash: 'b'.repeat(64),
          bytes: 2,
        },
        original.id,
      ),
  ])
    expect(operation).toThrow(/^AUDIT_UNAVAILABLE$/);
  expect(catalog.getBinding(f.binding.id)?.active).toBe(true);
  expect(catalog.authenticate(f.reader.token, owner)?.id).toBe(f.reader.id);
  expect(count(catalog, 'reader_tokens')).toBe(1);
  expect(count(catalog, 'projects')).toBe(1);
  expect(count(catalog, 'bindings')).toBe(1);
  expect(catalog.listRuns(f.project.id)).toEqual([]);
  expect(catalog.listImports(f.binding.id)).toEqual([original]);
  expect(catalog.auditPending().pending).toBe(0);
  expect(catalog.auditEvents().events).toEqual([]);
});
it('publish head/revisions/index-outbox and audit intent share a rollback; successful replay does not repeat committed publication', () => {
  const f = fixture(),
    catalog = f.catalog;
  catalog.enqueue(f.binding.id, 'sync');
  catalog.deliverAuditBatch();
  const run = catalog.claim()!;
  const input = {
    projectId: f.project.id,
    expectedHead: null,
    commitId: randomUUID(),
    manifestHash: 'a'.repeat(64),
    files: [],
    run,
    sourceVersion: 'a'.repeat(40),
  };
  catalog.db.exec(
    "CREATE TRIGGER refuse_publish BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT,'PRIVATE_PUBLISH_BODY'); END;",
  );
  expect(() => catalog.publish(input)).toThrow('AUDIT_UNAVAILABLE');
  expect(catalog.head(f.project.id)).toBe(null);
  expect(count(catalog, 'commits')).toBe(0);
  expect(catalog.pendingOutbox()).toEqual([]);
  expect(catalog.getRun(run.id)?.state).toBe('running');
  catalog.db.exec('DROP TRIGGER refuse_publish');
  catalog.publish(input);
  catalog.publish(input);
  expect(catalog.head(f.project.id)).toBe(input.commitId);
  expect(catalog.pendingAuditEvents()).toHaveLength(1);
  expect(catalog.pendingAuditEvents()[0]?.target.commitId).toBe(input.commitId);
  expect(catalog.pendingAuditEvents()[0]?.jobId).toBe(run.id);
  expect(catalog.pendingAuditEvents()[0]?.guarantee).toBe('committed');
});
it('sink replay is idempotent; conflicting duplicate identity is retained as a fault, not silently acknowledged', () => {
  const f = fixture(),
    catalog = f.catalog;
  catalog.revokeBinding(f.binding.id);
  const event = catalog.pendingAuditEvents()[0]!;
  expect(catalog.deliverAuditBatch()).toBe(1);
  const requeue = (payload: typeof event) =>
    catalog.db
      .prepare('INSERT INTO audit_pending VALUES(?,?,?)')
      .run(payload.id, payload.time, JSON.stringify(payload));
  requeue(event);
  expect(catalog.deliverAuditBatch()).toBe(1);
  expect(catalog.auditEvents().events).toHaveLength(1);
  expect(catalog.auditPending().pending).toBe(0);
  requeue({ ...event, action: 'source.create' });
  expect(() => catalog.deliverAuditBatch()).toThrow('AUDIT_CONFLICT');
  expect(catalog.auditPending().pending).toBe(1);
  expect(catalog.auditEvents().events[0]?.action).toBe('source.revoke');
});
async function crash(
  f: ReturnType<typeof fixture>,
  point: 'before' | 'after' | 'delivery',
) {
  f.close();
  const url = pathToFileURL(resolve('packages/state-sqlite/src/index.ts')).href;
  const program = `const {Catalog}=await import(${JSON.stringify(url)});const c=new Catalog(${JSON.stringify(f.path)});c.db.function('crash',()=>{process.kill(process.pid,'SIGKILL');return 1;});${point === 'before' ? "c.db.exec(\"CREATE TRIGGER crash_point AFTER INSERT ON audit_pending WHEN json_extract(NEW.event_json,'$.action')='source.revoke' BEGIN SELECT crash(); END;\");" : point === 'delivery' ? "c.db.exec('CREATE TRIGGER crash_point AFTER INSERT ON audit_events BEGIN SELECT crash(); END;');" : ''}${point === 'delivery' ? 'c.deliverAuditBatch();' : `c.revokeBinding(${JSON.stringify(f.binding.id)});`}${point === 'after' ? "process.kill(process.pid,'SIGKILL');" : ''}`;
  const result = await new Promise<{
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', program],
      {
        env: { PATH: process.env['PATH'] },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fixture timeout'));
    }, 5000);
    child.stderr.on('data', (part) => (stderr += String(part)));
    child.once('error', reject);
    child.once('close', (_code, signal) => {
      clearTimeout(timer);
      resolve({ signal, stderr });
    });
  });
  expect(result.stderr).toBe('');
  expect(result.signal).toBe('SIGKILL');
  const catalog = f.reopen();
  catalog.db.exec('DROP TRIGGER IF EXISTS crash_point');
  return catalog;
}
it('actual SIGKILL before commit rolls back mutation and intent together', async () => {
  const f = fixture(),
    catalog = await crash(f, 'before');
  expect(catalog.getBinding(f.binding.id)?.active).toBe(true);
  expect(catalog.auditPending().pending).toBe(0);
  expect(catalog.auditEvents().events).toEqual([]);
});
it('actual SIGKILL after commit preserves intent, and SIGKILL during sink transaction preserves replay without double delivery', async () => {
  const f = fixture();
  let catalog = await crash(f, 'after');
  expect(catalog.getBinding(f.binding.id)?.active).toBe(false);
  expect(catalog.auditPending().pending).toBe(1);
  const id = catalog.pendingAuditEvents()[0]!.id;
  catalog = await crash(f, 'delivery');
  expect(catalog.auditPending().pending).toBe(1);
  expect(catalog.auditEvents().events).toEqual([]);
  expect(catalog.deliverAuditBatch()).toBe(1);
  expect(catalog.deliverAuditBatch()).toBe(0);
  expect(catalog.auditEvents().events.map((event) => event.id)).toEqual([id]);
});
it('real SQLite page-budget FULL rolls back both effect and intent without partial audit; not a physical power-loss test', () => {
  const f = fixture(),
    catalog = f.catalog;
  catalog.db.exec('VACUUM');
  const pages = Number(
    catalog.db.prepare('PRAGMA page_count').get()?.['page_count'],
  );
  catalog.db.exec('PRAGMA max_page_count=' + pages);
  let full = false;
  for (let attempt = 0; attempt < 500; attempt++) {
    const projects = count(catalog, 'projects'),
      pending = catalog.auditPending().pending;
    try {
      catalog.createProject('synthetic ' + attempt);
    } catch (error) {
      let cause = error;
      for (let n = 0; n < 4; n++) {
        if (cause instanceof Error && cause.cause) cause = cause.cause;
        else break;
      }
      expect(cause).toHaveProperty('errcode', 13);
      expect(count(catalog, 'projects')).toBe(projects);
      expect(catalog.auditPending().pending).toBe(pending);
      full = true;
      break;
    }
  }
  expect(full).toBe(true);
});
it('10000 durable pending records block further critical changes; batches are bounded and restart keeps backlog', () => {
  const f = fixture(),
    catalog = f.catalog;
  const base = {
    ...auditEvent('test.operation', undefined, {}, 'success', 'OK', null),
    guarantee: 'committed' as const,
  };
  catalog.db.exec('BEGIN');
  const insert = catalog.db.prepare('INSERT INTO audit_pending VALUES(?,?,?)');
  for (let n = 0; n < 10000; n++) {
    const event = { ...base, id: randomUUID() };
    insert.run(event.id, event.time, JSON.stringify(event));
  }
  catalog.db.exec('COMMIT');
  expect(() => catalog.revokeBinding(f.binding.id)).toThrow('AUDIT_QUEUE_FULL');
  expect(catalog.getBinding(f.binding.id)?.active).toBe(true);
  const restarted = f.reopen();
  expect(restarted.auditPending().pending).toBe(10000);
  expect(restarted.deliverAuditBatch()).toBe(100);
  expect(restarted.auditPending().pending).toBe(9900);
});
it('sink failure preserves committed management events, circuit bounds retries, pending export/owner recovery/readiness and read guarantees are explicit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-audit-policy-')),
    data = join(root, 'data'),
    web = join(root, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), 'synthetic');
  const app = createApplication({
    dataRoot: data,
    webRoot: web,
    ownerToken: owner,
    autoStart: false,
  });
  cleanups.push(async () => {
    await app.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = app.catalog.createProject('PRIVATE_NAME');
  app.auditDispatcher.flush();
  const reader = app.catalog.createReaderToken(project.id);
  app.auditDispatcher.flush();
  app.catalog.db.exec(
    "CREATE TRIGGER refuse_sink BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'PRIVATE_SINK_DETAIL'); END;",
  );
  const create = await app.app.inject({
    method: 'POST',
    url: '/api/projects/' + project.id + '/tokens',
    headers,
    payload: {},
  });
  expect(create.statusCode).toBe(200);
  expect(app.catalog.auditPending().pending).toBe(1);
  const pending = app.catalog.pendingAuditEvents()[0]!;
  expect(pending.actor).toEqual({ id: 'owner', role: 'owner' });
  expect(pending.requestId).toBe(create.headers['x-request-id']);
  expect(pending.guarantee).toBe('committed');
  expect(pending.target.tokenId).toBe(create.json().id);
  const pendingExport = await app.app.inject({
    url: '/api/audit/pending',
    headers,
  });
  expect(pendingExport.statusCode).toBe(200);
  expect(pendingExport.json().events[0].id).toBe(pending.id);
  for (const secret of [
    owner,
    reader.token,
    create.json().token,
    'PRIVATE_NAME',
    'PRIVATE_SINK_DETAIL',
  ])
    expect(pendingExport.body).not.toContain(secret);
  for (const url of ['/api/audit/pending', '/api/audit/retry']) {
    const response = await app.app.inject({
      method: url.endsWith('retry') ? 'POST' : 'GET',
      url,
      headers: { authorization: 'Bearer ' + reader.token },
      ...(url.endsWith('retry') ? { payload: {} } : {}),
    });
    expect(response.statusCode).toBe(403);
  }
  for (let n = 1; n <= 6; n++)
    app.auditDispatcher.flush(Date.now() + n * 60000);
  expect(app.auditDispatcher.status().suspended).toBe(true);
  expect(app.catalog.auditPending().pending).toBe(1);
  const ready = await app.app.inject({ url: '/api/readiness', headers });
  expect(ready.statusCode).toBe(503);
  expect(ready.json().audit).toEqual({
    ok: false,
    code: 'AUDIT_UNAVAILABLE',
    pending: 1,
    maxPending: 10000,
    suspended: true,
    readGap: true,
    readGapPersisted: true,
  });
  expect(ready.body).not.toContain('PRIVATE_SINK_DETAIL');
  app.catalog.db.exec('DROP TRIGGER refuse_sink');
  const recovered = await app.app.inject({
    method: 'POST',
    url: '/api/audit/retry',
    headers,
    payload: { acknowledgeReadGap: true },
  });
  expect(recovered.statusCode).toBe(200);
  expect(app.catalog.auditPending().pending).toBe(0);
  expect(
    app.catalog.auditEvents().events.filter((event) => event.id === pending.id),
  ).toHaveLength(1);
  const query = await app.app.inject({ url: '/api/projects', headers });
  expect(query.statusCode).toBe(200);
  const event = app.catalog
    .auditEvents(0, 1000)
    .events.reverse()
    .find((event) => event.action === 'project.list');
  expect(event?.guarantee).toBe('best_effort');
  expect(
    app.catalog
      .auditEvents(0, 1000)
      .events.filter((event) => event.id === pending.id)[0]?.guarantee,
  ).toBe('committed');
});
it('dispatcher drains at most100 and no hot retry loop; bounded automatic start replays existing durable intent', () => {
  const f = fixture();
  for (let n = 0; n < 205; n++) f.catalog.createProject('synthetic');
  const dispatcher = new AuditDispatcher(f.catalog);
  dispatcher.flush();
  expect(f.catalog.auditPending().pending).toBe(105);
  dispatcher.flush();
  expect(f.catalog.auditPending().pending).toBe(5);
  dispatcher.flush();
  expect(f.catalog.auditPending().pending).toBe(0);
});

it('unknown audit format rejects before control migrations or incarnation writes', () => {
  const f = fixture();
  f.catalog.db
    .prepare("UPDATE catalog_meta SET value='99' WHERE key='audit_format'")
    .run();
  f.close();
  const before = readFileSync(f.path);
  expect(() => new Catalog(f.path)).toThrow('SCHEMA_UNSUPPORTED');
  expect(readFileSync(f.path)).toEqual(before);
});
it('automatic restart recovery is bounded, backlog yields503, and subsequent healthy batches restore readiness', async () => {
  const f = fixture();
  for (let n = 0; n < 205; n++) f.catalog.createProject('synthetic');
  f.close();
  const web = join(f.root, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), 'synthetic');
  const app = createApplication({
    dataRoot: f.root,
    webRoot: web,
    ownerToken: owner,
  });
  cleanups.push(async () => {
    await app.app.close();
  });
  app.auditDispatcher.stop();
  expect(app.auditDispatcher.status().pending).toBe(105);
  const ready = await app.app.inject({ url: '/api/readiness', headers });
  expect(ready.statusCode).toBe(503);
  expect(ready.json().audit).toEqual({
    ok: false,
    code: 'AUDIT_BACKLOG',
    pending: 105,
    maxPending: 10000,
    suspended: false,
    readGap: false,
    readGapPersisted: false,
  });
  app.auditDispatcher.flush();
  const recovered = await app.app.inject({ url: '/api/readiness', headers });
  expect(recovered.statusCode).toBe(200);
  expect(recovered.json().audit).toEqual({
    ok: true,
    code: 'OK',
    pending: 0,
    maxPending: 10000,
    suspended: false,
    readGap: false,
    readGapPersisted: false,
  });
});

it('upgrades the legacy audit table without losing existing effects or best-effort records', () => {
  const f = fixture();
  const event = auditEvent(
    'token.create',
    undefined,
    { projectId: f.project.id, tokenId: f.reader.id },
    'success',
    'OK',
    null,
  );
  const legacy = { ...event };
  delete legacy.guarantee;
  f.catalog.db.exec(`DROP TABLE audit_pending; DROP TABLE audit_events;
    CREATE TABLE audit_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, event_json TEXT NOT NULL CHECK(json_valid(event_json))) STRICT;
    DELETE FROM catalog_meta WHERE key='audit_format';`);
  f.catalog.db
    .prepare('INSERT INTO audit_events(time,event_json) VALUES(?,?)')
    .run(event.time, JSON.stringify(legacy));
  const catalog = f.reopen();
  expect(catalog.getProject(f.project.id)?.id).toBe(f.project.id);
  expect(catalog.getBinding(f.binding.id)?.active).toBe(true);
  expect(catalog.auditPending().pending).toBe(0);
  const rows = catalog.auditEvents(0, 100).events;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(event.id);
  expect(rows[0]?.guarantee).toBe('best_effort');
  catalog.revokeToken(f.reader.id);
  expect(catalog.auditPending().pending).toBe(1);
  catalog.deliverAuditBatch();
  expect(catalog.auditEvents(0, 100).events).toHaveLength(2);
});

function application(f: ReturnType<typeof fixture>) {
  const app = createApplication({
    dataRoot: f.root,
    ownerToken: owner,
    autoStart: false,
  });
  cleanups.push(async () => {
    await app.app.close();
  });
  return app;
}
it('a persisted read gap survives restart until explicit healthy owner acknowledgement', async () => {
  const f = fixture();
  f.close();
  const first = application(f);
  first.catalog.db.exec(
    "CREATE TRIGGER refuse_sink BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'PRIVATE_SINK_DETAIL'); END;",
  );
  await first.app.inject({ url: '/api/projects', headers });
  first.catalog.db.exec('DROP TRIGGER refuse_sink');
  await first.app.close();
  const restarted = application(f);
  const ready = await restarted.app.inject({ url: '/api/readiness', headers });
  expect(ready.statusCode).toBe(503);
  expect(ready.json().audit.readGap).toBe(true);
  expect(ready.json().audit.readGapPersisted).toBe(true);
  const retry = await restarted.app.inject({
    method: 'POST',
    url: '/api/audit/retry',
    headers,
    payload: {},
  });
  expect(retry.statusCode).toBe(503);
  const ack = await restarted.app.inject({
    method: 'POST',
    url: '/api/audit/retry',
    headers,
    payload: { acknowledgeReadGap: true },
  });
  expect(ack.statusCode).toBe(200);
  await restarted.app.close();
  const final = application(f);
  expect(
    (await final.app.inject({ url: '/api/readiness', headers })).json().audit
      .readGap,
  ).toBe(false);
});
it('one retry request delivers at most100 including its onResponse audit', async () => {
  const f = fixture();
  for (let n = 0; n < 205; n++) f.catalog.createProject('synthetic');
  f.close();
  const app = application(f);
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/audit/retry',
    headers,
    payload: {},
  });
  expect(response.statusCode).toBe(503);
  expect(app.catalog.auditPending().pending).toBe(105);
  expect(response.json().delivered).toBe(100);
  expect(response.json().budget).toBe(100);
  expect(response.json().audit.pending).toBe(105);
  expect(app.catalog.auditPending().pending).toBe(105);
  expect(
    app.catalog
      .auditEvents(0, 1000)
      .events.filter((e) => e.action === 'audit.retry'),
  ).toHaveLength(1);
});
it('offline checks reject malformed current pending and schema, while legitimate backlog remains snapshot-ready', () => {
  const f = fixture();
  new FileStore(f.root);
  new TextIndex(f.catalog.db);
  f.catalog.createProject('pending');
  expect(inspectStorage(f.root, f.catalog.db).ready).toBe(true);
  f.catalog.db
    .prepare(
      "UPDATE audit_pending SET event_json=json_set(event_json,'$.guarantee','best_effort')",
    )
    .run();
  expect(inspectStorage(f.root, f.catalog.db).ready).toBe(false);
  f.catalog.db.exec('DELETE FROM audit_pending; DROP TABLE audit_pending');
  expect(inspectStorage(f.root, f.catalog.db).ready).toBe(false);
});
it('backup verification rejects semantically corrupt pending even after snapshot hashes are refreshed', async () => {
  const f = fixture();
  new FileStore(f.root);
  new TextIndex(f.catalog.db);
  f.catalog.createProject('pending');
  f.close();
  const parent = mkdtempSync(join(tmpdir(), 'oc-audit-backup-'));
  cleanups.push(async () => {
    rmSync(parent, { recursive: true, force: true });
  });
  const snapshot = join(parent, 'snapshot');
  await createBackup(f.root, snapshot);
  expect(verifyBackup(snapshot).complete).toBe(true);
  const db = new DatabaseSync(join(snapshot, 'control.sqlite'));
  db.exec(
    "UPDATE audit_pending SET event_json=json_set(event_json,'$.guarantee','best_effort')",
  );
  db.close();
  const manifest = JSON.parse(
    readFileSync(join(snapshot, 'manifest.json'), 'utf8'),
  );
  const file = manifest.files.find(
    (e: { path: string }) => e.path === 'control.sqlite',
  );
  const bytes = readFileSync(join(snapshot, 'control.sqlite'));
  file.bytes = bytes.length;
  file.sha256 = createHash('sha256').update(bytes).digest('hex');
  const raw = JSON.stringify(manifest) + '\n';
  writeFileSync(join(snapshot, 'manifest.json'), raw);
  writeFileSync(
    join(snapshot, 'manifest.sha256'),
    createHash('sha256').update(raw).digest('hex') + '\n',
  );
  expect(() => verifyBackup(snapshot)).toThrow('SNAPSHOT_NOT_READY');
});

it('storage failure never claims read gap persistence and failed acknowledgement remains degraded', async () => {
  const f = fixture();
  f.close();
  const app = application(f);
  app.catalog.db.exec(
    "CREATE TRIGGER refuse_sink BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'PRIVATE_SINK_DETAIL'); END; CREATE TRIGGER refuse_gap BEFORE INSERT ON catalog_meta WHEN NEW.key='audit_read_gap' BEGIN SELECT RAISE(ABORT,'PRIVATE_GAP_DETAIL'); END;",
  );
  await app.app.inject({ url: '/api/projects', headers });
  const unpersisted = await app.app.inject({ url: '/api/readiness', headers });
  expect(unpersisted.statusCode).toBe(503);
  expect(unpersisted.json().audit.readGap).toBe(true);
  expect(unpersisted.json().audit.readGapPersisted).toBe(false);
  expect(unpersisted.body).not.toContain('PRIVATE_GAP_DETAIL');
  expect(app.catalog.auditReadGap()).toBe(false);
  app.catalog.db.exec('DROP TRIGGER refuse_gap');
  await app.app.inject({ url: '/api/projects', headers });
  expect(app.catalog.auditReadGap()).toBe(true);
  app.catalog.db.exec(
    "DROP TRIGGER refuse_sink; CREATE TRIGGER refuse_ack BEFORE DELETE ON catalog_meta WHEN OLD.key='audit_read_gap' BEGIN SELECT RAISE(ABORT,'PRIVATE_ACK_DETAIL'); END;",
  );
  const ack = await app.app.inject({
    method: 'POST',
    url: '/api/audit/retry',
    headers,
    payload: { acknowledgeReadGap: true },
  });
  expect(ack.statusCode).toBe(503);
  expect(ack.json().audit.readGap).toBe(true);
  expect(app.catalog.auditReadGap()).toBe(true);
  expect(ack.body).not.toContain('PRIVATE_ACK_DETAIL');
  app.catalog.db.exec('DROP TRIGGER refuse_ack');
  expect(
    (
      await app.app.inject({
        method: 'POST',
        url: '/api/audit/retry',
        headers,
        payload: { acknowledgeReadGap: true },
      })
    ).statusCode,
  ).toBe(200);
});
it('offline schema validation rejects missing unique index and startup refuses damaged current format before writes', () => {
  const f = fixture();
  new FileStore(f.root);
  new TextIndex(f.catalog.db);
  f.catalog.db.exec('DROP INDEX audit_event_id');
  expect(inspectStorage(f.root, f.catalog.db).checks.migration.ok).toBe(false);
  f.close();
  const before = readFileSync(f.path);
  expect(() => new Catalog(f.path)).toThrow('SCHEMA_UNSUPPORTED');
  expect(readFileSync(f.path)).toEqual(before);
});
it('offline validation accepts reviewed legacy ledger and preserves a valid persisted gap in snapshots', async () => {
  const f = fixture();
  new FileStore(f.root);
  new TextIndex(f.catalog.db);
  f.catalog.db.exec(
    "DROP TABLE audit_pending; ALTER TABLE audit_events DROP COLUMN delivered_at; DROP INDEX audit_event_id; DELETE FROM catalog_meta WHERE key='audit_format';",
  );
  expect(inspectStorage(f.root, f.catalog.db).ready).toBe(true);
  const db = f.reopen();
  db.setAuditReadGap(true);
  f.close();
  const parent = mkdtempSync(join(tmpdir(), 'oc-gap-snapshot-'));
  cleanups.push(async () => {
    rmSync(parent, { recursive: true, force: true });
  });
  const snapshot = join(parent, 'snapshot');
  await createBackup(f.root, snapshot);
  expect(verifyBackup(snapshot).complete).toBe(true);
  const copy = new DatabaseSync(join(snapshot, 'control.sqlite'), {
    readOnly: true,
  });
  try {
    expect(
      copy
        .prepare("SELECT value FROM catalog_meta WHERE key='audit_read_gap'")
        .get()?.value,
    ).toBe('1');
  } finally {
    copy.close();
  }
  const restored = join(parent, 'restored');
  restoreBackup(snapshot, restored);
  const app = createApplication({
    dataRoot: restored,
    ownerToken: owner,
    autoStart: false,
  });
  cleanups.push(async () => {
    await app.app.close();
  });
  const ready = await app.app.inject({ url: '/api/readiness', headers });
  expect(ready.statusCode).toBe(503);
  expect(ready.json().audit.readGapPersisted).toBe(true);
  expect(
    (
      await app.app.inject({
        method: 'POST',
        url: '/api/audit/retry',
        headers,
        payload: { acknowledgeReadGap: true },
      })
    ).statusCode,
  ).toBe(200);
});
