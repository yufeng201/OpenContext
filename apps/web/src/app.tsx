import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import {
  BookOpen,
  FileText,
  FolderGit2,
  Layers3,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Workflow,
  ArrowUpRight,
  Copy,
  Check,
} from 'lucide-react';
import {
  CreateProjectSchema,
  CreateBindingSchema,
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
  CreateBindingInput,
  SearchResult,
  ReadResult,
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
import { selectBindingRun } from './lib/binding-run';

type Session = Pick<Principal, 'role' | 'projectId'>;
const views = [
  { id: 'sources', label: '来源', icon: FolderGit2 },
  { id: 'files', label: '文件', icon: FileText },
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
  const [accessMessage, setAccessMessage] = useState('');
  const session = useQuery({
    queryKey: ['session', generation],
    queryFn: async ({ signal }) => {
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
        onConnected={() => {
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
      onLogout={clearSession}
    />
  );
}

function Login({
  message,
  onConnected,
}: {
  message: string;
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
                <Button type="submit" disabled={login.isPending}>
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
  const requestedView = params.get('view') ?? 'sources';
  const view = views.some((item) => item.id === requestedView)
    ? requestedView
    : 'sources';
  const scope = ['data', generation, projectId] as const;
  const projects = useQuery({
    queryKey: ['data', generation, 'projects'],
    queryFn: ({ signal }) => api<Project[]>('/projects', { signal }),
    refetchInterval: 10_000,
  });
  const project = projects.data?.find((entry) => entry.id === projectId);
  useEffect(() => {
    if (!projectId && projects.data?.[0])
      setParams(
        { project: projects.data[0].id, view: 'sources' },
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
  const logout = useMutation({
    mutationFn: () => api('/session', { method: 'DELETE' }),
    onSuccess: onLogout,
  });
  const invalidate = () =>
    client.invalidateQueries({ queryKey: ['data', generation] });
  const navigate = (next: Record<string, string>) =>
    setParams({ project: projectId, view, ...next });
  const queryFailure =
    projects.error ?? bindings.error ?? runs.error ?? tree.error;
  const files = tree.data?.filter((file) => !file.tombstone) ?? [];
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[228px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-6 border-b bg-card px-5 py-5 lg:min-h-screen lg:border-r lg:border-b-0">
        <Link
          to="/"
          className="flex items-center gap-2.5 font-semibold tracking-tight"
        >
          <Layers3 className="size-6 text-primary" />
          OpenContext
        </Link>
        <Field>
          <FieldLabel htmlFor="project-select">当前空间</FieldLabel>
          <select
            id="project-select"
            className={selectClass}
            value={projectId}
            onChange={(event) =>
              setParams({ project: event.target.value, view: 'sources' })
            }
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
        {session.role === 'owner' && project ? (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">新建空间</summary>
            <div className="mt-4">
              <CreateProject
                onCreated={(entry) => {
                  void invalidate();
                  setParams({ project: entry.id, view: 'sources' });
                }}
              />
            </div>
          </details>
        ) : null}
        <nav
          aria-label="主要导航"
          className="grid grid-cols-4 gap-1 lg:flex lg:flex-col"
        >
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
        <div className="hidden grow lg:block" />
        <div className="flex items-center justify-between gap-2 lg:flex-col lg:items-start">
          <Badge>{session.role === 'owner' ? '所有者' : '项目只读'}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut />
            退出连接
          </Button>
        </div>
        {logout.error ? <Alert>{errorText(logout.error)}</Alert> : null}
      </aside>
      <main className="min-w-0 p-5 md:p-8 lg:p-10">
        <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
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
          <Button variant="outline" size="sm" onClick={() => void invalidate()}>
            <RefreshCw />
            刷新状态
          </Button>
        </header>
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
                    setParams({ project: entry.id, view: 'sources' });
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
              <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <Card>
                    <CardHeader>
                      <CardTitle>仓库来源</CardTitle>
                      <CardDescription>
                        同步指定分支的受限文本快照，原文无需模型即可搜索。二进制、LFS
                        等跳过项见任务记录。
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {bindings.isPending ? (
                        <p role="status">正在读取来源…</p>
                      ) : bindings.data?.length ? (
                        <div className="flex flex-col gap-4">
                          {bindings.data.map((binding) => (
                            <BindingRow
                              key={binding.id}
                              binding={binding}
                              runs={runs.data ?? []}
                              owner={session.role === 'owner'}
                              onChanged={invalidate}
                            />
                          ))}
                        </div>
                      ) : (
                        <Empty>
                          <FolderGit2 className="size-6" />
                          <strong>还没有来源</strong>
                          <p>添加一个可读取的 Git 仓库，再执行首次同步。</p>
                        </Empty>
                      )}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>从文件到可信引用</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ol className="flex flex-col gap-3 text-sm">
                        <li>01 · 同步仓库，保存固定来源版本。</li>
                        <li>
                          02 · 搜索原文，或生成不调用模型的 Markdown 导航。
                        </li>
                        <li>03 · 打开精确 revision，复制引用供 Agent 使用。</li>
                      </ol>
                      <p className="mt-4 text-xs text-muted-foreground">
                        当前切片不含 embedding、飞书、本地设备或外部发布。
                      </p>
                    </CardContent>
                  </Card>
                </div>
                <div className="flex flex-col gap-5">
                  {session.role === 'owner' ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>添加 Git 仓库</CardTitle>
                        <CardDescription>
                          首版只配置来源，不在浏览器执行 Git。
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <CreateBinding
                          key={projectId}
                          projectId={projectId}
                          onCreated={() =>
                            client.invalidateQueries({
                              queryKey: [...scope, 'bindings'],
                            })
                          }
                        />
                      </CardContent>
                    </Card>
                  ) : null}
                  <Card>
                    <CardHeader>
                      <CardTitle>空间概览</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <dt className="text-muted-foreground">来源</dt>
                          <dd className="mt-1 text-xl font-semibold">
                            {bindings.data?.length ?? '—'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">当前文件</dt>
                          <dd className="mt-1 text-xl font-semibold">
                            {tree.data ? files.length : '—'}
                          </dd>
                        </div>
                      </dl>
                      <p className="mt-4 break-all font-mono text-xs text-muted-foreground">
                        head {short(project.head)}
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </div>
            ) : null}
            {view === 'files' ? (
              <Card>
                <CardHeader>
                  <CardTitle>文件目录</CardTitle>
                  <CardDescription>
                    源文件与产物共同展示；已删除项不会留在当前目录。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {tree.isPending ? (
                    <p role="status">正在读取文件…</p>
                  ) : files.length ? (
                    <div className="flex flex-col divide-y">
                      {files.map((file) => (
                        <FileRow
                          key={file.fileId}
                          file={file}
                          onOpen={() =>
                            navigate({
                              file: file.fileId,
                              revision: file.revisionId,
                            })
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty>尚无已发布文件。先从“来源”完成同步。</Empty>
                  )}
                </CardContent>
              </Card>
            ) : null}
            {view === 'search' ? (
              <SearchPanel
                key={projectId}
                projectId={projectId}
                scope={scope}
                files={files}
                onOpen={(file) =>
                  navigate({
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
          </>
        ) : null}
      </main>
    </div>
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

function CreateBinding({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => Promise<unknown>;
}) {
  const form = useForm<CreateBindingInput>({
    defaultValues: { name: '', repoUrl: '', branch: 'main' },
  });
  const mutation = useMutation({
    mutationFn: ({
      projectId: targetProjectId,
      values,
    }: {
      projectId: string;
      values: CreateBindingInput;
    }) =>
      api<Binding>(
        `/projects/${encodeURIComponent(targetProjectId)}/bindings`,
        {
          method: 'POST',
          body: JSON.stringify(values),
        },
      ),
    onSuccess: () => {
      form.reset();
      void onCreated();
    },
  });
  return (
    <form
      onSubmit={form.handleSubmit(async (values) => {
        if (await validateForm(CreateBindingSchema, values, form.setError))
          mutation.mutate({ projectId, values });
      })}
    >
      <FieldGroup>
        {(
          [
            ['name', '来源名称', '例如：项目文档'],
            ['repoUrl', '仓库地址', 'https://github.com/owner/repo.git'],
            ['branch', '分支', 'main'],
          ] as const
        ).map(([name, label, placeholder]) => (
          <Field key={name} data-invalid={Boolean(form.formState.errors[name])}>
            <FieldLabel htmlFor={`binding-${name}`}>{label}</FieldLabel>
            <Input
              id={`binding-${name}`}
              placeholder={placeholder}
              spellCheck={false}
              aria-invalid={Boolean(form.formState.errors[name])}
              {...form.register(name)}
            />
            {form.formState.errors[name] ? (
              <FieldDescription>
                {form.formState.errors[name]?.message}
              </FieldDescription>
            ) : null}
          </Field>
        ))}
        <FieldDescription>
          仅使用服务器可读取的来源。请勿在 URL 中粘贴密码或 token。
          切换空间会重置未提交的来源表单。
        </FieldDescription>
        {mutation.error ? <Alert>{errorText(mutation.error)}</Alert> : null}
        <Button type="submit" disabled={mutation.isPending}>
          <Plus />
          {mutation.isPending ? '添加中…' : '添加来源'}
        </Button>
      </FieldGroup>
    </form>
  );
}

function BindingRow({
  binding,
  runs,
  owner,
  onChanged,
}: {
  binding: Binding;
  runs: Run[];
  owner: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const action = useMutation({
    mutationFn: (kind: 'sync' | 'process') =>
      api<Run>(
        `/projects/${encodeURIComponent(binding.projectId)}/bindings/${encodeURIComponent(binding.id)}/${kind}`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void onChanged();
    },
  });
  const activeRun = selectBindingRun(binding.id, runs, action.data);
  const busy =
    action.isPending ||
    activeRun?.state === 'queued' ||
    activeRun?.state === 'running';
  return (
    <article className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{binding.name}</h3>
        <Badge>
          {binding.lastError
            ? '同步异常'
            : binding.sourceVersion
              ? '已有来源版本'
              : '等待首次同步'}
        </Badge>
      </div>
      <p className="break-all text-xs text-muted-foreground">
        {binding.config.repoUrl}
      </p>
      <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
        {binding.config.branch} · {short(binding.sourceVersion)}
      </p>
      {binding.lastError ? (
        <Alert className="mt-3">
          上次同步未成功，保留最近一次已发布版本。请检查来源与任务记录。
        </Alert>
      ) : null}
      {owner ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => action.mutate('sync')}
            disabled={busy}
          >
            <RefreshCw />
            {action.isPending && action.variables === 'sync'
              ? '同步中…'
              : '同步仓库'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => action.mutate('process')}
            disabled={busy || !binding.sourceVersion}
          >
            <BookOpen />
            {action.isPending && action.variables === 'process'
              ? '生成中…'
              : '生成 Markdown 导航'}
          </Button>
        </div>
      ) : null}
      {action.error ? (
        <Alert className="mt-3">{errorText(action.error)}</Alert>
      ) : null}
      {activeRun ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          任务状态：{runLabel(activeRun.state)}，可到“任务”查看记录。
        </p>
      ) : null}
    </article>
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
                    : '尚无可查询文件。先在“来源”同步仓库。'}
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
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const read = useQuery({
    queryKey: [...scope, 'read', fileId, revisionId],
    queryFn: async ({ signal }) => {
      try {
        return await api<ReadResult>(
          `/projects/${encodeURIComponent(projectId)}/read?${new URLSearchParams({ fileId, revisionId })}`,
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
  return (
    <Card className="mt-6" aria-label="固定版本原文">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>固定版本原文</CardTitle>
            <CardDescription className="mt-2 break-all">
              {(!read.error && read.data?.file.logicalPath) ||
                '读取指定 revision'}
            </CardDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
      </CardHeader>
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
            <dl className="mb-4 flex flex-col gap-1 break-all font-mono text-xs text-muted-foreground">
              <div>revision {read.data.file.revisionId}</div>
              <div>commit {read.data.citation.commitId}</div>
              <div>source {read.data.citation.sourceVersion}</div>
              <div>sha256 {read.data.citation.contentHash}</div>
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
            <pre className="mt-5 max-h-[38rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm leading-7">
              {read.data.text}
            </pre>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function runLabel(state: Run['state']) {
  return {
    queued: '等待执行',
    running: '执行中',
    published: '内容已发布',
    failed: '执行失败',
    superseded: '输入已更新',
  }[state];
}
function RunRow({ run, binding }: { run: Run; binding: Binding | undefined }) {
  return (
    <article className="flex flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {run.kind === 'sync' ? '仓库同步' : 'Markdown 导航加工'}
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
            最近已发布内容仍保留。请检查仓库地址、分支、网络及权限；本切片不支持私有
            Git 凭据。分支填错时请重新添加正确来源。
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
