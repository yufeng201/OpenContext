import { assertReadSelection } from '@opencontext/contracts/query-api';
import type { ReadOptions } from '@opencontext/contracts';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import {
  isErrorCode,
  safeErrorCode,
  safeErrorMetadata,
} from '@opencontext/contracts/errors';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import {
  ReadSchema,
  SearchSchema,
  ReadResultSchema,
  SearchResultSchema,
} from '@opencontext/contracts';
import {
  parseReadinessReport,
  ReadinessReportSchema,
  type ReadinessReport,
} from '@opencontext/contracts/maintenance';
import {
  QueryRoutes,
  ProjectsSchema,
  TreeSchema,
  FilePageInputSchema,
  FilePageSchema,
  parseQueryResponse,
  parseQueryError,
  QUERY_RESPONSE_MAX_BYTES,
  READ_RESPONSE_MAX_BYTES,
  queryResponseMaxBytes,
  type FilePage,
  type FilePageInput,
  projectQueryPath,
} from '@opencontext/contracts/query-api';
import type {
  FileEntry,
  Project,
  ReadResult,
  SearchInput,
  SearchResult,
} from '@opencontext/contracts';
export class OpenContextError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | undefined;
  constructor(status: number, code: string, correlationId?: string) {
    const stableCode = isErrorCode(code) ? code : 'REQUEST_FAILED';
    super(stableCode);
    const metadata = safeErrorMetadata({ status, correlationId });
    this.name = 'OpenContextError';
    this.status = metadata.status ?? 0;
    this.code = stableCode;
    this.correlationId = metadata.correlationId;
  }
}
/** Create a fresh closed error; foreign subclasses, getters, stacks and causes are never retained. */
export function normalizeOpenContextError(
  error: unknown,
  fallback = 'REQUEST_FAILED',
  defaultStatus = 0,
): OpenContextError {
  const metadata = safeErrorMetadata(error);
  return new OpenContextError(
    metadata.status ?? defaultStatus,
    safeErrorCode(error, fallback),
    metadata.correlationId,
  );
}
export type QueryRequestOptions = { signal?: AbortSignal };
/** Node24 source-only readonly preview SDK; no retries, persistence or mutation. */
export class OpenContextClient {
  private readonly base: string;
  private readonly token: string;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maximum: number;
  constructor(options: {
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
  }) {
    try {
      let url: URL;
      try {
        url = new URL(options.baseUrl);
      } catch {
        throw new Error('INVALID_SERVER_URL');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error('INVALID_SERVER_URL');
      if (
        url.protocol === 'http:' &&
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      )
        throw new Error('PLAINTEXT_REMOTE_URL');
      if (
        typeof options.token !== 'string' ||
        options.token.length < 16 ||
        options.token.length > 256 ||
        !/^[!-~]+$/.test(options.token)
      )
        throw new Error('INVALID_TOKEN');
      this.timeoutMs = options.timeoutMs ?? 15000;
      if (
        !Number.isInteger(this.timeoutMs) ||
        this.timeoutMs < 10 ||
        this.timeoutMs > 15000
      )
        throw new Error('INVALID_TIMEOUT');
      this.maximum = options.maxResponseBytes ?? READ_RESPONSE_MAX_BYTES;
      if (
        !Number.isInteger(this.maximum) ||
        this.maximum < 128 ||
        this.maximum > READ_RESPONSE_MAX_BYTES
      )
        throw new Error('INVALID_RESPONSE_LIMIT');
      this.base = url.origin;
      this.token = options.token;
      this.transport = options.fetch ?? fetch;
    } catch (error) {
      throw normalizeOpenContextError(error);
    }
  }
  private async request<T>(
    path: string,
    schema: TSchema,
    body?: SearchInput,
    options: QueryRequestOptions = {},
    scope: {
      projectId?: string;
      fileId?: string;
      revisionId?: string;
      limit?: number;
    } = {},
    diagnosticStatus?: number,
  ): Promise<T> {
    const deadline = performance.now() + this.timeoutMs;
    const controller = new AbortController();
    const cancel = () => controller.abort('CANCELLED');
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort('TIMEOUT'), this.timeoutMs);
    const signal = controller.signal;
    const aborted = () =>
      new OpenContextError(
        0,
        signal.reason === 'CANCELLED' ? 'CANCELLED' : 'TIMEOUT',
      );
    const check = () => {
      if (!signal.aborted && performance.now() >= deadline)
        controller.abort('TIMEOUT');
      if (signal.aborted) throw aborted();
    };
    const wait = <U>(operation: Promise<U>): Promise<U> =>
      new Promise((resolve, reject) => {
        const stop = () => {
          signal.removeEventListener('abort', stop);
          reject(aborted());
        };
        try {
          check();
        } catch (error) {
          void operation.catch(() => undefined);
          reject(error);
          return;
        }
        signal.addEventListener('abort', stop, { once: true });
        void operation.then(
          (value) => {
            signal.removeEventListener('abort', stop);
            try {
              check();
              resolve(value);
            } catch (error) {
              reject(error);
            }
          },
          (error) => {
            signal.removeEventListener('abort', stop);
            reject(error);
          },
        );
      });
    const cancelBody = (response: Response) => {
      try {
        void response.body?.cancel().catch(() => undefined);
      } catch {
        /* Best-effort cleanup must not expose native diagnostics. */
      }
    };
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      check();
      const operation = Promise.resolve().then(() => {
        check();
        return this.transport(this.base + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            authorization: 'Bearer ' + this.token,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          credentials: 'omit',
          signal,
        });
      });
      void operation
        .then((r) => {
          response = r;
          if (signal.aborted) cancelBody(r);
        })
        .catch(() => undefined);
      try {
        response = await wait(operation);
      } catch {
        check();
        throw new OpenContextError(0, 'REQUEST_FAILED');
      }
      check();
      const expectedStatus =
        response.status === 200 || response.status === diagnosticStatus;
      // Do not acquire/read an unexpected successful or redirect response body.
      // Only 200 read responses receive the larger encoded-body allowance.
      if (!expectedStatus && response.status < 400)
        throw new OpenContextError(response.status, 'INVALID_RESPONSE');
      const errorStatus = !expectedStatus;
      const maximum = Math.min(
        this.maximum,
        response.status === 200
          ? queryResponseMaxBytes(schema)
          : QUERY_RESPONSE_MAX_BYTES,
      );
      let data: unknown;
      try {
        if (
          response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase() !== 'application/json'
        )
          throw new OpenContextError(
            response.status,
            'INVALID_RESPONSE_CONTENT_TYPE',
          );
        const length = response.headers.get('content-length');
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) > maximum)
        )
          throw new OpenContextError(
            response.status,
            Number(length) > maximum
              ? 'RESPONSE_TOO_LARGE'
              : 'INVALID_RESPONSE',
          );
        reader = response.body?.getReader();
        if (!reader)
          throw new OpenContextError(response.status, 'INVALID_RESPONSE');
        // Copy into bounded owned segments; never retain empty chunks or oversized backing buffers.
        const segments: Uint8Array[] = [];
        let current: Uint8Array | undefined,
          used = 0,
          size = 0,
          reads = 0;
        while (true) {
          check();
          if (++reads > 8192)
            throw new OpenContextError(response.status, 'RESPONSE_WORK_LIMIT');
          const part = await wait(reader.read());
          check();
          if (part.done) break;
          if (!(part.value instanceof Uint8Array))
            throw new OpenContextError(response.status, 'INVALID_RESPONSE');
          size += part.value.byteLength;
          if (size > maximum)
            throw new OpenContextError(response.status, 'RESPONSE_TOO_LARGE');
          let offset = 0;
          while (offset < part.value.byteLength) {
            check();
            if (!current || used === current.length) {
              current = new Uint8Array(
                Math.min(
                  65536,
                  maximum - (size - part.value.byteLength + offset),
                ),
              );
              segments.push(current);
              used = 0;
            }
            const count = Math.min(
              current.length - used,
              part.value.byteLength - offset,
            );
            current.set(part.value.subarray(offset, offset + count), used);
            used += count;
            offset += count;
          }
          // Timers and scheduled caller cancellation must run even for immediately ready reads.
          if (reads % 64 === 0) await wait(yieldEventLoop());
        }
        check();
        const bytes = Buffer.concat(
          segments.map((segment, index) =>
            index === segments.length - 1 ? segment.subarray(0, used) : segment,
          ),
          size,
        );
        check();
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        check();
        data = JSON.parse(decoded);
        check();
      } catch (error) {
        check();
        if (errorStatus)
          throw new OpenContextError(response.status, 'HTTP_ERROR');
        throw normalizeOpenContextError(
          error,
          'INVALID_RESPONSE',
          response.status,
        );
      }
      if (errorStatus) {
        let parsed: ReturnType<typeof parseQueryError>;
        try {
          parsed = parseQueryError(data);
        } catch {
          check();
          throw new OpenContextError(response.status, 'HTTP_ERROR');
        }
        check();
        throw new OpenContextError(
          response.status,
          parsed.error.code,
          parsed.error.correlationId,
        );
      }
      if (response.status !== 200 && response.status !== diagnosticStatus)
        throw new OpenContextError(response.status, 'INVALID_RESPONSE');
      let result: T;
      try {
        result = parseQueryResponse(schema, data, scope) as T;
        check();
        if (schema === ReadResultSchema) {
          const read = result as ReadResult;
          if (
            createHash('sha256').update(read.text).digest('hex') !==
            (read.disclosure?.textHash ?? read.file.contentHash)
          )
            throw new OpenContextError(response.status, 'INVALID_RESPONSE');
          check();
        }
        if (schema === ReadinessReportSchema) {
          parseReadinessReport(result);
          check();
        }
      } catch (error) {
        check();
        throw normalizeOpenContextError(
          error,
          'INVALID_RESPONSE',
          response.status,
        );
      }
      check();
      complete = true;
      return result;
    } catch (error) {
      check();
      throw normalizeOpenContextError(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if (reader) {
        if (!complete) {
          try {
            void reader.cancel().catch(() => undefined);
          } catch {
            /* Best effort. */
          }
        }
        try {
          reader.releaseLock();
        } catch {
          /* Best effort for native cleanup. */
        }
      } else if (response && !complete) cancelBody(response);
    }
  }
  async readiness(options: QueryRequestOptions = {}): Promise<ReadinessReport> {
    try {
      const result = await this.request<unknown>(
        '/api/readiness',
        ReadinessReportSchema,
        undefined,
        options,
        {},
        503,
      );
      return result as ReadinessReport;
    } catch (error) {
      const projected = normalizeOpenContextError(error);
      if (
        ['INVALID_RESPONSE', 'INVALID_RESPONSE_CONTENT_TYPE'].includes(
          projected.code,
        )
      )
        throw new OpenContextError(502, 'INVALID_READINESS_RESPONSE');
      throw projected;
    }
  }

  projects(options: QueryRequestOptions = {}): Promise<Project[]> {
    return this.request(
      QueryRoutes.projects,
      ProjectsSchema,
      undefined,
      options,
    );
  }
  tree(
    projectId: string,
    options: QueryRequestOptions = {},
  ): Promise<FileEntry[]> {
    return this.request(
      projectQueryPath(QueryRoutes.tree, projectId),
      TreeSchema,
      undefined,
      options,
      { projectId },
    );
  }
  filesPage(
    projectId: string,
    input: FilePageInput = {},
    options: QueryRequestOptions = {},
  ): Promise<FilePage> {
    if (!Value.Check(FilePageInputSchema, input))
      throw new OpenContextError(0, 'INVALID_SCHEMA');
    const query = new URLSearchParams(
      Object.entries(input).map(([k, v]) => [k, String(v)]),
    );
    return this.request(
      projectQueryPath(QueryRoutes.files, projectId) + '?' + query,
      FilePageSchema,
      undefined,
      options,
      { projectId, limit: input.limit ?? 100 },
    );
  }
  search(
    projectId: string,
    input: SearchInput,
    options: QueryRequestOptions = {},
  ): Promise<SearchResult> {
    if (!Value.Check(SearchSchema, input))
      throw new OpenContextError(0, 'INVALID_SCHEMA');
    return this.request(
      projectQueryPath(QueryRoutes.search, projectId),
      SearchResultSchema,
      input,
      options,
      { projectId, limit: input.limit ?? 10 },
    );
  }
  async read(
    projectId: string,
    fileId: string,
    revisionId: string,
    options: QueryRequestOptions & ReadOptions = {},
  ): Promise<ReadResult> {
    const selector = Object.fromEntries(
      Object.entries(options).filter(
        ([key, value]) => key !== 'signal' && value !== undefined,
      ),
    ) as ReadOptions;
    if (!Value.Check(ReadSchema, { fileId, revisionId, ...selector }))
      throw new OpenContextError(0, 'INVALID_SCHEMA');
    const result = await this.request<ReadResult>(
      projectQueryPath(QueryRoutes.read, projectId) +
        '?' +
        new URLSearchParams({
          fileId,
          revisionId,
          ...Object.fromEntries(
            Object.entries(selector).map(([key, value]) => [
              key,
              String(value),
            ]),
          ),
        }),
      ReadResultSchema,
      undefined,
      options,
      { projectId, fileId, revisionId },
    );
    try {
      assertReadSelection(result, selector);
    } catch {
      throw new OpenContextError(200, 'INVALID_RESPONSE');
    }
    return result;
  }
}
