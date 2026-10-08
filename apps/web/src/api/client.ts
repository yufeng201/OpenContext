import type { ApiFailure } from '@opencontext/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly correlationId?: string,
  ) {
    super(code);
  }
}

let sessionGeneration = 0;
let onDenied: (() => void) | undefined;

export function resetSessionRequests() {
  sessionGeneration += 1;
}
export function handleAccessDenied(callback: () => void) {
  onDenied = callback;
  return () => {
    onDenied = undefined;
  };
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const generation = sessionGeneration;
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });
  if (generation !== sessionGeneration)
    throw new DOMException('Session changed', 'AbortError');
  if (!response.ok) {
    const failure = (await response
      .json()
      .catch(() => null)) as ApiFailure | null;
    if (generation !== sessionGeneration)
      throw new DOMException('Session changed', 'AbortError');
    if (
      (response.status === 401 || response.status === 403) &&
      path !== '/session'
    )
      onDenied?.();
    throw new ApiError(
      response.status,
      failure?.error?.code ?? 'REQUEST_FAILED',
      failure?.error?.correlationId,
    );
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as T;
  if (generation !== sessionGeneration)
    throw new DOMException('Session changed', 'AbortError');
  return payload;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'IMPORT_CONFLICT')
      return '此同名导出已被其他操作更新。列表已刷新，请重新选择文件并确认后上传；不会自动覆盖。 (IMPORT_CONFLICT)';
    if (error.code === 'BINDING_REVOKED')
      return '此来源已撤销，不能继续同步或加工；如需重新授权，请添加新来源。 (BINDING_REVOKED)';
    const importRecovery: Record<string, string> = {
      PROJECT_SCOPE_MISMATCH:
        '导出文件的 projectScope 与此来源配置不一致。请选择匹配的导出，或新建正确 scope 的来源；不要修改正文伪装项目归属。',
      INVALID_SESSION:
        '此文件不是当前来源支持的 versioned Session JSON。请检查 Codex/Claude 来源类型并选择对应的完整导出。',
      PARTIAL_SESSION:
        '导出不完整，未保存输入。请重新选择已结束且完整的会话导出；不要仅修改 complete 声明。',
      UNSUPPORTED_SESSION_CONTENT:
        '导出包含当前适配器不支持的内容，未保存输入。请查看 Session 导入格式说明，不要删事件后冒称完整。',
    };
    if (importRecovery[error.code])
      return `${importRecovery[error.code]} (${error.code}${error.correlationId ? ` · ${error.correlationId}` : ''})`;
    const explanations: Record<number, string> = {
      400: '输入未通过服务器校验，请检查字段。',
      401: '凭据无效或会话已过期，请重新连接。',
      403: '当前会话没有操作权限，已清除本地内容缓存。',
      404: '文件、版本或来源不可用，请刷新后重试。',
      409: '内容已变化或已有任务执行中，请刷新后重试。',
      413: '内容超过当前切片的处理上限。',
      429: '请求过于频繁，请稍后重试。',
    };
    const text =
      explanations[error.status] ??
      '服务器未能完成请求，请查看任务记录后重试。';
    return `${text} (${error.code}${error.correlationId ? ` · ${error.correlationId}` : ''})`;
  }
  return '无法连接服务器，请检查服务状态后重试。';
}
