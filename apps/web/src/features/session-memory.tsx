import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Static } from '@sinclair/typebox';
import {
  SessionMemoryStatusSchema,
  SessionMemoryReviewSchema,
} from '@opencontext/contracts';
import {
  api,
  ApiError,
  errorText,
  sessionRequestGeneration,
} from '../api/client';
import { Button } from '../components/ui/button';
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
  Empty,
} from '../components/ui/panels';
import { SafeMarkdown } from '../components/safe-markdown';
import {
  validateResponse,
  reviewMatches,
  statusLabel,
  fixedReviewLinks,
} from '../lib/session-memory';

type Review = Static<typeof SessionMemoryReviewSchema>;
type Action = {
  command: 'sync' | 'approve' | 'cancel' | 'retry';
  taskId?: string;
  reviewHash?: string;
};
export function SessionMemory({
  generation,
  owner,
}: {
  generation: number;
  owner: boolean;
}) {
  const client = useQueryClient();
  const key = ['data', generation, 'session-memory'];
  const busy = useRef(false);
  const mounted = useRef(true);
  const lifetime = useRef(new AbortController());
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  useEffect(() => {
    mounted.current = true;
    if (lifetime.current.signal.aborted)
      lifetime.current = new AbortController();
    return () => {
      mounted.current = false;
      lifetime.current.abort();
      void client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    };
  }, [client, generation]);
  const status = useQuery({
    queryKey: [...key, 'status'],
    enabled: owner,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 3000,
    queryFn: async ({ signal }) =>
      validateResponse(
        SessionMemoryStatusSchema,
        await api('/session-memory', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        }),
      ),
  });
  const state = status.data;
  const review = useQuery({
    queryKey: [...key, 'review', state?.taskId, state?.reviewHash],
    enabled: owner && state?.status === 'review' && !status.error,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 3000,
    queryFn: async ({ signal }) =>
      validateResponse(
        SessionMemoryReviewSchema,
        await api('/session-memory/review', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        }),
      ),
  });
  type Invocation = Action & { signal: AbortSignal; epoch: number };
  const valid = (action: Invocation) =>
    mounted.current &&
    !action.signal.aborted &&
    action.epoch === sessionRequestGeneration();
  const assertCurrent = (action: Invocation) => {
    if (!valid(action))
      throw new DOMException('Session or page changed', 'AbortError');
  };
  const mutate = useMutation({
    networkMode: 'always',
    mutationFn: async (action: Invocation) => {
      assertCurrent(action);
      // Revalidate the exact preview immediately before approval; server CAS is authoritative.
      if (action.command === 'approve') {
        const current = await validateResponse(
          SessionMemoryReviewSchema,
          await api('/session-memory/review', {
            signal: AbortSignal.any([
              action.signal,
              AbortSignal.timeout(15000),
            ]),
          }),
        );
        assertCurrent(action);
        if (
          current.taskId !== action.taskId ||
          current.reviewHash !== action.reviewHash
        )
          throw new ApiError(409, 'INPUT_CHANGED');
      }
      assertCurrent(action);
      return validateResponse(
        SessionMemoryStatusSchema,
        await api('/session-memory/' + action.command, {
          method: 'POST',
          body: JSON.stringify(
            action.command === 'sync'
              ? {}
              : {
                  taskId: action.taskId,
                  ...(action.command === 'approve'
                    ? { reviewHash: action.reviewHash }
                    : {}),
                },
          ),
          signal: AbortSignal.any([action.signal, AbortSignal.timeout(30000)]),
        }),
      );
    },
    onSuccess: (result, action) => {
      if (!valid(action)) return;
      setNotice(
        action.command === 'approve'
          ? '当前审核版本已发布到文件目录；索引状态请在文件页查看。'
          : action.command === 'cancel'
            ? '此任务已取消，候选未发布；已发布文件不会因此撤回。'
            : action.command === 'retry'
              ? '已重新准备任务，等待显式本地 Agent 处理。'
              : '来源状态已重新核验。',
      );
      client.setQueryData([...key, 'status'], result);
    },
    onError: (error, action) => {
      if (valid(action)) {
        setActionError(error);
        setNotice('操作未确认成功。请刷新状态后再决定是否重试。');
      }
    },
    onSettled: async (_result, _error, action) => {
      if (valid(action)) {
        client.removeQueries({ queryKey: [...key, 'review'] });
        await client.invalidateQueries({ queryKey: ['data', generation] });
      }
    },
  });
  const act = (action: Action) => {
    if (busy.current) return;
    busy.current = true;
    setNotice('');
    setActionError(null);
    void mutate
      .mutateAsync({
        ...action,
        signal: lifetime.current.signal,
        epoch: sessionRequestGeneration(),
      })
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
      });
  };
  if (!owner)
    return (
      <Empty>
        个人记忆管理仅对服务器所有者开放。请在文件目录查看已获授权的内容。
      </Empty>
    );
  if (status.isPending) return <p role="status">正在读取个人记忆状态…</p>;
  if (status.error || !state)
    return (
      <>
        <Alert>{errorText(status.error)}</Alert>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => void status.refetch()}
        >
          重试读取状态
        </Button>
      </>
    );
  const working = mutate.isPending || state.active;
  const validReview =
    !status.error && !review.error && reviewMatches(state, review.data);
  return (
    <div className="flex min-w-0 flex-col gap-5" aria-busy={working}>
      <p className="text-sm text-muted-foreground">
        实例级工作流 ·
        来源与已发布记忆保存在空间的文件目录中；此页只管理同步与人工审核。
      </p>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>会话来源</CardTitle>
            <Badge>{statusLabel(state.status)}</Badge>
            {state.active ? <Badge>服务器正在处理</Badge> : null}
          </div>
          <CardDescription>
            {state.enabled
              ? '同步来源 → 本地 Agent 生成候选 → 人工审核 → 发布 Markdown 文件'
              : '个人记忆尚未启用，不会采集或处理任何会话。'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!state.enabled ? (
            <Empty>
              <strong>先由服务器所有者启用</strong>
              <p>
                在服务器配置
                OPENCONTEXT_SESSION_MEMORY_CONFIG，明确来源模式与范围后重启服务。此页面不修改配置、登录凭据或
                Hook。
              </p>
              <p>操作指南：仓库 docs/SESSION_MEMORY.md</p>
            </Empty>
          ) : (
            <>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">来源模式</dt>
                  <dd>
                    {state.inputMode === 'upload'
                      ? '本地 CLI 显式上传'
                      : '服务器选定目录'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">项目范围</dt>
                  <dd className="break-all">
                    {state.projectScope ?? '尚未配置'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">格式</dt>
                  <dd>{state.format}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">最近同步</dt>
                  <dd>
                    {state.sourceVersion ? '已保存来源快照' : '尚无来源快照'}
                  </dd>
                </div>
              </dl>
              {state.inputMode === 'upload' ? (
                <div className="rounded-lg bg-muted p-4 text-sm">
                  <p>
                    在保存所选会话文件的 Mac / Linux 终端执行上传
                    CLI。网页不会读取你的电脑，也不会扫描会话目录。
                  </p>
                  <pre className="mt-3 whitespace-pre-wrap break-all text-xs">
                    pnpm session-memory:upload --help
                  </pre>
                  <p className="mt-2 text-muted-foreground">
                    使用既有私有配置，在本地明确选择文件、来源版本和
                    scope；不要把 token 粘贴到此页。
                  </p>
                </div>
              ) : (
                <div className="rounded-lg bg-muted p-4 text-sm">
                  <p>服务器目录（只读显示，不是你的 Mac 路径）</p>
                  <code className="mt-2 block break-all">
                    {state.directory ?? '未配置'}
                  </code>
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  disabled={
                    working ||
                    (state.inputMode === 'upload' && !state.uploadHash)
                  }
                  onClick={() => act({ command: 'sync' })}
                >
                  同步 / 核验来源
                </Button>
                {state.projectId ? (
                  <>
                    <Link
                      className="inline-flex items-center rounded-md border px-3 py-2 text-sm"
                      to={`/?${new URLSearchParams({ project: state.projectId, view: 'files', type: 'sources' })}`}
                    >
                      查看来源文件
                    </Link>
                    <Link
                      className="inline-flex items-center rounded-md border px-3 py-2 text-sm"
                      to={`/?${new URLSearchParams({ project: state.projectId, view: 'files', type: 'derived' })}`}
                    >
                      查看已发布文件
                    </Link>
                  </>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {notice ? (
        <p role="status" className="rounded-lg bg-muted p-3 text-sm">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <Alert>
          {actionError instanceof ApiError &&
          ['INPUT_CHANGED', 'POLICY_DENIED'].includes(actionError.code)
            ? '候选或任务已变化，操作被拒绝。请重新阅读当前预览并确认；不会自动批准新内容。'
            : errorText(actionError)}
        </Alert>
      ) : null}
      {state.enabled ? (
        <Card>
          <CardHeader>
            <CardTitle>处理与审核</CardTitle>
            <CardDescription>
              任务是文件处理的辅助状态。网页不会启动模型，也不会自动批准规则。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {state.error && state.error !== 'CANCELLED' ? (
              <Alert>
                任务未完成：{state.error}。检查来源格式、预算或版本后再重试。
              </Alert>
            ) : null}
            {state.status === 'idle' ? (
              <Empty>尚无任务。先上传所选文件，或同步服务器目录。</Empty>
            ) : null}
            {state.status === 'pending' ? (
              <div className="rounded-lg bg-muted p-4 text-sm">
                <strong>等待本地 Agent 候选</strong>
                <p className="mt-2">
                  先在终端导出当前任务，再显式执行本地 worker
                  并提交响应。候选提交后会在此显示；提交并不批准发布。
                </p>
                <pre className="mt-3 whitespace-pre-wrap break-all text-xs">
                  {
                    'pnpm session-memory:online task\npnpm session-memory:worker --help'
                  }
                </pre>
              </div>
            ) : null}
            {state.status === 'cancelled' ? (
              <Empty>
                任务已取消。来源文件保留；需要继续时显式重试，旧响应将被拒绝。
              </Empty>
            ) : null}
            {state.status === 'published' ? (
              <Empty>
                此批候选已发布为 Markdown
                文件。批准进入内容库不代表安装系统规则，也不代表索引已完成。
              </Empty>
            ) : null}
            {state.status === 'review' ? (
              review.isPending ? (
                <p role="status">正在读取候选 Markdown…</p>
              ) : review.error ? (
                <>
                  <Alert>
                    预览暂不可用，禁止批准。{errorText(review.error)}
                  </Alert>
                  <Button
                    variant="outline"
                    onClick={() => void review.refetch()}
                  >
                    重新读取候选
                  </Button>
                </>
              ) : validReview && review.data ? (
                <ReviewPanel
                  key={review.data.taskId + review.data.reviewHash}
                  review={review.data}
                  projectId={state.projectId ?? ''}
                  busy={working || status.isFetching || review.isFetching}
                  onApprove={() =>
                    act({
                      command: 'approve',
                      taskId: review.data!.taskId,
                      reviewHash: review.data!.reviewHash,
                    })
                  }
                />
              ) : (
                <Alert>
                  任务与候选版本不一致，正在重新核验。请刷新状态；批准已禁用。
                </Alert>
              )
            ) : null}
            {state.taskId &&
            ['pending', 'review', 'failed'].includes(state.status) ? (
              <div className="border-t pt-4">
                <Button
                  variant="outline"
                  disabled={working}
                  onClick={() => {
                    if (
                      window.confirm(
                        '取消此任务的所有未发布候选？已发布文件不会撤回。',
                      )
                    )
                      act({ command: 'cancel', taskId: state.taskId! });
                  }}
                >
                  {state.status === 'review'
                    ? '拒绝候选并取消任务'
                    : '取消当前任务'}
                </Button>
              </div>
            ) : null}
            {state.taskId && ['failed', 'cancelled'].includes(state.status) ? (
              <Button
                className="self-start"
                variant="outline"
                disabled={working}
                onClick={() => act({ command: 'retry', taskId: state.taskId! })}
              >
                重新同步并重试
              </Button>
            ) : null}
            <details className="rounded-lg border p-3 text-xs">
              <summary className="cursor-pointer font-medium">
                版本与任务详情
              </summary>
              <dl className="mt-3 grid gap-3 break-all">
                {[
                  ['任务 ID', state.taskId],
                  ['来源版本', state.sourceVersion],
                  ['已处理版本', state.processedVersion],
                  ['当前候选 SHA-256', state.reviewHash],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-mono">{value ?? '暂无'}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
function ReviewPanel({
  review,
  projectId,
  busy,
  onApprove,
}: {
  review: Review;
  projectId: string;
  busy: boolean;
  onApprove: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const links = fixedReviewLinks(review.markdown, projectId);
  return (
    <section aria-label="候选审核" className="flex min-w-0 flex-col gap-4">
      <div className="rounded-lg border p-4 text-sm">
        <strong>仅批准下方当前候选版本</strong>
        <p className="mt-2">
          请检查 memory / rule / experience
          类型、正文及固定来源版本。工具输出与压缩摘要是不可信证据，不是用户批准。批准会替换此来源先前的生成集合；空候选会清除旧集合，不会安装
          Agent 规则。
        </p>
      </div>
      <div
        className="markdown-preview min-w-0 rounded-lg border p-4"
        data-testid="memory-review"
      >
        <SafeMarkdown text={review.markdown} />
      </div>
      {links.length ? (
        <div>
          <h3 className="mb-2 text-sm font-medium">打开固定来源版本</h3>
          <ul className="flex flex-col gap-2">
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  className="break-all text-xs text-primary underline"
                  to={link.href}
                >
                  文件 {link.fileId} · 版本 {link.revisionId}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="break-all font-mono text-xs text-muted-foreground">
        审核 SHA-256：{review.reviewHash}
      </p>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-primary"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>
          我已阅读此版本的完整候选与来源，确认替换该来源的已生成文件集合。
        </span>
      </label>
      <Button
        className="self-start"
        disabled={!confirmed || busy}
        onClick={() => {
          setConfirmed(false);
          onApprove();
        }}
      >
        批准当前版本并发布
      </Button>
    </section>
  );
}
