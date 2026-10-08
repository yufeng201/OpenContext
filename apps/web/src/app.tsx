import type { ReadOptions } from '@opencontext/contracts';
import { markdownBlocks } from './lib/markdown';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import {
  FileText,
  FolderGit2,
  Layers3,
  Database,
  Puzzle,
  X,
  LogOut,
  RefreshCw,
  Search,
  Workflow,
  ArrowUpRight,
  Copy,
  Check,
} from 'lucide-react';
import {
  CreateProjectSchema,
  LoginSchema,
  SearchSchema,
} from '@opencontext/contracts';
import type {
  Principal,
  Project,
  Binding,
  Run,
  FileEntry,
  SearchInput,
  SearchResult,
  ReadResult,
  PluginDescriptor,
} from '@opencontext/contracts';
import {
  api,
  ApiError,
  errorText,
  handleAccessDenied,
  resetSessionRequests,
} from './api/client';
import { validateForm } from './api/forms';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from './components/ui/field';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
} from './components/ui/panels';
import { cn } from './lib/utils';
import { runLabel } from './lib/binding-run';
import { BindingRow, CreateBinding } from './features/source-plugins';
import {
  DirectoryTree,
  FileBrowser,
  parentPath,
  baseName,
  ownershipLabel,
} from './features/file-browser';
import {
  isLocallyDisconnected,
  setLocallyDisconnected,
} from './lib/session-lock';

type Session = Pick<Principal, 'role' | 'projectId'>;
const views = [
  { id: 'files', label: '文件', icon: FileText },
  { id: 'sources', label: '数据源', icon: Database },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'search', label: '搜索', icon: Search },
  { id: 'runs', label: '任务', icon: Workflow },
] as const;
const selectClass =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
const short = (value: string | null) =>
  value ? value.slice(0, 12) : '尚未发布';

export function App() {
  const client = useQueryClient();
  const [generation, setGeneration] = useState(0);
  const [accessMessage, setAccessMessage] = useState(() =>
    isLocallyDisconnected()
      ? '此标签页已断开。重新输入 token 后才会连接。'
      : '',
  );
  const [disconnecting, setDisconnecting] = useState(false);
  const session = useQuery({
    queryKey: ['session', generation],
    // Local disconnection must resolve even while the browser is offline.
    networkMode: 'always',
    queryFn: async ({ signal }) => {
      if (isLocallyDisconnected()) return null;
      try {
        return await api<Session>('/session', { signal });
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          resetSessionRequests();
          void client.cancelQueries({ queryKey: ['data'] });
          client.removeQueries({ queryKey: ['data'] });
          return null;
        }
        throw error;
      }
    },
  });
  const clearSession = () => {
    resetSessionRequests();
    void client.cancelQueries();
    client.clear();
    setGeneration((value) => value + 1);
  };
  const disconnect = () => {
    // Do not let an offline/paused mutation retain private content on screen.
    setLocallyDisconnected(true);
    setAccessMessage('本地内容已清除，正在清理此浏览器的会话 cookie…');
    setDisconnecting(true);
    clearSession();
    void api('/session', {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    })
      .then(() => setAccessMessage('已断开连接，并清理此浏览器的会话 cookie。'))
      .catch(() =>
        setAccessMessage(
          '本地内容已清除；服务器无法确认退出，HttpOnly 会话 cookie 可能仍保留。此标签页不会自动重连；恢复网络后可重新连接，或清除此站点的 cookie。',
        ),
      )
      .finally(() => setDisconnecting(false));
  };
  useEffect(
    () =>
      handleAccessDenied(() => {
        setAccessMessage('访问权限已变化，缓存已清除，请重新连接。');
        resetSessionRequests();
        void client.cancelQueries();
        client.clear();
        client.setQueryData(['session', generation], null);
      }),
    [client, generation],
  );
  if (session.isPending)
    return (
      <div className="p-8 text-sm text-muted-foreground" role="status">
        正在连接 OpenContext…
      </div>
    );
  if (session.error)
    return (
      <div className="mx-auto max-w-lg p-8">
        <Alert>{errorText(session.error)}</Alert>
        <Button className="mt-4" onClick={() => void session.refetch()}>
          重试连接
        </Button>
      </div>
    );
  if (!session.data)
    return (
      <Login
        message={accessMessage}
        disconnecting={disconnecting}
        onConnected={() => {
          setLocallyDisconnected(false);
          setAccessMessage('');
          clearSession();
        }}
      />
    );
  return (
    <Workspace
      key={generation}
      session={session.data}
      generation={generation}
      onLogout={disconnect}
    />
  );
}

