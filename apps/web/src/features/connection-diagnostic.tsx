import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plug } from 'lucide-react';
import type { Binding, ConnectionTestResult } from '@opencontext/contracts';
import { api, ApiError, errorText } from '../api/client';
import {
  connectionCodeExplanation,
  connectionResultText,
} from '../lib/connection-test';
import { Button } from '../components/ui/button';
import { Alert, Badge } from '../components/ui/panels';

export function ConnectionDiagnostic({
  binding,
  disabled,
}: {
  binding: Binding;
  disabled: boolean;
}) {
  const current = useRef<AbortController | null>(null);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => () => current.current?.abort(), []);
  const mutation = useMutation({
    // A one-shot diagnostic must fail offline, not queue itself for reconnect.
    networkMode: 'always',
    retry: false,
    mutationFn: async (controller: AbortController) => {
      const result = await api<ConnectionTestResult>(
        `/projects/${encodeURIComponent(binding.projectId)}/bindings/${encodeURIComponent(binding.id)}/test-connection`,
        { method: 'POST', signal: controller.signal },
      );
      // Also reject a response whose body finished after cancellation.
      controller.signal.throwIfAborted();
      return result;
    },
  });
  const result = mutation.data
    ? connectionResultText(mutation.data)
    : undefined;
  const error = mutation.error;
  return (
    <section
      className="mt-4 flex flex-col gap-3"
      aria-label={`连接诊断 ${binding.name}`}
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || mutation.isPending}
          onClick={() => {
            current.current?.abort();
            current.current = new AbortController();
            setCancelled(false);
            mutation.reset();
            mutation.mutate(current.current);
          }}
        >
          <Plug data-icon="inline-start" />
          {mutation.isPending ? '测试中…' : '测试连接'}
        </Button>
        {mutation.isPending ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              current.current?.abort();
              current.current = null;
              mutation.reset();
              setCancelled(true);
            }}
          >
            取消测试
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        只检查指定来源接口，不同步或发布文件。凭据仅由管理员在服务器配置
        secretRef；此处不接收 token。
      </p>
      {cancelled ? (
        <p role="status" className="text-sm">
          已取消等待并清除结果；服务器可能仍在结束只读诊断，不会发布文件。
        </p>
      ) : result && mutation.data ? (
        <div role="status" className="flex flex-col items-start gap-2 text-sm">
          <Badge>{result.status}</Badge>
          <strong>{result.evidence}</strong>
          <p>{result.explanation}</p>
          <p className="break-all font-mono text-xs">{mutation.data.code}</p>
        </div>
      ) : null}
      {error && !cancelled ? (
        <Alert>
          {error instanceof ApiError && connectionCodeExplanation(error.code)
            ? `${connectionCodeExplanation(error.code)} (${error.code})`
            : errorText(error)}
        </Alert>
      ) : null}
    </section>
  );
}
