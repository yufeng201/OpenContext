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
    directory: Type.Optional(Type.String()),
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
