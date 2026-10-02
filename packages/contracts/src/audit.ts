import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { isErrorCode } from './errors.ts';
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const ref = Type.Union([uuid, Type.Null()]);
export const AuditEventSchema = Type.Object(
  {
    id: uuid,
    time: Type.String({
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
    }),
    actor: Type.Object(
      {
        id: Type.Union([
          uuid,
          Type.Literal('owner'),
          Type.Literal('system'),
          Type.Literal('anonymous'),
        ]),
        role: Type.Union([
          Type.Literal('owner'),
          Type.Literal('reader'),
          Type.Literal('system'),
          Type.Literal('anonymous'),
        ]),
      },
      { additionalProperties: false },
    ),
    action: Type.String({ pattern: '^[a-z][a-z_.]{1,63}$' }),
    target: Type.Object(
      {
        projectId: ref,
        bindingId: ref,
        fileId: ref,
        revisionId: ref,
        objectId: ref,
        tokenId: ref,
        commitId: Type.Optional(ref),
      },
      { additionalProperties: false },
    ),
    result: Type.Union([
      Type.Literal('success'),
      Type.Literal('denied'),
      Type.Literal('failed'),
    ]),
    code: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,63}$' }),
    requestId: ref,
    jobId: ref,
    guarantee: Type.Optional(
      Type.Union([Type.Literal('committed'), Type.Literal('best_effort')]),
    ),
  },
  { additionalProperties: false },
);
export type AuditEvent = Static<typeof AuditEventSchema>;
export function parseAuditEvent(input: unknown): AuditEvent {
  if (
    !Value.Check(AuditEventSchema, input) ||
    (input.code !== 'OK' && !isErrorCode(input.code))
  )
    throw new Error('INVALID_AUDIT_EVENT');
  return { ...input, guarantee: input.guarantee ?? 'best_effort' };
}

export type AuditContext = Pick<AuditEvent, 'actor' | 'requestId'> & {
  onRecorded?(id: string): void;
};
export function auditRef(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}
