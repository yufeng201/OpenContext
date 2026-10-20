import { opendir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { readLocalBytes } from '../packages/plugin-sdk/src/index.ts';
import {
  SessionMemoryStatusSchema,
  type SessionMemoryStatus,
} from '../packages/contracts/src/session-memory.ts';
import { prepareSessionUpload } from '../plugins/session-connector/src/jsonl-upload.ts';

export type UploadClientOptions = {
  selection: string;
  kind: 'file' | 'directory';
  origin: string;
  token: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
};
/** One selection, one frozen payload, at most two POST attempts. No local checkpoint/config writer. */
export async function uploadSessions(
  options: UploadClientOptions,
): Promise<SessionMemoryStatus> {
  const { signal, token } = options;
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
  if (token.length < 32 || token.length > 256 || !/^[!-~]+$/.test(token))
    throw new Error('INVALID_OWNER_TOKEN');
  const request = async (body?: string): Promise<SessionMemoryStatus> => {
    signal.throwIfAborted();
    const response = await (options.fetchImpl ?? fetch)(
      new URL('/api/session-memory' + (body ? '/upload' : ''), url),
      {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body ? { body } : {}),
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
        if (bytes > 65_536) throw new Error('RESPONSE_TOO_LARGE');
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
        typeof error?.error?.code === 'string'
          ? error.error.code
          : 'HTTP_ERROR',
      );
    }
    if (!Value.Check(SessionMemoryStatusSchema, result))
      throw new Error('INVALID_RESPONSE');
    return result;
  };
  const status = await request();
  if (
    !status.enabled ||
    status.inputMode !== 'upload' ||
    !status.projectScope ||
    !['codex-jsonl-0.159.2', 'codex-jsonl-0.161.0'].includes(
      status.format ?? '',
    )
  )
    throw new Error('POLICY_DENIED');
  const version =
    status.format === 'codex-jsonl-0.161.0' ? '0.161.0' : '0.159.2';
  const path = resolve(options.selection);
  if (realpathSync(path) !== path) throw new Error('UNSAFE_SYMLINK');
  const paths: string[] = [];
  if (options.kind === 'file') paths.push(path);
  else
    for await (const entry of await opendir(path)) {
      signal.throwIfAborted();
      if (!entry.isFile() || !entry.name.endsWith('.jsonl'))
        throw new Error('INVALID_PATH');
      paths.push(resolve(path, entry.name));
      if (paths.length > 8) throw new Error('FILE_LIMIT');
    }
  const inputs = paths.sort().map((file) => {
    signal.throwIfAborted();
    return readLocalBytes(file, 1_048_576);
  });
  const upload = prepareSessionUpload(inputs, status.projectScope, version);
  const body = JSON.stringify({
    expectedUploadHash: status.uploadHash ?? null,
    expectedUploadId: status.uploadId ?? null,
    upload,
  });
  if (Buffer.byteLength(body) > 2_105_344) throw new Error('BYTE_LIMIT');
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      return await request(body);
    } catch (error) {
      if (
        signal.aborted ||
        attempt !== 0 ||
        !(
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === 'TimeoutError')
        )
      )
        throw error;
      // Replay exactly these bytes/CAS expectation; never silently overwrite a newer selection.
    }
  }
  throw new Error('HTTP_ERROR');
}
