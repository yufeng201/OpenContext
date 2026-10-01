import { isErrorCode } from '@opencontext/contracts/errors';
import {
  parseReadinessReport,
  type ReadinessReport,
} from '@opencontext/contracts/maintenance';
import {
  QueryRoutes,
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
/** Source-only preview SDK. No token persistence, cookies, retries or writes. */
export class OpenContextClient {
  private readonly base: string;
  private readonly token: string;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: {
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('INVALID_SERVER_URL');
    if (
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
    if (!options.token || /[\r\n]/.test(options.token))
      throw new Error('INVALID_TOKEN');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 10 ||
      this.timeoutMs > 15_000
    )
      throw new Error('INVALID_TIMEOUT');
    this.base = url.origin;
    this.token = options.token;
    this.transport = options.fetch ?? fetch;
  }
  private async responseJson(response: Response): Promise<unknown> {
    const maximum = 16_777_216;
    if (Number(response.headers.get('content-length')) > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new OpenContextError(response.status, 'RESPONSE_TOO_LARGE');
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new OpenContextError(response.status, 'INVALID_RESPONSE');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maximum) {
          void reader.cancel().catch(() => undefined);
          throw new OpenContextError(response.status, 'RESPONSE_TOO_LARGE');
        }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof OpenContextError) throw error;
      throw new OpenContextError(response.status, 'INVALID_RESPONSE');
    } finally {
      reader.releaseLock();
    }
  }
  private async request<T>(
    path: string,
    body?: SearchInput,
    diagnosticStatus?: number,
  ): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.transport(this.base + path, {
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
    } catch {
      throw new OpenContextError(
        0,
        signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED',
      );
    }
    if (!response.ok && response.status !== diagnosticStatus) {
      let code = 'HTTP_ERROR',
        correlationId: string | undefined;
      try {
        const data = (await this.responseJson(response)) as {
          error?: { code?: unknown; correlationId?: unknown };
        };
        if (isErrorCode(data.error?.code)) code = data.error.code;
        if (
          typeof data.error?.correlationId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            data.error.correlationId,
          )
        )
          correlationId = data.error.correlationId;
      } catch {
        /* Never echo arbitrary upstream bodies/URLs/secrets. */
      }
      throw new OpenContextError(response.status, code, correlationId);
    }
    return (await this.responseJson(response)) as T;
  }
  async readiness(): Promise<ReadinessReport> {
    const result = await this.request<unknown>(
      '/api/readiness',
      undefined,
      503,
    );
    try {
      return parseReadinessReport(result);
    } catch {
      throw new OpenContextError(502, 'INVALID_READINESS_RESPONSE');
    }
  }
  projects(): Promise<Project[]> {
    return this.request(QueryRoutes.projects);
  }
  tree(projectId: string): Promise<FileEntry[]> {
    return this.request(projectQueryPath(QueryRoutes.tree, projectId));
  }
  search(projectId: string, input: SearchInput): Promise<SearchResult> {
    return this.request(projectQueryPath(QueryRoutes.search, projectId), input);
  }
  read(
    projectId: string,
    fileId: string,
    revisionId: string,
  ): Promise<ReadResult> {
    return this.request(
      projectQueryPath(QueryRoutes.read, projectId) +
        '?' +
        new URLSearchParams({ fileId, revisionId }),
    );
  }
}
