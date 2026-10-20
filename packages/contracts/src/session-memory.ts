import { Type, type Static } from '@sinclair/typebox';

const nullable = Type.Union([Type.String(), Type.Null()]);
export const SessionMemoryStatusSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    active: Type.Boolean(),
    status: Type.Union(
      [
        'disabled',
        'idle',
        'pending',
        'review',
        'failed',
        'cancelled',
        'publishing',
        'published',
      ].map((s) => Type.Literal(s)),
    ),
    format: Type.Optional(
      Type.Union([
        Type.Literal('v1'),
        Type.Literal('codex-jsonl-0.159.2'),
        Type.Literal('codex-jsonl-0.161.0'),
      ]),
    ),
    directory: Type.Optional(Type.String()),
    inputMode: Type.Optional(
      Type.Union([Type.Literal('directory'), Type.Literal('upload')]),
    ),
    uploadHash: Type.Optional(nullable),
    uploadId: Type.Optional(nullable),
    projectScope: Type.Optional(Type.String()),
    projectId: Type.Optional(nullable),
    bindingId: Type.Optional(nullable),
    taskId: Type.Optional(nullable),
    sourceVersion: Type.Optional(nullable),
    processedVersion: Type.Optional(nullable),
    reviewHash: Type.Optional(nullable),
    error: Type.Optional(nullable),
  },
  { additionalProperties: false },
);
export type SessionMemoryStatus = Static<typeof SessionMemoryStatusSchema>;
export const SessionMemoryTaskActionSchema = Type.Object(
  { taskId: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
export const SessionMemoryApprovalSchema = Type.Object(
  {
    ...SessionMemoryTaskActionSchema.properties,
    reviewHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
);
export const SessionMemoryReviewSchema = Type.Object(
  {
    ...SessionMemoryApprovalSchema.properties,
    markdown: Type.String({ maxLength: 8_388_608 }),
  },
  { additionalProperties: false },
);

export const SessionUploadSchema = Type.Object(
  {
    schema: Type.Literal('opencontext.session-upload/v1'),
    cliVersion: Type.Union([Type.Literal('0.159.2'), Type.Literal('0.161.0')]),
    files: Type.Array(
      Type.Object(
        {
          content: Type.String({ minLength: 1, maxLength: 1_048_576 }),
          clientPrefixHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
          clientPrefixBytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 8 },
    ),
  },
  { additionalProperties: false },
);
export type SessionUpload = Static<typeof SessionUploadSchema>;
export const SessionUploadRequestSchema = Type.Object(
  {
    expectedUploadId: Type.Union([
      Type.Null(),
      Type.String({ minLength: 1, maxLength: 120 }),
    ]),
    expectedUploadHash: Type.Union([
      Type.Null(),
      Type.String({ pattern: '^[a-f0-9]{64}$' }),
    ]),
    upload: SessionUploadSchema,
  },
  { additionalProperties: false },
);
