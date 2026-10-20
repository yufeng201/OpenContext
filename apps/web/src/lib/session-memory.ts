import type { Static } from '@sinclair/typebox';
import type {
  SessionMemoryStatus,
  SessionMemoryReviewSchema,
} from '@opencontext/contracts';
import { ApiError } from '../api/client';
import { markdownBlocks } from './markdown';
import type { TSchema } from '@sinclair/typebox';
import type Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
let engine: Promise<Ajv> | undefined;
const validators = new WeakMap<object, ValidateFunction>();
// Reuse authoritative TypeBox JSON Schema with the existing browser Ajv stack.
export async function validateResponse<S extends TSchema>(
  schema: S,
  value: unknown,
): Promise<Static<S>> {
  let validate = validators.get(schema);
  if (!validate) {
    engine ??= import('ajv').then(
      ({ default: Ajv }) => new Ajv({ strict: true }),
    );
    const ajv = await engine;
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  if (!validate(value)) throw new ApiError(502, 'INVALID_RESPONSE');
  return value as Static<S>;
}
export const statusLabel = (status: SessionMemoryStatus['status']) =>
  ({
    disabled: '未启用',
    idle: '等待来源',
    pending: '等待候选',
    review: '待人工审核',
    failed: '处理失败',
    cancelled: '已取消',
    publishing: '正在发布',
    published: '已发布',
  })[status];
export function reviewMatches(
  state: SessionMemoryStatus,
  review: Static<typeof SessionMemoryReviewSchema> | undefined,
) {
  return (
    state.status === 'review' &&
    !!review &&
    state.taskId === review.taskId &&
    state.reviewHash === review.reviewHash
  );
}
// Links are extracted only as inert fixed-version references. Never follow source URLs.
export function fixedReviewLinks(markdown: string, projectId: string) {
  const result = new Map<
    string,
    { href: string; fileId: string; revisionId: string }
  >();
  const provenance = markdownBlocks(markdown)
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('\n');
  for (const match of provenance.matchAll(
    /oc:\/\/space\/([^\s/)]+)\/file\/([^\s@)]+)@([^\s)]+)/g,
  )) {
    try {
      const project = decodeURIComponent(match[1]!);
      const fileId = decodeURIComponent(match[2]!);
      const revisionId = decodeURIComponent(match[3]!.split('#')[0]!);
      if (
        project !== projectId ||
        ![project, fileId, revisionId].every((id) =>
          /^[A-Za-z0-9_-]{1,200}$/.test(id),
        )
      )
        continue;
      const href =
        '/?' +
        new URLSearchParams({
          project,
          view: 'files',
          file: fileId,
          revision: revisionId,
        });
      result.set(href, { href, fileId, revisionId });
    } catch {
      /* Malformed references remain inert text. */
    }
  }
  return [...result.values()];
}
