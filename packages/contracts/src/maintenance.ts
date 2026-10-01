import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
export const BackupManifestSchema = Type.Object(
  {
    format: Type.Literal('opencontext-backup'),
    version: Type.Literal(1),
    complete: Type.Literal(true),
    id: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
    storageVersion: Type.Literal(1),
    mode: Type.Union([Type.Literal('demo'), Type.Literal('private')]),
    createdAt: Type.String({ maxLength: 40 }),
    heads: Type.Array(
      Type.Object(
        {
          id: Type.String({ maxLength: 120 }),
          head: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20_000 },
    ),
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ maxLength: 2000 }),
          bytes: Type.Integer({ minimum: 0, maximum: 134_217_728 }),
          sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20_000 },
    ),
  },
  { additionalProperties: false },
);
export type BackupManifest = Static<typeof BackupManifestSchema>;
export function parseBackupManifest(input: unknown): BackupManifest {
  if (!Value.Check(BackupManifestSchema, input))
    throw new Error('UNSUPPORTED_BACKUP');
  return input;
}

const dependencyCodes = [
  'OK',
  'LEGACY_COMPATIBLE',
  'DATABASE_UNAVAILABLE',
  'DATABASE_LIMIT',
  'SCHEMA_UNSUPPORTED',
  'STORAGE_UNAVAILABLE',
  'CHECKPOINT_UNAVAILABLE',
  'INDEX_UNAVAILABLE',
  'RESTORE_INCOMPLETE',
  'CHECK_LIMIT_EXCEEDED',
  'CORRUPT_OBJECT',
  'CORRUPT_REVISION',
  'CORRUPT_MANIFEST',
  'CORRUPT_REFERENCE',
  'CORRUPT_HEAD',
  'UNSAFE_SYMLINK',
  'UNSAFE_FILE',
  'BACKUP_LIMIT',
  'OBJECT_MISSING_OR_CORRUPT',
  'CHECKPOINT_MISSING_OR_CORRUPT',
  'INDEX_NOT_READY',
  'INDEX_CORRUPT',
  'INDEX_REBUILD_FAILED',
  'SCHEDULER_FAILED',
  'AUDIT_UNAVAILABLE',
  'AUDIT_BACKLOG',
] as const;
const DependencySchema = Type.Object(
  {
    ok: Type.Boolean(),
    code: Type.Union(dependencyCodes.map((c) => Type.Literal(c))),
  },
  { additionalProperties: false },
);
export const ReadinessReportSchema = Type.Object(
  {
    ready: Type.Boolean(),
    checks: Type.Object(
      {
        database: DependencySchema,
        migration: DependencySchema,
        storage: DependencySchema,
        pluginState: DependencySchema,
        index: DependencySchema,
      },
      { additionalProperties: false },
    ),
    counts: Type.Object(
      {
        projects: Type.Integer({ minimum: 0 }),
        revisions: Type.Integer({ minimum: 0 }),
        pendingIndex: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    mode: Type.Union([
      Type.Literal('demo'),
      Type.Literal('private'),
      Type.Null(),
    ]),
    requestId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
    scheduler: DependencySchema,
    audit: Type.Optional(
      Type.Object(
        {
          ...DependencySchema.properties,
          pending: Type.Optional(
            Type.Union([
              Type.Integer({ minimum: 0, maximum: 10000 }),
              Type.Null(),
            ]),
          ),
          maxPending: Type.Optional(Type.Literal(10000)),
          suspended: Type.Optional(Type.Boolean()),
          readGap: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ReadinessReport = Static<typeof ReadinessReportSchema>;
export function parseReadinessReport(input: unknown): ReadinessReport {
  if (!Value.Check(ReadinessReportSchema, input))
    throw new Error('INVALID_READINESS_RESPONSE');
  return input;
}
