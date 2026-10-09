import { Value } from '@sinclair/typebox/value';
import {
  agentHash,
  AgentTaskSchema,
} from '../plugins/session-candidates/src/local-agent.ts';
import {
  SessionMemoryStatusSchema,
  type SessionMemoryStatus,
} from '../packages/contracts/src/session-memory.ts';
import { completedWorker } from './local-agent-worker.ts';

/** Credential-bearing sender is a separate invocation; it never launches a worker. */
export async function submitWorker(
  job: string,
  options: {
    origin: string;
    token: string;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<SessionMemoryStatus> {
  const { task, response } = completedWorker(job);
  const url = new URL(options.origin);
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
  if (
    options.token.length < 32 ||
    options.token.length > 256 ||
    !/^[!-~]+$/.test(options.token)
  )
    throw new Error('INVALID_OWNER_TOKEN');
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    options.signal.throwIfAborted();
    const result = await (options.fetchImpl ?? fetch)(new URL(path, url), {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const reader = result.body?.getReader();
    if (
      !reader ||
      !result.headers.get('content-type')?.startsWith('application/json')
    ) {
      await reader?.cancel();
      throw new Error('INVALID_RESPONSE');
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8_388_608) throw new Error('RESPONSE_TOO_LARGE');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.status !== 200) {
      const error = value as { error?: { code?: unknown } };
      throw new Error(
        typeof error?.error?.code === 'string'
          ? error.error.code
          : 'HTTP_ERROR',
      );
    }
    return value;
  };
  const current = (await request('/api/session-memory/task')) as {
    task?: unknown;
  };
  if (
    !Value.Check(AgentTaskSchema, current.task) ||
    agentHash(current.task) !== agentHash(task)
  )
    throw new Error('INPUT_CHANGED');
  const submitted = await request('/api/session-memory/submit', response);
  if (!Value.Check(SessionMemoryStatusSchema, submitted))
    throw new Error('INVALID_RESPONSE');
  return submitted;
}
