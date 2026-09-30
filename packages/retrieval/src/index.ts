import type { DatabaseSync } from 'node:sqlite';
import type {
  FileEntry,
  IndexCandidate,
  IndexDocument,
  RetrievalPort,
  SearchHit,
  SearchInput,
  SearchResult,
} from '@opencontext/contracts';

/** Host-owned SQLite adapter; feature plugins never receive this database. */
export class TextIndex {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(
        project_id UNINDEXED, file_id UNINDEXED, revision_id UNINDEXED,
        body, tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS retrieval_generations (
        project_id TEXT PRIMARY KEY,
        commit_id TEXT NOT NULL
      ) STRICT;
    `);
  }

  /** Call outside a transaction. Content and coverage advance together. */
  replaceProject(
    projectId: string,
    commitId: string,
    docs: IndexDocument[],
  ): void {
    if (!projectId || !commitId) throw new Error('INVALID_INDEX_SNAPSHOT');
    const ids = new Set<string>();
    for (const { file } of docs) {
      if (file.projectId !== projectId || ids.has(file.fileId)) {
        throw new Error('INVALID_INDEX_DOCUMENT');
      }
      ids.add(file.fileId);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('DELETE FROM retrieval_fts WHERE project_id = ?')
        .run(projectId);
      const insert = this.db.prepare(
        'INSERT INTO retrieval_fts(project_id, file_id, revision_id, body) VALUES (?, ?, ?, ?)',
      );
      for (const { file, text } of docs) {
        if (!file.tombstone && file.freshness !== 'invalid') {
          insert.run(projectId, file.fileId, file.revisionId, text);
        }
      }
      this.db
        .prepare(
          `
        INSERT INTO retrieval_generations(project_id, commit_id) VALUES (?, ?)
        ON CONFLICT(project_id) DO UPDATE SET commit_id = excluded.commit_id
      `,
        )
        .run(projectId, commitId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  candidates(
    projectId: string,
    query: string,
    limit: number,
  ): IndexCandidate[] {
    // Only literal Unicode letter/number tokens reach MATCH. Operators, quotes
    // and SQL punctuation are never treated as a query language.
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
    if (!tokens.length) return [];
    const match = tokens.map((token) => '"' + token + '"').join(' OR ');
    const bounded = Math.min(500, Math.max(1, Math.floor(limit) || 1));
    const rows = this.db
      .prepare(
        `
      SELECT file_id, revision_id, body
      FROM retrieval_fts WHERE retrieval_fts MATCH ? AND project_id = ?
      ORDER BY file_id LIMIT ?
    `,
      )
      .all(match, projectId, 500);
    // Global FTS5 bm25 uses statistics from every project, even with a WHERE
    // project filter. Rank this bounded candidate window using only each
    // document's token coverage/frequency, so another project cannot influence
    // returned scores/order. This small slice does not claim BM25 quality.
    const normalize = (value: string) =>
      value.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const wanted = new Set(tokens.map(normalize));
    return rows
      .map((row) => {
        const words =
          normalize(String(row.body)).match(/[\p{L}\p{N}_]+/gu) ?? [];
        const matched = words.filter((word) => wanted.has(word));
        return {
          fileId: String(row.file_id),
          revisionId: String(row.revision_id),
          score: new Set(matched).size + matched.length / (words.length + 1),
          excerpt: '', // Never return unchecked index text to the caller.
        };
      })
      .sort((a, b) => b.score - a.score || a.fileId.localeCompare(b.fileId))
      .slice(0, bounded);
  }

  isReady(projectId: string, commitId: string): boolean {
    const generation = this.db
      .prepare(
        'SELECT commit_id FROM retrieval_generations WHERE project_id = ?',
      )
      .get(projectId);
    return generation?.commit_id === commitId;
  }
}

export const MAX_EXCERPT_CHARACTERS = 4096;
const PER_HIT_CHARACTERS = 512;

function admitted(
  file: FileEntry,
  projectId: string,
  includeStale: boolean,
): boolean {
  return (
    file.projectId === projectId &&
    !file.tombstone &&
    file.freshness !== 'invalid' &&
    (includeStale || file.freshness === 'fresh')
  );
}

function excerpt(text: string, query: string, remaining: number): string {
  const match = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  let start = Math.max(0, match - 80);
  // Bound UTF-16 units without returning an isolated surrogate to MCP/JSON.
  const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
  if (
    start > 0 &&
    low(text.charCodeAt(start)) &&
    high(text.charCodeAt(start - 1))
  )
    start--;
  let end = Math.min(
    text.length,
    start + Math.min(PER_HIT_CHARACTERS, remaining),
  );
  if (
    end > start &&
    high(text.charCodeAt(end - 1)) &&
    low(text.charCodeAt(end))
  )
    end--;
  return text.slice(start, end);
}

/** All port methods must be bound to the current principal by the host. */
export function search(
  port: RetrievalPort,
  projectId: string,
  input: SearchInput,
): SearchResult {
  const query = input.query.trim();
  if (!projectId || !query || query.length > 300)
    throw new Error('INVALID_SEARCH');
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10) || 10));
  const servedCommit = port.head(projectId);
  const files = port.listFiles(projectId);
  const ready = port.indexReady(projectId);
  const includeStale = input.freshness === 'include_stale';
  const current = new Map(files.map((file) => [file.fileId, file]));
  let mode: 'fts' | 'grep' = input.mode === 'grep' || !ready ? 'grep' : 'fts';
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  let remaining = MAX_EXCERPT_CHARACTERS;

  function add(file: FileEntry, score: number, requireLiteral: boolean): void {
    if (
      hits.length >= limit ||
      remaining <= 0 ||
      seen.has(file.fileId) ||
      !admitted(file, projectId, includeStale)
    )
      return;
    // A denied read is not converted into a hidden hit or fallback. The current
    // principal is checked again by this port, including after indexing.
    const read = port.read(projectId, file.fileId, file.revisionId);
    if (!admitted(read.file, projectId, includeStale)) return;
    if (
      read.file.fileId !== file.fileId ||
      read.file.revisionId !== file.revisionId ||
      read.citation.fileId !== file.fileId ||
      read.citation.revisionId !== file.revisionId ||
      read.citation.projectId !== projectId ||
      read.citation.contentHash !== file.contentHash ||
      read.citation.commitId !== servedCommit
    )
      throw new Error('SNAPSHOT_CHANGED');
    if (
      requireLiteral &&
      !read.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    )
      return;
    const snippet = excerpt(read.text, query, remaining);
    remaining -= snippet.length;
    seen.add(file.fileId);
    hits.push({
      file: read.file,
      excerpt: snippet,
      citation: read.citation,
      score,
    });
  }

  if (servedCommit && mode === 'fts') {
    for (const candidate of port.candidates(
      projectId,
      query,
      Math.min(500, limit * 10),
    )) {
      const file = current.get(candidate.fileId);
      if (file && file.revisionId === candidate.revisionId)
        add(file, candidate.score, false);
    }
    // unicode61 is not a Chinese segmenter. Literal grep also covers absent or
    // stale candidates, but still applies exactly the same authorization gates.
    if (!hits.length) mode = 'grep';
  }
  if (servedCommit && mode === 'grep') {
    for (const file of files) add(file, 1, true);
  }
  if (port.head(projectId) !== servedCommit)
    throw new Error('SNAPSHOT_CHANGED');
  return {
    servedCommit,
    hits,
    indexCoverage: ready ? 'ready' : 'partial',
    degraded: input.mode !== 'grep' && mode === 'grep',
    mode,
  };
}
