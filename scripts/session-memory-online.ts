import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { readLocalText } from '../packages/plugin-sdk/src/index.ts';
import { safeErrorCode } from '../packages/contracts/src/errors.ts';
import {
  SessionMemoryStatusSchema,
  SessionMemoryReviewSchema,
} from '../packages/contracts/src/session-memory.ts';
import {
  AgentTaskSchema,
  AgentResponseSchema,
} from '../plugins/session-candidates/src/local-agent.ts';

async function main(): Promise<void> {
  const [command, argument, reviewHash, ...extra] = process.argv.slice(2);
  if (!command || ['help', '--help'].includes(command)) {
    console.log(
      'Online session memory control: config | status | sync | task | review | submit RESPONSE_JSON | approve TASK_ID REVIEW_SHA256 | cancel TASK_ID | retry TASK_ID\nUses existing OPENCONTEXT_OWNER_TOKEN and OPENCONTEXT_URL (default http://127.0.0.1:4310). No local data writer, login, model execution or Agent configuration. A client timeout does not cancel an accepted server operation; inspect status before retry.',
    );
    return;
  }
  if (
    ![
      'config',
      'status',
      'sync',
      'task',
      'review',
      'submit',
      'approve',
      'cancel',
      'retry',
    ].includes(command) ||
    extra.length ||
    (command === 'approve'
      ? !argument || !/^[a-f0-9]{64}$/.test(reviewHash ?? '')
      : reviewHash !== undefined ||
        (['submit', 'cancel', 'retry'].includes(command)
          ? !argument
          : argument !== undefined))
  )
    throw new Error('INVALID_CONFIG');
  const token = process.env['OPENCONTEXT_OWNER_TOKEN'];
  if (
    !token ||
    token.length < 32 ||
    token.length > 256 ||
    !/^[!-~]+$/.test(token)
  )
    throw new Error('INVALID_OWNER_TOKEN');
  const url = new URL(
    process.env['OPENCONTEXT_URL'] ?? 'http://127.0.0.1:4310',
  );
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('INVALID_SERVER_URL');
  let payload: unknown;
  if (command === 'submit') {
    payload = JSON.parse(readLocalText(argument!, 4_194_304));
    if (!Value.Check(AgentResponseSchema, payload))
      throw new Error('INVALID_CANDIDATE');
  } else if (command === 'approve') payload = { taskId: argument, reviewHash };
  else if (['cancel', 'retry'].includes(command))
    payload = { taskId: argument };
  else if (command === 'sync') payload = {};
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  const response = await fetch(
    new URL(
      '/api/session-memory' +
        (['status', 'config'].includes(command) ? '' : '/' + command),
      url,
    ),
    {
      method: payload === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    },
  );
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel();
    throw new Error('INVALID_RESPONSE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_RESPONSE');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16_777_216) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (response.status !== 200) {
    const error = result as { error?: { code?: unknown } };
    throw new Error(
      typeof error?.error?.code === 'string' ? error.error.code : 'HTTP_ERROR',
    );
  }
  const schema =
    command === 'task'
      ? Type.Object(
          {
            task: AgentTaskSchema,
            responseSchema: Type.Object({}, { additionalProperties: true }),
          },
          { additionalProperties: false },
        )
      : command === 'review'
        ? SessionMemoryReviewSchema
        : SessionMemoryStatusSchema;
  if (!Value.Check(schema, result)) throw new Error('INVALID_RESPONSE');
  console.log(JSON.stringify(result, null, 2));
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({ error: safeErrorCode(error, 'PROCESSING_FAILED') }),
  );
  process.exitCode = 1;
}
