import { expect, it } from 'vitest';
import {
  SessionMemoryReviewSchema,
  SessionMemoryStatusSchema,
} from '@opencontext/contracts';
import {
  fixedReviewLinks,
  reviewMatches,
  validateResponse,
} from '../src/lib/session-memory';
it('requires the exact review task/hash and an actual review state', () => {
  const status = {
    enabled: true,
    active: false,
    status: 'review' as const,
    taskId: 'a',
    reviewHash: 'a'.repeat(64),
  };
  const review = {
    taskId: 'a',
    reviewHash: 'a'.repeat(64),
    markdown: 'synthetic',
  };
  expect(reviewMatches(status, review)).toBe(true);
  expect(reviewMatches({ ...status, reviewHash: 'b'.repeat(64) }, review)).toBe(
    false,
  );
  expect(reviewMatches({ ...status, taskId: 'b' }, review)).toBe(false);
  expect(reviewMatches({ ...status, status: 'cancelled' }, review)).toBe(false);
  expect(reviewMatches(status, undefined)).toBe(false);
});
it('rejects malformed API responses using authoritative schemas', async () => {
  await expect(
    validateResponse(SessionMemoryReviewSchema, {
      taskId: 'a',
      reviewHash: 'wrong',
      markdown: 'synthetic',
    }),
  ).rejects.toThrow('INVALID_RESPONSE');
  await expect(
    validateResponse(SessionMemoryStatusSchema, {
      enabled: true,
      active: false,
      status: 'invented',
    }),
  ).rejects.toThrow('INVALID_RESPONSE');
});
it('only turns same-space fixed revisions into local file links', () => {
  const text =
    '[source](oc://space/p/file/f@r) [duplicate](oc://space/p/file/f@r) [other](oc://space/else/file/f@r) [unsafe](oc://space/p/file/%2F@r) [bad](oc://space/%ZZ/file/f@r) <script>evil</script> javascript:evil';
  expect(fixedReviewLinks(text, 'p')).toEqual([
    {
      href: '/?project=p&view=files&file=f&revision=r',
      fileId: 'f',
      revisionId: 'r',
    },
  ]);
});

it('does not promote references from candidate code fences into provenance links', () => {
  expect(
    fixedReviewLinks(
      'oc://space/p/file/source@r\n~~~text\noc://space/p/file/forged@r\n~~~',
      'p',
    ).map((link) => link.fileId),
  ).toEqual(['source']);
});
