import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const id = Type.String({ minLength: 1, maxLength: 200 });
const optionalId = Type.Optional(Type.Union([id, Type.Null()]));
const metadata = Type.Optional(
  Type.Union([
    Type.Null(),
    Type.Object(
      { turn_id: Type.Optional(id) },
      { additionalProperties: false },
    ),
  ]),
);
const common = {
  id: optionalId,
  internal_chat_message_metadata_passthrough: metadata,
};
const output = Type.Union([
  Type.String(),
  Type.Array(
    Type.Object(
      { type: Type.Literal('input_text'), text: Type.String() },
      { additionalProperties: false },
    ),
    { maxItems: 2000 },
  ),
]);
export const ToolSchema = Type.Union([
  Type.Object(
    {
      ...common,
      type: Type.Literal('function_call'),
      name: id,
      namespace: optionalId,
      arguments: Type.String(),
      call_id: id,
      encrypted_function_args: Type.Optional(Type.Null()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      type: Type.Literal('custom_tool_call'),
      name: id,
      namespace: optionalId,
      input: Type.String(),
      call_id: id,
      status: Type.Optional(
        Type.Union([Type.Null(), Type.Literal('completed')]),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      type: Type.Literal('function_call_output'),
      name: optionalId,
      namespace: optionalId,
      call_id: id,
      output,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      type: Type.Literal('custom_tool_call_output'),
      name: optionalId,
      call_id: id,
      output,
    },
    { additionalProperties: false },
  ),
]);
export const ReasoningSchema = Type.Object(
  {
    ...common,
    type: Type.Literal('reasoning'),
    summary: Type.Array(
      Type.Object(
        { type: Type.Literal('summary_text'), text: Type.String() },
        { additionalProperties: false },
      ),
      { maxItems: 2000 },
    ),
    content: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Array(
          Type.Object(
            {
              type: Type.Union([
                Type.Literal('reasoning_text'),
                Type.Literal('text'),
              ]),
              text: Type.String(),
            },
            { additionalProperties: false },
          ),
          { maxItems: 2000 },
        ),
      ]),
    ),
    encrypted_content: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  },
  { additionalProperties: false },
);
const nullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
export const CompactedSchema = Type.Object(
  {
    message: Type.String(),
    replacement_history: Type.Optional(
      Type.Union([Type.Null(), Type.Array(Type.Unknown(), { maxItems: 2000 })]),
    ),
    replacement_history_metadata: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Array(Type.Object({}, { additionalProperties: false }), {
          maxItems: 2000,
        }),
      ]),
    ),
    guardian_history: Type.Optional(Type.Null()),
    retained_context: Type.Optional(Type.Null()),
    mcp_resource_origins: Type.Optional(Type.Null()),
    window_number: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ]),
    ),
    first_window_id: nullableString,
    previous_window_id: nullableString,
    window_id: nullableString,
    compaction_response_id: nullableString,
    latest_token_usage_record: Type.Optional(Type.Null()),
    resume_metadata: Type.Optional(Type.Null()),
  },
  { additionalProperties: false },
);
// Known UI mirrors/usage only. Never a second source of tool output or completion.
export const RAW_ONLY_EVENTS = new Set([
  'user_message',
  'agent_message',
  'token_count',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'agent_reasoning_section_break',
  'exec_command_begin',
  'exec_command_output_delta',
  'exec_command_end',
  'terminal_interaction',
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  'patch_apply_begin',
  'patch_apply_updated',
  'patch_apply_end',
  'item_started',
  'item_completed',
  'raw_response_item',
  'raw_response_completed',
  'agent_message_content_delta',
  'plan_delta',
  'reasoning_content_delta',
  'reasoning_raw_content_delta',
  'plan_update',
  'turn_diff',
  'context_compacted',
]);
export function requireTool(value: unknown) {
  if (!Value.Check(ToolSchema, value))
    throw new Error('UNSUPPORTED_SESSION_JSONL');
  return value;
}
