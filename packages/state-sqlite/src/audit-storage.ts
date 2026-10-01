import { parseAuditEvent } from '@opencontext/contracts/audit';
import type { DatabaseSync } from 'node:sqlite';
/** Read-only validation. Valid backlog/gap is recoverable state, not online health. */
export function validateAuditStorage(db: DatabaseSync): void {
  const format = db
    .prepare("SELECT value FROM catalog_meta WHERE key='audit_format'")
    .get()?.value;
  if (format !== undefined && format !== '2')
    throw new Error('SCHEMA_UNSUPPORTED');
  const gap = db
    .prepare("SELECT value FROM catalog_meta WHERE key='audit_read_gap'")
    .get()?.value;
  if (gap !== undefined && gap !== '1') throw new Error('SCHEMA_UNSUPPORTED');
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  // Pre-audit databases and the reviewed955 ledger are legitimate migration inputs.
  if (format === undefined && tables.has('audit_pending'))
    throw new Error('SCHEMA_UNSUPPORTED');
  if (
    format === '2' &&
    (!tables.has('audit_events') || !tables.has('audit_pending'))
  )
    throw new Error('SCHEMA_UNSUPPORTED');
  const columns = (table: string, names: string[]) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    if (names.some((name) => !rows.some((row) => row.name === name)))
      throw new Error('SCHEMA_UNSUPPORTED');
  };
  if (tables.has('audit_events')) {
    columns('audit_events', [
      'sequence',
      'time',
      'event_json',
      ...(format === '2' ? ['delivered_at'] : []),
    ]);
    if (format === '2') {
      const index = db
        .prepare('PRAGMA index_list(audit_events)')
        .all()
        .find((row) => row.name === 'audit_event_id');
      const sql = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='audit_event_id'",
        )
        .get()?.sql;
      if (
        index?.unique !== 1 ||
        typeof sql !== 'string' ||
        !sql
          .replace(/\s/g, '')
          .includes("ONaudit_events(json_extract(event_json,'$.id'))")
      )
        throw new Error('SCHEMA_UNSUPPORTED');
    }
  }
  if (format === '2')
    columns('audit_pending', ['id', 'created_at', 'event_json']);
  for (const [table, name, type] of [
    ...(tables.has('audit_events')
      ? [['audit_events', 'sequence', 'INTEGER']]
      : []),
    ...(format === '2' ? [['audit_pending', 'id', 'TEXT']] : []),
  ]) {
    const column = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .find((row) => row.name === name);
    if (column?.pk !== 1 || column.type !== type)
      throw new Error('SCHEMA_UNSUPPORTED');
  }
  const ledger = new Map<string, string>();
  if (tables.has('audit_events')) {
    const rows = db
      .prepare(
        'SELECT sequence,time,event_json' +
          (format === '2' ? ',delivered_at' : '') +
          ' FROM audit_events LIMIT 10001',
      )
      .all();
    if (rows.length > 10000) throw new Error('SCHEMA_UNSUPPORTED');
    for (const row of rows) {
      const event = parseAuditEvent(JSON.parse(String(row.event_json)));
      if (
        !Number.isSafeInteger(row.sequence) ||
        Number(row.sequence) < 1 ||
        row.time !== event.time ||
        ledger.has(event.id) ||
        Number.isNaN(Date.parse(event.time)) ||
        (row.delivered_at != null &&
          Number.isNaN(Date.parse(String(row.delivered_at))))
      )
        throw new Error('SCHEMA_UNSUPPORTED');
      ledger.set(event.id, JSON.stringify(event));
    }
  }
  if (format === '2') {
    const rows = db
      .prepare('SELECT id,created_at,event_json FROM audit_pending LIMIT 10001')
      .all();
    if (rows.length > 10000) throw new Error('SCHEMA_UNSUPPORTED');
    const ids = new Set<string>();
    for (const row of rows) {
      const json = String(row.event_json),
        event = parseAuditEvent(JSON.parse(json));
      if (
        json.length > 2048 ||
        row.id !== event.id ||
        row.created_at !== event.time ||
        Number.isNaN(Date.parse(event.time)) ||
        event.guarantee !== 'committed' ||
        ids.has(event.id) ||
        (ledger.has(event.id) && ledger.get(event.id) !== JSON.stringify(event))
      )
        throw new Error('SCHEMA_UNSUPPORTED');
      ids.add(event.id);
    }
  }
}
