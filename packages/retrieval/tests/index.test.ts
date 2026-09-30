import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  FileEntry,
  IndexDocument,
  RetrievalPort,
} from '@opencontext/contracts';
import { MAX_EXCERPT_CHARACTERS, search, TextIndex } from '../src/index.ts';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function document(
  id: string,
  text: string,
  overrides: Partial<FileEntry> = {},
): IndexDocument {
  return {
    file: {
      fileId: id,
      revisionId: 'r-' + id,
      contentHash: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
      projectId: 'p1',
      bindingId: 'b1',
      slotKey: id,
      logicalPath: 'sources/repo/' + id + '.md',
      collection: 'sources',
      ownership: 'source_managed',
      freshness: 'fresh',
      tombstone: false,
      sourceVersion: 'git-sha',
      createdAt: '2026-09-30T00:00:00Z',
      derivedFrom: [],
      ...overrides,
    },
    text,
  };
}

function fixture(docs: IndexDocument[]) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const index = new TextIndex(db);
  let current = docs;
  let head = 'c1';
  let allowed = true;
  index.replaceProject('p1', head, docs);
  function gate(projectId: string) {
    if (!allowed || projectId !== 'p1') throw new Error('ACCESS_DENIED');
  }
  const port: RetrievalPort = {
    head: (id) => {
      gate(id);
      return head;
    },
    listFiles: (id) => {
      gate(id);
      return current.map(({ file }) => file);
    },
    indexReady: (id) => {
      gate(id);
      return index.isReady(id, head);
    },
    candidates: (id, query, limit) => {
      gate(id);
      return index.candidates(id, query, limit);
    },
    read: (id, fileId, revisionId) => {
      gate(id);
      const doc = current.find(
        ({ file }) => file.fileId === fileId && file.revisionId === revisionId,
      );
      if (!doc) throw new Error('NOT_FOUND');
      return {
        file: doc.file,
        text: doc.text,
        citation: {
          uri: `oc://project/${id}/file/${fileId}@${revisionId}`,
          projectId: id,
          fileId,
          revisionId,
          commitId: head,
          path: doc.file.logicalPath,
          contentHash: doc.file.contentHash,
          sourceVersion: doc.file.sourceVersion,
        },
      };
    },
  };
  return {
    db,
    index,
    port,
    setCurrent: (next: IndexDocument[], commit = 'c2') => {
      current = next;
      head = commit;
    },
    revoke: () => {
      allowed = false;
    },
  };
}

