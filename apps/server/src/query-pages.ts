import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Id, type FileEntry } from '@opencontext/contracts';
import {
  type FilePage,
  type FilePageInput,
} from '@opencontext/contracts/query-api';
const cursorSchema = Type.Object(
  {
    version: Type.Literal(1),
    projectId: Id,
    head: Type.Union([Id, Type.Null()]),
    fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    offset: Type.Integer({ minimum: 0, maximum: 20000 }),
  },
  { additionalProperties: false },
);
/** Read positions are not authorization. Always paginate a freshly authorized tree. */
export function pageFiles(
  projectId: string,
  head: string | null,
  files: FileEntry[],
  input: FilePageInput,
): FilePage {
  const ordered = [...files].sort(
    (a, b) =>
      a.logicalPath.localeCompare(b.logicalPath) ||
      a.fileId.localeCompare(b.fileId),
  );
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(ordered))
    .digest('hex');
  let offset = 0;
  if (input.cursor) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        Buffer.from(input.cursor, 'base64url').toString('utf8'),
      );
    } catch {
      throw new Error('INVALID_CURSOR');
    }
    if (
      !Value.Check(cursorSchema, decoded) ||
      Buffer.from(JSON.stringify(decoded)).toString('base64url') !==
        input.cursor
    )
      throw new Error('INVALID_CURSOR');
    if (decoded.projectId !== projectId) throw new Error('INVALID_CURSOR');
    if (decoded.head !== head || decoded.fingerprint !== fingerprint)
      throw new Error('CURSOR_STALE');
    if (decoded.offset > ordered.length) throw new Error('INVALID_CURSOR');
    offset = decoded.offset;
  }
  const limit = input.limit ?? 100,
    page = ordered.slice(offset, offset + limit),
    next = offset + page.length;
  return {
    servedCommit: head,
    files: page,
    nextCursor:
      next < ordered.length
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              projectId,
              head,
              fingerprint,
              offset: next,
            }),
          ).toString('base64url')
        : null,
  };
}
