import { Type, type Static } from '@sinclair/typebox';

export const PluginSelectionSchema = Type.Object(
  {
    packageRef: Type.String({ minLength: 1, maxLength: 200 }),
    config: Type.Record(Type.String(), Type.Unknown(), { maxProperties: 30 }),
  },
  { additionalProperties: false },
);
export const CreatePluginBindingSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    connector: PluginSelectionSchema,
    processor: PluginSelectionSchema,
  },
  { additionalProperties: false },
);
export type CreatePluginBindingInput = Static<typeof CreatePluginBindingSchema>;
export type ExecutableCapability = 'connector' | 'processor';
export type PluginInstanceLock = {
  ref: string;
  packageRef: string;
  packageDigest: string;
  configHash: string;
  capability: ExecutableCapability;
  config: Record<string, unknown>;
};
export type PreparedBinding = {
  name: string;
  connector: PluginInstanceLock;
  processor: PluginInstanceLock;
};
export type ImportedObjectRef = {
  id: string;
  filename: string;
  contentHash: string;
  bytes: number;
};
export type ExecutionLock = {
  instance: PluginInstanceLock;
  imports: ImportedObjectRef[];
};
export type ConnectorInvocation = {
  config: Record<string, unknown>;
  previousVersion: string | null;
  imports: ImportedObjectRef[];
  maxFiles: number;
  maxBytes: number;
};
export const ImportUploadSchema = Type.Object(
  {
    filename: Type.String({
      minLength: 1,
      maxLength: 120,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*[.]json$',
    }),
    content: Type.String({ minLength: 1, maxLength: 1_048_576 }),
    expectedObjectId: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
export type ImportUploadInput = Static<typeof ImportUploadSchema>;
export type PluginField = {
  key: string;
  label: string;
  kind: 'text' | 'select';
  placeholder?: string;
  options?: { value: string; label: string }[];
  default?: string;
};
export type PluginDescriptor = {
  packageRef: string;
  packageDigest: string;
  capability: ExecutableCapability;
  title: string;
  description: string;
  configSchema: Record<string, unknown>;
  fields: PluginField[];
  acceptsImports: boolean;
  recommendedProcessorRef?: string;
  available: boolean;
  limitations: string[];
  supportsConnectionTest?: boolean;
};
export const ConnectionTestResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('reachable'),
      Type.Literal('blocked'),
      Type.Literal('error'),
    ]),
    evidence: Type.Union([Type.Literal('live'), Type.Literal('simulated')]),
    code: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,79}$' }),
  },
  { additionalProperties: false },
);
export type ConnectionTestResult = Static<typeof ConnectionTestResultSchema>;

export const FeishuChatMessageSchema = Type.Object(
  {
    schema: Type.Literal('opencontext.feishu-chat-message/v1'),
    realm: Type.Union([Type.Literal('feishu'), Type.Literal('lark')]),
    evidence: Type.Union([Type.Literal('live'), Type.Literal('simulated')]),
    chatId: Type.String({ minLength: 1, maxLength: 160 }),
    messageId: Type.String({ minLength: 1, maxLength: 160 }),
    createTime: Type.String({ pattern: '^[0-9]+$' }),
    updateTime: Type.String({ pattern: '^[0-9]+$' }),
    messageType: Type.String({ minLength: 1, maxLength: 80 }),
    text: Type.String({ maxLength: 1_048_576 }),
    raw: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type FeishuChatMessage = Static<typeof FeishuChatMessageSchema>;

export const SessionMessageSchema = Type.Object(
  {
    schema: Type.Literal('opencontext.session-message/v1'),
    provider: Type.Union([Type.Literal('codex'), Type.Literal('claude')]),
    projectScope: Type.String({ minLength: 1, maxLength: 120 }),
    sessionId: Type.String({ minLength: 1, maxLength: 200 }),
    messageId: Type.String({ minLength: 1, maxLength: 200 }),
    turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
    text: Type.String({ maxLength: 1_048_576 }),
  },
  { additionalProperties: false },
);
export type NormalizedSessionMessage = Static<typeof SessionMessageSchema>;