function Login({
  message,
  disconnecting,
  onConnected,
}: {
  message: string;
  disconnecting: boolean;
  onConnected: () => void;
}) {
  const form = useForm<{ token: string }>({ defaultValues: { token: '' } });
  const login = useMutation({
    mutationFn: (values: { token: string }) =>
      api<Session>('/session', {
        method: 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      form.reset();
      onConnected();
    },
  });
  return (
    <main className="flex min-h-screen items-center justify-center p-5">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Layers3 />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              OpenContext
            </h1>
            <p className="text-xs text-muted-foreground">
              你的文件，持久的上下文。
            </p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>连接你的上下文空间</CardTitle>
            <CardDescription>
              使用服务器提供的 owner 或项目查询 token 建立会话。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={form.handleSubmit(async (values) => {
                if (await validateForm(LoginSchema, values, form.setError))
                  login.mutate(values);
              })}
            >
              <FieldGroup>
                <Field data-invalid={Boolean(form.formState.errors.token)}>
                  <FieldLabel htmlFor="token">访问 token</FieldLabel>
                  <Input
                    id="token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(form.formState.errors.token)}
                    {...form.register('token')}
                  />
                  <FieldDescription>
                    {form.formState.errors.token?.message ??
                      '仅用于建立会话，不写入浏览器本地存储。'}
                  </FieldDescription>
                </Field>
                {message ? <Alert>{message}</Alert> : null}
                {login.error ? <Alert>{errorText(login.error)}</Alert> : null}
                <Button
                  type="submit"
                  disabled={login.isPending || disconnecting}
                >
                  {login.isPending ? '正在连接…' : '连接空间'}
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <p className="text-xs leading-relaxed text-muted-foreground">
          单节点自托管 · 全文与 grep 即可开始 · 不需要向量模型或本地设备
        </p>
      </div>
    </main>
  );
}

function Workspace({
  session,
  generation,
  onLogout,
}: {
  session: Session;
  generation: number;
  onLogout: () => void;
}) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? '';
  const [sourceDrawer, setSourceDrawer] = useState(false);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const requestedView = params.get('view') ?? 'files';
  const view = views.some((item) => item.id === requestedView)
    ? requestedView
    : 'files';
  const scope = ['data', generation, projectId] as const;
  const projects = useQuery({
    queryKey: ['data', generation, 'projects'],
    queryFn: ({ signal }) => api<Project[]>('/projects', { signal }),
    refetchInterval: 10_000,
  });
  const plugins = useQuery({
    queryKey: ['data', generation, 'plugins'],
    enabled: session.role === 'owner',
    queryFn: ({ signal }) => api<PluginDescriptor[]>('/plugins', { signal }),
  });
  const project = projects.data?.find((entry) => entry.id === projectId);
  useEffect(() => {
    if (!projectId && projects.data?.[0])
      setParams(
        { project: projects.data[0].id, view: 'files' },
        { replace: true },
      );
  }, [projectId, projects.data, setParams]);
  const bindings = useQuery({
    queryKey: [...scope, 'bindings'],
    enabled: Boolean(project),
    queryFn: ({ signal }) =>
      api<Binding[]>(`/projects/${encodeURIComponent(projectId)}/bindings`, {
        signal,
      }),
    refetchInterval: 5000,
  });
  const runs = useQuery({
    queryKey: [...scope, 'runs'],
    enabled: Boolean(project),
    queryFn: ({ signal }) =>
      api<Run[]>(`/projects/${encodeURIComponent(projectId)}/runs`, { signal }),
    refetchInterval: 3000,
  });
  const tree = useQuery({
    queryKey: [...scope, 'tree'],
    enabled: Boolean(project),
    queryFn: ({ signal }) =>
      api<FileEntry[]>(`/projects/${encodeURIComponent(projectId)}/tree`, {
        signal,
      }),
    refetchInterval: 5000,
  });
  const publishedCommit = runs.data?.find(
    (run) => run.state === 'published',
  )?.resultCommit;
  useEffect(() => {
    if (!publishedCommit) return;
    void client.invalidateQueries({
      queryKey: ['data', generation, 'projects'],
    });
    void client.invalidateQueries({
      queryKey: ['data', generation, projectId, 'tree'],
    });
    void client.invalidateQueries({
      queryKey: ['data', generation, projectId, 'search'],
    });
  }, [client, generation, projectId, publishedCommit]);
  const invalidate = () =>
    client.invalidateQueries({ queryKey: ['data', generation] });
  const navigate = (next: Record<string, string>) =>
    setParams({
      ...Object.fromEntries(params),
      project: projectId,
      view,
      ...next,
    });
  const queryFailure =
    projects.error ??
    plugins.error ??
    bindings.error ??
    runs.error ??
    tree.error;
  const files = tree.data?.filter((file) => !file.tombstone) ?? [];
  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <Link to="/" className="brand-link">
          <Layers3 className="size-6" />
          OpenContext
        </Link>
        <Field>
          <FieldLabel htmlFor="project-select">当前空间</FieldLabel>
          <select
            id="project-select"
            className={selectClass}
            value={projectId}
            onChange={(event) => {
              setSourceDrawer(false);
              setParams({ project: event.target.value, view: 'files' });
            }}
          >
            <option value="" disabled>
              选择空间
            </option>
            {projects.data?.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>
        {project ? (
          <DirectoryTree
            key={projectId}
            files={files}
            projectId={projectId}
            current={
              view === 'files'
                ? (params.get('dir') ??
                  parentPath(
                    files.find((file) => file.fileId === params.get('file'))
                      ?.logicalPath ?? '',
                  ))
                : '\0'
            }
            onNavigate={(path) =>
              setParams({
                project: projectId,
                view: 'files',
                ...(path ? { dir: path } : {}),
              })
            }
          />
        ) : null}
        <nav aria-label="主要导航" className="auxiliary-navigation">
          {views.map(({ id, label, icon: Icon }) => (
            <Link
              key={id}
              to={`/?${new URLSearchParams({ project: projectId, view: id })}`}
              aria-current={view === id ? 'page' : undefined}
              className={cn(
                'flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm lg:justify-start',
                view === id
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <Icon className="hidden size-4 sm:block" />
              {label}
            </Link>
          ))}
        </nav>
        {session.role === 'owner' && project ? (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">新建空间</summary>
            <div className="mt-4">
              <CreateProject
                onCreated={(entry) => {
                  void invalidate();
                  setParams({ project: entry.id, view: 'files' });
                }}
              />
            </div>
          </details>
        ) : null}
        <div className="hidden grow lg:block" />
        <div className="flex items-center justify-between gap-2 lg:flex-col lg:items-start">
          <Badge>{session.role === 'owner' ? '所有者' : '项目只读'}</Badge>
          <Button variant="ghost" size="sm" onClick={onLogout}>
            <LogOut />
            退出连接
          </Button>
        </div>
      </aside>
      <main className={cn('workspace-main', view === 'files' && 'file-main')}>
        {view !== 'files' ? (
          <header className="page-header">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                {project?.name ?? '开始使用'}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                {views.find((item) => item.id === view)?.label}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                来源和加工产物，在同一空间按版本查阅。
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void invalidate()}
            >
              <RefreshCw />
              刷新状态
            </Button>
          </header>
        ) : null}
        {queryFailure ? (
          <Alert className="mb-5">{errorText(queryFailure)}</Alert>
        ) : null}
        {projects.isPending ? <p role="status">正在读取空间…</p> : null}
        {!projects.isPending && !project ? (
          <Card>
            <CardHeader>
              <CardTitle>
                {projectId ? '空间不可用' : '创建第一个空间'}
              </CardTitle>
              <CardDescription>
                每个空间独立管理来源与检索范围。当前访问不会自动跨空间搜索。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {session.role === 'owner' ? (
                <CreateProject
                  onCreated={(entry) => {
                    void invalidate();
                    setParams({ project: entry.id, view: 'files' });
                  }}
                />
              ) : (
                <Empty>暂无可访问的空间，请联系服务器所有者。</Empty>
              )}
            </CardContent>
          </Card>
        ) : null}
        {project ? (
          <>
            {view === 'sources' ? (
              <section className="source-page">
                <div className="section-toolbar">
                  <div>
                    <h2>已配置来源</h2>
                    <p>插件将原文和加工产出发布到工作区。</p>
                  </div>
                  {session.role === 'owner' ? (
                    <Button onClick={() => setSourceDrawer(true)}>
                      新增数据源
                    </Button>
                  ) : null}
                </div>
                {bindings.isPending ? (
                  <p role="status">正在读取来源…</p>
                ) : bindings.data?.length ? (
                  <div className="source-list">
                    {bindings.data.map((binding) => (
                      <BindingRow
                        key={binding.id}
                        binding={binding}
                        runs={runs.data ?? []}
                        owner={session.role === 'owner'}
                        plugins={plugins.data ?? []}
                        scope={scope}
                        onChanged={invalidate}
                      />
                    ))}
                  </div>
                ) : (
                  <Empty>
                    <FolderGit2 className="size-6" />
                    <strong>还没有来源</strong>
                    <p>添加 Git、会话导出或飞书群来源，然后同步文件。</p>
                  </Empty>
                )}
                <p className="source-footer">
                  head {short(project.head)} · {files.length} 个当前文件 ·
                  自托管
                </p>
              </section>
            ) : null}
            {view === 'plugins' ? (
              <section className="plugin-page">
                <h2>已安装插件</h2>
                <p>数据源与处理能力由本机已注册插件提供。</p>
                {session.role !== 'owner' ? (
                  <Empty>项目只读访问不提供插件配置。</Empty>
                ) : plugins.isPending ? (
                  <p role="status">正在读取插件…</p>
                ) : (
                  <div className="plugin-list">
                    {plugins.data?.map((plugin) => (
                      <Card key={plugin.packageRef}>
                        <CardHeader>
                          <CardTitle>{plugin.title}</CardTitle>
                          <CardDescription>{plugin.packageRef}</CardDescription>
                        </CardHeader>
                      </Card>
                    ))}
                  </div>
                )}
              </section>
            ) : null}
            {sourceDrawer && project && session.role === 'owner' ? (
              <SourceDialog onClose={() => setSourceDrawer(false)}>
                <CreateBinding
                  key={projectId}
                  projectId={projectId}
                  plugins={plugins.data ?? []}
                  onCreated={() => {
                    if (activeProject.current === projectId) {
                      setSourceDrawer(false);
                      setParams({ project: projectId, view: 'sources' });
                    }
                    return client.invalidateQueries({
                      queryKey: [...scope, 'bindings'],
                    });
                  }}
                />
              </SourceDialog>
            ) : null}
            {view === 'files' ? (
              <FileBrowser
                files={files}
                loading={tree.isPending}
                onRefresh={() => void invalidate()}
                onAddSource={
                  session.role === 'owner' && bindings.data?.length === 0
                    ? () => setSourceDrawer(true)
                    : undefined
                }
                onOpen={(file) =>
                  navigate({
                    dir: parentPath(file.logicalPath),
                    file: file.fileId,
                    revision: file.revisionId,
                  })
                }
              >
                {params.get('file') && params.get('revision') ? (
                  <Reader
                    key={`${projectId}:${params.get('file')}:${params.get('revision')}`}
                    projectId={projectId}
                    fileId={params.get('file')!}
                    revisionId={params.get('revision')!}
                    scope={scope}
                    onClose={() => {
                      const next = new URLSearchParams(params);
                      next.delete('file');
                      next.delete('revision');
                      setParams(next);
                    }}
                  />
                ) : null}
              </FileBrowser>
            ) : null}
            {view === 'search' ? (
              <SearchPanel
                key={projectId}
                projectId={projectId}
                scope={scope}
                files={files}
                onOpen={(file) =>
                  navigate({
                    view: 'files',
                    dir: parentPath(file.logicalPath),
                    file: file.fileId,
                    revision: file.revisionId,
                    q: params.get('q') ?? '',
                    mode: params.get('mode') ?? 'fts',
                    freshness: params.get('freshness') ?? 'current_only',
                  })
                }
              />
            ) : null}
            {view === 'runs' ? (
              <Card>
                <CardHeader>
                  <CardTitle>运行记录</CardTitle>
                  <CardDescription>
                    定期刷新服务器状态。内容发布与索引覆盖分别验证。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {runs.isPending ? (
                    <p role="status">正在读取任务…</p>
                  ) : runs.data?.length ? (
                    <div className="flex flex-col divide-y">
                      {runs.data.map((run) => (
                        <RunRow
                          key={run.id}
                          run={run}
                          plugins={plugins.data ?? []}
                          binding={bindings.data?.find(
                            (binding) => binding.id === run.bindingId,
                          )}
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty>尚未执行任务。在来源中同步或生成导航。</Empty>
                  )}
                </CardContent>
              </Card>
            ) : null}
            {view !== 'files' &&
            params.get('file') &&
            params.get('revision') ? (
              <Reader
                key={`${projectId}:${params.get('file')}:${params.get('revision')}`}
                projectId={projectId}
                fileId={params.get('file')!}
                revisionId={params.get('revision')!}
                scope={scope}
                onClose={() => {
                  const next = new URLSearchParams(params);
                  next.delete('file');
                  next.delete('revision');
                  setParams(next);
                }}
              />
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

function SourceDialog({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="source-dialog"
      aria-labelledby="source-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        dialog.current?.close();
      }}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id="source-dialog-title">添加来源</h2>
          <p>选择来源插件，配置同步与处理能力。</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="关闭添加来源"
        >
          <X />
        </Button>
      </div>
      {children}
    </dialog>
  );
}

function CreateProject({
  onCreated,
}: {
  onCreated: (project: Project) => void;
}) {
  const form = useForm<{ name: string }>({ defaultValues: { name: '' } });
  const mutation = useMutation({
    mutationFn: (values: { name: string }) =>
      api<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: (project) => {
      form.reset();
      onCreated(project);
    },
  });
  return (
    <form
      onSubmit={form.handleSubmit(async (values) => {
        if (await validateForm(CreateProjectSchema, values, form.setError))
          mutation.mutate(values);
      })}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(form.formState.errors.name)}>
          <FieldLabel htmlFor="project-name">空间名称</FieldLabel>
          <Input
            id="project-name"
            placeholder="例如：产品研发"
            aria-invalid={Boolean(form.formState.errors.name)}
            {...form.register('name')}
          />
          {form.formState.errors.name ? (
            <FieldDescription>
              {form.formState.errors.name.message}
            </FieldDescription>
          ) : null}
        </Field>
        {mutation.error ? <Alert>{errorText(mutation.error)}</Alert> : null}
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? '创建中…' : '创建空间'}
        </Button>
      </FieldGroup>
    </form>
  );
}

function FileRow({ file, onOpen }: { file: FileEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
    >
      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="break-all text-sm font-medium">
          {file.logicalPath}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          rev {short(file.revisionId)} · {file.bytes} bytes
        </span>
      </span>
      <Badge>
        {file.collection === 'sources'
          ? '原文'
          : file.collection === 'derived'
            ? '产物'
            : '人工'}
      </Badge>
      {file.freshness !== 'fresh' ? (
        <Badge>{file.freshness === 'stale' ? '已过期' : '已失效'}</Badge>
      ) : null}
    </button>
  );
}

function SearchPanel({
  projectId,
  scope,
  files,
  onOpen,
}: {
  projectId: string;
  scope: readonly unknown[];
  files: FileEntry[];
  onOpen: (file: FileEntry) => void;
}) {
  const [params, setParams] = useSearchParams();
  const input: SearchInput = {
    query: params.get('q') ?? '',
    mode: params.get('mode') === 'grep' ? 'grep' : 'fts',
    freshness:
      params.get('freshness') === 'include_stale'
        ? 'include_stale'
        : 'current_only',
    limit: 20,
  };
  const form = useForm<SearchInput>({ values: input });
  const result = useQuery({
    queryKey: [...scope, 'search', input],
    queryFn: ({ signal }) =>
      api<SearchResult>(`/projects/${encodeURIComponent(projectId)}/search`, {
        method: 'POST',
        body: JSON.stringify(input),
        signal,
      }),
    enabled: Boolean(input.query),
    refetchInterval: 5000,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>搜索上下文</CardTitle>
        <CardDescription>
          只检索当前空间。先看片段，再读取固定版本原文。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={form.handleSubmit(async (values) => {
            if (await validateForm(SearchSchema, values, form.setError))
              setParams({
                project: projectId,
                view: 'search',
                q: values.query,
                mode: values.mode ?? 'fts',
                freshness: values.freshness ?? 'current_only',
              });
          })}
        >
          <FieldGroup>
            <Field data-invalid={Boolean(form.formState.errors.query)}>
              <FieldLabel htmlFor="search-query">搜索内容</FieldLabel>
              <Input
                id="search-query"
                placeholder="输入术语、函数名或文档关键词"
                aria-invalid={Boolean(form.formState.errors.query)}
                {...form.register('query')}
              />
              {form.formState.errors.query ? (
                <FieldDescription>
                  {form.formState.errors.query.message}
                </FieldDescription>
              ) : null}
            </Field>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <Field className="sm:flex-1">
                <FieldLabel htmlFor="search-mode">检索方式</FieldLabel>
                <select
                  id="search-mode"
                  className={selectClass}
                  {...form.register('mode')}
                >
                  <option value="fts">全文搜索</option>
                  <option value="grep">grep 文本匹配</option>
                </select>
              </Field>
              <Field className="sm:flex-1">
                <FieldLabel htmlFor="freshness">产物新鲜度</FieldLabel>
                <select
                  id="freshness"
                  className={selectClass}
                  {...form.register('freshness')}
                >
                  <option value="current_only">仅当前有效内容</option>
                  <option value="include_stale">同时显示过期产物</option>
                </select>
              </Field>
              <Button type="submit" disabled={result.isFetching}>
                <Search />
                {result.isFetching ? '检索中…' : '搜索'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <div className="mt-6">
          {result.error ? (
            <Alert>{errorText(result.error)}</Alert>
          ) : result.isFetching && !result.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              正在检索…
            </p>
          ) : result.data ? (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge>{result.data.hits.length} 条结果</Badge>
                <Badge>
                  索引{' '}
                  {result.data.indexCoverage === 'ready'
                    ? '已就绪'
                    : '部分覆盖'}
                </Badge>
                {result.data.degraded ? <Badge>已降级</Badge> : null}
              </div>
              <p className="mb-3 break-all font-mono text-xs text-muted-foreground">
                snapshot {short(result.data.servedCommit)}
              </p>
              {result.data.hits.length ? (
                <div className="flex flex-col divide-y">
                  {result.data.hits.map((hit) => (
                    <article
                      key={`${hit.file.fileId}:${hit.file.revisionId}`}
                      className="py-2"
                    >
                      <FileRow
                        file={hit.file}
                        onOpen={() => onOpen(hit.file)}
                      />
                      <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                        {hit.excerpt}
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty>
                  {files.length
                    ? '当前范围没有匹配内容。可尝试 grep、更换关键词或检查来源与索引状态。'
                    : '尚无可查询文件。先在“来源”同步已配置的输入。'}
                </Empty>
              )}
            </>
          ) : (
            <Empty>
              <Search className="size-6" />
              <strong>从一个问题开始</strong>
              <p>来源文件与 Markdown 产物会一起返回，不需要向量服务。</p>
            </Empty>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Reader({
  projectId,
  fileId,
  revisionId,
  scope,
  onClose,
}: {
  projectId: string;
  fileId: string;
  revisionId: string;
  scope: readonly unknown[];
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<ReadOptions>({ maxBytes: 8192 });
  const [outlineLine, setOutlineLine] = useState(1);
  const [copied, setCopied] = useState(false);
  const [readerTab, setReaderTab] = useState('preview');
  const [copyError, setCopyError] = useState(false);
  const read = useQuery({
    queryKey: [...scope, 'read', fileId, revisionId, selection],
    queryFn: async ({ signal }) => {
      try {
        return await api<ReadResult>(
          `/projects/${encodeURIComponent(projectId)}/read?${new URLSearchParams({ fileId, revisionId, ...Object.fromEntries(Object.entries(selection).map(([k, v]) => [k, String(v)])) })}`,
          { signal },
        );
      } catch (error) {
        // A unavailable/revoked reference replaces cached plaintext with null.
        // 401/403 also clear the entire session through the shared API client.
        if (error instanceof ApiError && [401, 403, 404].includes(error.status))
          return null;
        throw error;
      }
    },
    staleTime: 0,
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
  });
  const outline = useQuery({
    queryKey: [...scope, 'outline', fileId, revisionId, outlineLine],
    enabled: Boolean(read.data?.file.logicalPath.toLowerCase().endsWith('.md')),
    queryFn: ({ signal }) =>
      api<ReadResult>(
        `/projects/${encodeURIComponent(projectId)}/read?${new URLSearchParams({ fileId, revisionId, outline: 'true', startLine: String(outlineLine), maxBytes: '4096' })}`,
        { signal },
      ),
    staleTime: 0,
    refetchInterval: 3000,
  });
  return (
    <Card className="file-reader" aria-label="固定版本原文">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="reader-title">
              <FileText />
              <span title={read.data?.file.logicalPath}>
                {read.data
                  ? baseName(read.data.file.logicalPath)
                  : '固定版本原文'}
              </span>
            </CardTitle>
            <CardDescription className="mt-2 break-all">
              {(!read.error && read.data?.file.logicalPath) ||
                '读取指定 revision'}
            </CardDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
        {read.data ? (
          <div className="reader-summary">
            <span className={'file-origin ' + read.data.file.ownership}>
              {ownershipLabel(read.data.file)}
            </span>
            <span>
              {read.data.file.ownership === 'generated'
                ? '只读输出'
                : '固定版本'}{' '}
              ·{' '}
              {read.data.file.freshness === 'fresh'
                ? '有效'
                : read.data.file.freshness === 'stale'
                  ? '已过期'
                  : '已失效'}
            </span>
          </div>
        ) : null}
      </CardHeader>
      <div className="reader-tabs" role="tablist" aria-label="文件详情">
        {[
          ['preview', '预览'],
          ['version', '版本'],
          ['source', '来源'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={readerTab === id}
            onClick={() => setReaderTab(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      <CardContent>
        {read.isPending ? (
          <p role="status">正在读取版本…</p>
        ) : read.error ? (
          <Alert>{errorText(read.error)} 不会自动替换成其他版本。</Alert>
        ) : read.data === null ? (
          <Alert>
            文件、版本或来源不可用；已清除缓存正文，不会自动替换成其他版本。
          </Alert>
        ) : read.data ? (
          <>
            {read.data.file.freshness !== 'fresh' ? (
              <Alert className="mb-4">
                {read.data.file.freshness === 'stale'
                  ? read.data.file.collection === 'sources'
                    ? '正在查看历史来源版本，仅供历史参考；请从文件目录打开最新来源。'
                    : '此产物已过期，仅供历史参考；请从文件目录打开最新产物。'
                  : '此文件已失效。不会自动替换成其他版本。'}
              </Alert>
            ) : null}
            {readerTab === 'preview' ? (
              <>
                <div
                  className="mb-3 flex flex-wrap items-center gap-2 text-xs"
                  role="group"
                  aria-label="渐进式读取"
                >
                  <span>
                    {read.data.disclosure
                      ? `本次 ${read.data.disclosure.returnedBytes} bytes；全文 ${read.data.file.bytes} bytes`
                      : `全文 ${read.data.file.bytes} bytes`}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSelection({ maxBytes: 8192 })}
                  >
                    从头有限读取
                  </Button>
                  {read.data.disclosure?.nextOffsetBytes !== null &&
                  read.data.disclosure?.nextOffsetBytes !== undefined ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setSelection({
                          ...selection,
                          offsetBytes: read.data!.disclosure!.nextOffsetBytes!,
                        })
                      }
                    >
                      读取下一段
                    </Button>
                  ) : null}
                  {read.data.disclosure ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelection({})}
                    >
                      读取全文
                    </Button>
                  ) : null}
                </div>
                {outline.data?.outline ? (
                  <nav
                    aria-label="Markdown 章节目录"
                    className="mb-3 flex flex-wrap gap-2"
                  >
                    {outline.data.outline.map((item) => (
                      <Button
                        key={item.line}
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSelection({
                            startLine: item.line,
                            maxLines: 40,
                            maxBytes: 8192,
                          })
                        }
                      >
                        {item.title} · 第 {item.line} 行
                      </Button>
                    ))}
                    {outline.data.disclosure?.nextOutlineLine ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setOutlineLine(
                            outline.data!.disclosure!.nextOutlineLine!,
                          )
                        }
                      >
                        更多章节
                      </Button>
                    ) : null}
                  </nav>
                ) : null}
                {outline.error ? (
                  <Alert>
                    {errorText(outline.error)}；正文仍可按有限读取查看。
                  </Alert>
                ) : null}
                <div className="markdown-preview">
                  {read.data.file.logicalPath.endsWith('.md') &&
                  !read.data.disclosure?.offsetBytes ? (
                    <SafeMarkdown text={read.data.text} />
                  ) : (
                    <pre>{read.data.text}</pre>
                  )}
                </div>
              </>
            ) : null}
            {readerTab === 'version' ? (
              <div className="version-details">
                <h3>固定版本</h3>
                <p>正在查看固定 revision，不会自动切换为最新版本。</p>
                <dl>
                  <dt>文件 ID</dt>
                  <dd>{read.data.file.fileId}</dd>
                  <dt>revision</dt>
                  <dd>{read.data.file.revisionId}</dd>
                  <dt>commit</dt>
                  <dd>{read.data.citation.commitId}</dd>
                  <dt>source</dt>
                  <dd>{read.data.citation.sourceVersion}</dd>
                  <dt>sha256</dt>
                  <dd>{read.data.citation.contentHash}</dd>
                </dl>
                <p>当前 API 提供精确版本读取，尚未提供历史版本列表。</p>
              </div>
            ) : null}
            {readerTab === 'source' ? (
              <div className="version-details">
                <h3>来源与派生关系</h3>
                <dl>
                  <dt>来源绑定</dt>
                  <dd>{read.data.file.bindingId}</dd>
                  <dt>来源版本</dt>
                  <dd>{read.data.file.sourceVersion}</dd>
                  <dt>所有权</dt>
                  <dd>{read.data.file.ownership}</dd>
                </dl>
                {read.data.file.derivedFrom.length ? (
                  read.data.file.derivedFrom.map((source) => (
                    <Link
                      className="lineage-link"
                      key={source.fileId + source.revisionId}
                      to={`/?${new URLSearchParams({ project: projectId, view: 'files', file: source.fileId, revision: source.revisionId })}`}
                    >
                      原始文件 {source.fileId}
                      <span>revision {source.revisionId}</span>
                    </Link>
                  ))
                ) : (
                  <p>这是来源文件，没有派生输入。</p>
                )}
                <p>按当前空间权限读取；来源撤销后固定引用停止返回正文。</p>
              </div>
            ) : null}
            <dl className="reader-metadata">
              <dt>文件路径</dt>
              <dd>{read.data.file.logicalPath}</dd>
              <dt>文件大小</dt>
              <dd>{read.data.file.bytes} bytes</dd>
              <dt>修改时间</dt>
              <dd>
                {new Date(read.data.file.createdAt).toLocaleString('zh-CN')}
              </dd>
              <dt>固定版本</dt>
              <dd>rev {short(read.data.file.revisionId)}</dd>
            </dl>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const citation = read.data!.citation;
                if (!navigator.clipboard) {
                  setCopyError(true);
                  return;
                }
                void navigator.clipboard
                  .writeText(
                    `${citation.uri}\ncommit: ${citation.commitId}\npath: ${citation.path}\nsource: ${citation.sourceVersion}\nsha256: ${citation.contentHash}`,
                  )
                  .then(() => {
                    setCopied(true);
                    setCopyError(false);
                  })
                  .catch(() => {
                    setCopyError(true);
                  });
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? '引用已复制' : '复制固定引用'}
            </Button>
            {copyError ? (
              <Alert className="mt-3">
                浏览器未允许复制，请手动选择下方引用。
              </Alert>
            ) : null}
            <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
              {read.data.citation.uri}
            </p>
            <details className="raw-text">
              <summary>
                {read.data.disclosure ? '查看本次返回文本' : '查看原始文本'}
              </summary>
              <pre>{read.data.text}</pre>
            </details>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SafeMarkdown({ text }: { text: string }) {
  // Deliberately support only inert text structure: no raw HTML, URL, or executable content.
  return (
    <>
      {markdownBlocks(text).map((block, index) => {
        const line = block.text;
        if (block.kind === 'code')
          return (
            <pre key={index}>
              <code>{line}</code>
            </pre>
          );
        if (line.startsWith('### '))
          return <h4 key={index}>{line.slice(4)}</h4>;
        if (line.startsWith('## ')) return <h3 key={index}>{line.slice(3)}</h3>;
        if (line.startsWith('# ')) return <h2 key={index}>{line.slice(2)}</h2>;
        if (/^[-*] /.test(line))
          return (
            <p className="markdown-list" key={index}>
              • {line.slice(2)}
            </p>
          );
        return line ? (
          <p key={index}>{line}</p>
        ) : (
          <div className="markdown-space" key={index} />
        );
      })}
    </>
  );
}

function RunRow({
  run,
  binding,
  plugins,
}: {
  run: Run;
  binding: Binding | undefined;
  plugins: PluginDescriptor[];
}) {
  const processor = plugins.find(
    (plugin) => plugin.packageRef === binding?.processor?.packageRef,
  );
  return (
    <article className="flex flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {run.kind === 'sync' ? '来源同步' : (processor?.title ?? '插件加工')}
        </h3>
        <Badge>{runLabel(run.state)}</Badge>
      </div>
      <p className="break-all font-mono text-xs text-muted-foreground">
        {run.id}
      </p>
      <p className="text-xs text-muted-foreground">
        {new Date(run.createdAt).toLocaleString('zh-CN')} · 结果{' '}
        {short(run.resultCommit)}
      </p>
      {run.error ? (
        <Alert>
          <p>
            {binding?.name ?? '来源任务'}：{run.error}。
          </p>
          <p>
            最近已发布内容仍保留。请检查插件配置、导入文件、仓库地址/分支、网络及权限；本切片不支持私有
            Git 凭据。来源配置填错时请重新添加正确来源。
          </p>
          <Link
            className="underline"
            to={`/?${new URLSearchParams({ project: run.projectId, view: 'sources' })}`}
          >
            检查来源配置
          </Link>
        </Alert>
      ) : null}
      {run.skipped?.length ? (
        <details className="rounded-lg border p-3 text-xs">
          <summary className="cursor-pointer font-medium">
            未摄入 {run.skipped.length} 个条目
          </summary>
          <p className="mt-2 text-muted-foreground">
            当前仅处理支持的文本文件，以下条目不在本次快照中。
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {run.skipped.map((item, index) => (
              <li key={`${item.path}:${index}`} className="break-all">
                {item.path} · {item.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}