describe('SQLite text index and gated snapshot retrieval', () => {
  it('keeps candidate scores and order independent of another project corpus', () => {
    const f = fixture([
      document('a', 'leftsignal'),
      document('b', 'rightsignal'),
    ]);
    const before = f.index.candidates('p1', 'leftsignal rightsignal', 20);
    f.index.replaceProject(
      'p2',
      'c2',
      Array.from({ length: 20 }, (_, i) =>
        document('private-' + i, 'leftsignal '.repeat(50), { projectId: 'p2' }),
      ),
    );
    expect(f.index.candidates('p1', 'leftsignal rightsignal', 20)).toEqual(
      before,
    );
  });
  it('keeps excerpt start/end Unicode boundaries intact under the shared budget', () => {
    const f = fixture([document('emoji', 'EMOJIQUERY ' + '😀'.repeat(800))]);
    const result = search(f.port, 'p1', { query: 'EMOJIQUERY', mode: 'grep' });
    expect(Buffer.from(result.hits[0]!.excerpt).toString('utf8')).toBe(
      result.hits[0]!.excerpt,
    );
    expect(result.hits[0]!.excerpt.length).toBeLessThanOrEqual(512);
  });
  it('keeps generation and searchable text across a database restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'opencontext-index-'));
    const filename = join(directory, 'state.sqlite');
    let db = new DatabaseSync(filename);
    try {
      new TextIndex(db).replaceProject('p1', 'c1', [
        document('persisted', 'durable context'),
      ]);
      db.close();
      db = new DatabaseSync(filename);
      const reopened = new TextIndex(db);
      expect(reopened.isReady('p1', 'c1')).toBe(true);
      expect(reopened.candidates('p1', 'durable', 1)[0]?.fileId).toBe(
        'persisted',
      );
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('atomically replaces added/changed/deleted entries and updates exact coverage', () => {
    const f = fixture([
      document('old', 'old phrase'),
      document('same', 'before'),
    ]);
    const next = [
      document('new', 'new phrase'),
      document('same', 'after', { revisionId: 'r2' }),
    ];
    f.index.replaceProject('p1', 'c2', next);
    expect(f.index.isReady('p1', 'c1')).toBe(false);
    expect(f.index.isReady('p1', 'c2')).toBe(true);
    expect(f.index.candidates('p1', 'old', 10)).toEqual([]);
    expect(f.index.candidates('p1', 'before', 10)).toEqual([]);
    expect(f.index.candidates('p1', 'after', 10)[0]?.revisionId).toBe('r2');
    expect(() =>
      f.index.replaceProject('p1', 'c3', [next[0]!, next[0]!]),
    ).toThrow('INVALID_INDEX_DOCUMENT');
    expect(f.index.isReady('p1', 'c2')).toBe(true);
  });

  it('rolls back content and generation together on a write failure', () => {
    const f = fixture([document('old', 'original')]);
    f.db
      .exec(`CREATE TRIGGER reject_generation BEFORE UPDATE ON retrieval_generations
      BEGIN SELECT RAISE(ABORT, 'injected_failure'); END`);
    expect(() =>
      f.index.replaceProject('p1', 'c2', [document('new', 'changed')]),
    ).toThrow('injected_failure');
    expect(f.index.isReady('p1', 'c1')).toBe(true);
    expect(f.index.candidates('p1', 'original', 10)).toHaveLength(1);
    expect(f.index.candidates('p1', 'changed', 10)).toHaveLength(0);
  });

  it('treats MATCH metacharacters as literal tokens and isolates project candidates', () => {
    const f = fixture([document('a', 'hello world')]);
    f.index.replaceProject('p2', 'other', [
      document('secret', 'hello secret', { projectId: 'p2' }),
    ]);
    expect(() =>
      f.index.candidates('p1', 'hello" OR (NEAR* : -)', 20),
    ).not.toThrow();
    expect(
      f.index.candidates('p1', '"hello"', 20).map((r) => r.fileId),
    ).toEqual(['a']);
    expect(f.index.candidates('p1', 'secret', 20)).toEqual([]);
    expect(f.index.candidates('p1', '*** "" :', 20)).toEqual([]);
  });

  it('returns source and derived hits with fixed revisions and verified content hashes', () => {
    const docs = [
      document('source', 'shared context'),
      document('wiki', 'shared context summary', {
        collection: 'derived',
        ownership: 'generated',
      }),
    ];
    const f = fixture(docs);
    const result = search(f.port, 'p1', { query: 'context' });
    expect(result.hits.map((hit) => hit.file.collection).sort()).toEqual([
      'derived',
      'sources',
    ]);
    for (const hit of result.hits) {
      expect(hit.citation.commitId).toBe('c1');
      expect(hit.citation.revisionId).toBe(hit.file.revisionId);
      expect(hit.citation.contentHash).toBe(hit.file.contentHash);
    }
  });

  it('excludes tombstones and invalid data even with stale policy and grep fallback', () => {
    const f = fixture([
      document('live', 'context'),
      document('stale', 'context', { freshness: 'stale' }),
      document('invalid', 'context', { freshness: 'invalid' }),
      document('deleted', 'context', { tombstone: true }),
    ]);
    expect(
      search(f.port, 'p1', { query: 'context' }).hits.map((h) => h.file.fileId),
    ).toEqual(['live']);
    expect(
      search(f.port, 'p1', {
        query: 'context',
        mode: 'grep',
        freshness: 'include_stale',
      }).hits.map((h) => h.file.fileId),
    ).toEqual(['live', 'stale']);
  });

  it('rejects stale index revisions and finds current Chinese substrings by grep', () => {
    const f = fixture([document('a', 'old keyword')]);
    f.setCurrent([document('a', '增量上下文检索', { revisionId: 'r2' })]);
    const result = search(f.port, 'p1', { query: '上下文' });
    expect(result).toMatchObject({
      mode: 'grep',
      degraded: true,
      indexCoverage: 'partial',
      servedCommit: 'c2',
    });
    expect(result.hits[0]?.citation.revisionId).toBe('r2');
    expect(search(f.port, 'p1', { query: 'old' }).hits).toEqual([]);
    f.index.replaceProject('p1', 'c2', [
      document('a', '增量上下文检索', { revisionId: 'r2' }),
    ]);
    expect(search(f.port, 'p1', { query: '上下文' })).toMatchObject({
      mode: 'grep',
      degraded: true,
      indexCoverage: 'ready',
    });
  });

  it('drops candidates not matching the current manifest even when the index claims ready', () => {
    const f = fixture([document('a', 'old secret')]);
    f.setCurrent([document('a', 'replacement', { revisionId: 'r2' })], 'c1');
    expect(search(f.port, 'p1', { query: 'secret' }).hits).toEqual([]);
  });

  it('checks authorization at each read and never turns denial into degraded content', () => {
    const f = fixture([document('a', 'context')]);
    const originalCandidates = f.port.candidates;
    f.port.candidates = (...args) => {
      const found = originalCandidates(...args);
      f.revoke();
      return found;
    };
    expect(() => search(f.port, 'p1', { query: 'context' })).toThrow(
      'ACCESS_DENIED',
    );
    expect(() => search(f.port, 'other', { query: 'context' })).toThrow(
      'ACCESS_DENIED',
    );
  });

  it('bounds excerpt output and hit count without trusting requested limits', () => {
    const f = fixture(
      Array.from({ length: 60 }, (_, i) =>
        document('doc' + i, 'context '.repeat(200)),
      ),
    );
    const result = search(f.port, 'p1', { query: 'context', limit: 10000 });
    expect(result.hits.length).toBeLessThanOrEqual(50);
    expect(
      result.hits.reduce((sum, hit) => sum + hit.excerpt.length, 0),
    ).toBeLessThanOrEqual(MAX_EXCERPT_CHARACTERS);
    expect(
      search(f.port, 'p1', { query: 'context', limit: 1 }).hits,
    ).toHaveLength(1);
  });

  it('fails rather than mixing a head change into a fixed citation response', () => {
    const f = fixture([document('a', 'context')]);
    const originalRead = f.port.read;
    f.port.read = (...args) => {
      const read = originalRead(...args);
      f.setCurrent([document('a', 'next')]);
      return read;
    };
    expect(() => search(f.port, 'p1', { query: 'context' })).toThrow(
      'SNAPSHOT_CHANGED',
    );
  });
});
