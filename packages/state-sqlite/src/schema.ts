import { DatabaseSync } from 'node:sqlite';
export const CATALOG_SCHEMA = `
      CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, delivered_at TEXT,
        event_json TEXT NOT NULL CHECK(json_valid(event_json))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_time ON audit_events(time);
      CREATE UNIQUE INDEX IF NOT EXISTS audit_event_id ON audit_events(json_extract(event_json,'$.id'));
      CREATE TABLE IF NOT EXISTS audit_pending (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK(json_valid(event_json) AND length(event_json)<=2048)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
        head TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bindings (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, instance_ref TEXT NOT NULL UNIQUE,
        package_ref TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)),
        connector_json TEXT CHECK(connector_json IS NULL OR json_valid(connector_json)),
        processor_json TEXT CHECK(processor_json IS NULL OR json_valid(processor_json)),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        source_version TEXT, last_error TEXT, UNIQUE(project_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, binding_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('sync','process')),
        state TEXT NOT NULL CHECK(state IN ('queued','running','published','failed','superseded')),
        fence TEXT NOT NULL DEFAULT '0' CHECK(length(fence)>0 AND fence NOT GLOB '*[^0-9]*'),
        incarnation TEXT NOT NULL, lease_until INTEGER,
        input_commit TEXT, result_commit TEXT, error TEXT, created_at TEXT NOT NULL,
        skipped_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(skipped_json)),
        execution_json TEXT CHECK(execution_json IS NULL OR json_valid(execution_json)),
        FOREIGN KEY(project_id,binding_id) REFERENCES bindings(project_id,id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run
        ON runs(binding_id,kind) WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS commits (
        project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
        parent_id TEXT, manifest_hash TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        created_at TEXT NOT NULL, PRIMARY KEY(project_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revisions (
        project_id TEXT NOT NULL, file_id TEXT NOT NULL, revision_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
        first_commit TEXT NOT NULL, PRIMARY KEY(project_id,file_id,revision_id),
        FOREIGN KEY(project_id,first_commit) REFERENCES commits(project_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS current_files (
        project_id TEXT NOT NULL, file_id TEXT NOT NULL, revision_id TEXT NOT NULL,
        binding_id TEXT NOT NULL, logical_path TEXT NOT NULL,
        tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)),
        entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
        PRIMARY KEY(project_id,file_id),
        FOREIGN KEY(project_id,binding_id) REFERENCES bindings(project_id,id),
        FOREIGN KEY(project_id,file_id,revision_id) REFERENCES revisions(project_id,file_id,revision_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_path
        ON current_files(project_id,logical_path) WHERE tombstone=0;
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
        commit_id TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
        UNIQUE(project_id,commit_id),
        FOREIGN KEY(project_id,commit_id) REFERENCES commits(project_id,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reader_tokens (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS binding_imports (
        binding_id TEXT NOT NULL REFERENCES bindings(id), id TEXT NOT NULL,
        filename TEXT NOT NULL, content_hash TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes>=0),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        PRIMARY KEY(binding_id,id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_current_import_filename
        ON binding_imports(binding_id,filename) WHERE active=1;
      CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(
        project_id UNINDEXED, file_id UNINDEXED, revision_id UNINDEXED,
        body, tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS retrieval_generations (
        project_id TEXT PRIMARY KEY, commit_id TEXT NOT NULL
      ) STRICT;
`;
/** Compare structural constraints against a fresh schema, without repairing existing data. */
export function validateCatalogSchema(db: DatabaseSync): void {
  const expected = new DatabaseSync(':memory:');
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  try {
    expected.exec(CATALOG_SCHEMA);
    for (const row of expected
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()) {
      const table = String(row.name);
      const actual = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)?.sql;
      if (
        typeof actual !== 'string' ||
        (table.startsWith('retrieval_fts')
          ? norm(actual) !== norm(String(row.sql))
          : !norm(actual).endsWith('strict'))
      )
        throw new Error('SCHEMA_INCOMPLETE');
      for (const pragma of ['table_info', 'foreign_key_list']) {
        if (
          JSON.stringify(db.prepare(`PRAGMA ${pragma}(${table})`).all()) !==
          JSON.stringify(expected.prepare(`PRAGMA ${pragma}(${table})`).all())
        )
          throw new Error('SCHEMA_INCOMPLETE');
      }
      // CHECK expressions contain nested parentheses; retain the entire balanced expression.
      const sql = norm(String(row.sql)),
        found = norm(actual);
      let start = 0;
      while ((start = sql.indexOf('check(', start)) !== -1) {
        let end = start + 6,
          depth = 1;
        for (; end < sql.length && depth; end++) {
          if (sql[end] === '(') depth++;
          if (sql[end] === ')') depth--;
        }
        if (!found.includes(sql.slice(start, end)))
          throw new Error('SCHEMA_INCOMPLETE');
        start = end;
      }
      const indexes = (conn: DatabaseSync) =>
        conn
          .prepare(`PRAGMA index_list(${table})`)
          .all()
          .map((i) => ({
            unique: i.unique,
            origin: i.origin,
            partial: i.partial,
            columns: conn
              .prepare(`PRAGMA index_xinfo(${String(i.name)})`)
              .all(),
            predicate: i.partial
              ? norm(
                  String(
                    conn
                      .prepare('SELECT sql FROM sqlite_master WHERE name=?')
                      .get(i.name!)?.sql,
                  ),
                ).split('where')[1]
              : null,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (JSON.stringify(indexes(db)) !== JSON.stringify(indexes(expected)))
        throw new Error('SCHEMA_INCOMPLETE');
    }
    for (const [key, allowed] of [
      ['storage_version', ['2']],
      ['audit_format', ['2']],
      ['deployment_mode', ['demo', 'private']],
    ] as const) {
      const value = db
        .prepare('SELECT value FROM catalog_meta WHERE key=?')
        .get(key)?.value;
      if (!allowed.includes(value as never))
        throw new Error('SCHEMA_INCOMPLETE');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'SCHEMA_INCOMPLETE')
      throw error;
    throw new Error('SCHEMA_INCOMPLETE', { cause: error });
  } finally {
    expected.close();
  }
}
