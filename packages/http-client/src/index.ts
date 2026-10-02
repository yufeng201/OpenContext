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
    super(code);
    this.name = 'OpenContextError';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
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
    this.maximum = options.maxResponseBytes ?? QUERY_RESPONSE_MAX_BYTES;
    if (
      !Number.isInteger(this.maximum) ||
      this.maximum < 128 ||
      this.maximum > QUERY_RESPONSE_MAX_BYTES
    )
      throw new Error('INVALID_RESPONSE_LIMIT');
    this.base = url.origin;
    this.token = options.token;
    this.transport = options.fetch ?? fetch;
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
    const wait = <U>(operation: Promise<U>): Promise<U> =>
      new Promise((resolve, reject) => {
        const stop = () => reject(aborted());
        if (signal.aborted) {
          operation.catch(() => undefined);
          reject(aborted());
          return;
        }
        signal.addEventListener('abort', stop, { once: true });
        operation
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', stop))
          .catch(() => undefined);
      });
    let response: Response | undefined;
    try {
      if (signal.aborted) throw aborted();
      const operation = this.transport(this.base + path, {
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
      operation
        .then((r) => {
          if (signal.aborted) void r.body?.cancel().catch(() => undefined);
        })
        .catch(() => undefined);
      try {
        response = await wait(operation);
      } catch (error) {
        if (error instanceof OpenContextError) throw error;
        throw new OpenContextError(
          0,
          signal.aborted ? String(signal.reason) : 'REQUEST_FAILED',
        );
      }
      const errorStatus = !response.ok && response.status !== diagnosticStatus;
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
          (!/^\d+$/.test(length) || Number(length) > this.maximum)
        )
          throw new OpenContextError(
            response.status,
            Number(length) > this.maximum
              ? 'RESPONSE_TOO_LARGE'
              : 'INVALID_RESPONSE',
          );
        const reader = response.body?.getReader();
        if (!reader)
          throw new OpenContextError(response.status, 'INVALID_RESPONSE');
        const chunks: Uint8Array[] = [];
        let size = 0,
          complete = false;
        try {
          while (true) {
            const part = await wait(reader.read());
            if (part.done) break;
            size += part.value.byteLength;
            if (size > this.maximum)
              throw new OpenContextError(response.status, 'RESPONSE_TOO_LARGE');
            chunks.push(part.value);
          }
          data = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
          complete = true;
        } finally {
          if (!complete) void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      } catch (error) {
        if (signal.aborted) throw aborted();
        if (errorStatus)
          throw new OpenContextError(response.status, 'HTTP_ERROR');
        if (error instanceof OpenContextError) throw error;
        throw new OpenContextError(response.status, 'INVALID_RESPONSE');
      }
      if (errorStatus) {
        try {
          const parsed = parseQueryError(data);
          throw new OpenContextError(
            response.status,
            parsed.error.code,
            parsed.error.correlationId,
          );
        } catch (error) {
          if (error instanceof OpenContextError) throw error;
          throw new OpenContextError(response.status, 'HTTP_ERROR');
        }
      }
      if (response.status !== 200 && response.status !== diagnosticStatus)
        throw new OpenContextError(response.status, 'INVALID_RESPONSE');
      try {
        return parseQueryResponse(schema, data, scope) as T;
      } catch {
        throw new OpenContextError(response.status, 'INVALID_RESPONSE');
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if (signal.aborted) void response?.body?.cancel().catch(() => undefined);
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
      return parseReadinessReport(result);
    } catch (error) {
      if (
        error instanceof OpenContextError &&
        ['INVALID_RESPONSE', 'INVALID_RESPONSE_CONTENT_TYPE'].includes(
          error.code,
        )
      )
        throw new OpenContextError(502, 'INVALID_READINESS_RESPONSE');
      throw error;
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
    options: QueryRequestOptions = {},
  ): Promise<ReadResult> {
    if (!Value.Check(ReadSchema, { fileId, revisionId }))
      throw new OpenContextError(0, 'INVALID_SCHEMA');
    const result = await this.request<ReadResult>(
      projectQueryPath(QueryRoutes.read, projectId) +
        '?' +
        new URLSearchParams({ fileId, revisionId }),
      ReadResultSchema,
      undefined,
      options,
      { projectId, fileId, revisionId },
    );
    if (
      createHash('sha256').update(result.text).digest('hex') !==
      result.file.contentHash
    )
      throw new OpenContextError(200, 'INVALID_RESPONSE');
    return result;
  }
}
