import { useState, useRef } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, BookOpen, Upload, Trash2 } from 'lucide-react';
import {
  CreatePluginBindingSchema,
  ImportUploadSchema,
} from '@opencontext/contracts';
import type {
  Binding,
  Run,
  PluginDescriptor,
  CreatePluginBindingInput,
  ImportedObjectRef,
} from '@opencontext/contracts';
import { api, ApiError, errorText } from '../api/client';
import { validateForm } from '../api/forms';
import {
  bindingDefaults,
  defaultProcessor,
  pluginDefaults,
} from '../lib/plugin-forms';
import { selectBindingRun, runLabel } from '../lib/binding-run';
import { ConnectionDiagnostic } from './connection-diagnostic';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field';
import { Alert, Badge } from '../components/ui/panels';

const selectClass =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

function ConfigurationFields({
  plugin,
  kind,
  form,
  disabled,
}: {
  plugin: PluginDescriptor | undefined;
  kind: 'connector' | 'processor';
  form: UseFormReturn<CreatePluginBindingInput>;
  disabled: boolean;
}) {
  if (!plugin) return null;
  return (
    <>
      <FieldDescription>{plugin.description}</FieldDescription>
      {plugin.fields.map((field) => {
        const path = `${kind}.config.${field.key}` as const;
        const error = form.getFieldState(path, form.formState).error;
        return (
          <Field
            key={`${plugin.packageRef}:${field.key}`}
            data-invalid={Boolean(error)}
            data-disabled={disabled}
          >
            <FieldLabel htmlFor={`${kind}-${field.key}`}>
              {field.label}
            </FieldLabel>
            {field.kind === 'select' ? (
              <select
                id={`${kind}-${field.key}`}
                className={selectClass}
                disabled={disabled}
                aria-invalid={Boolean(error)}
                {...form.register(path)}
              >
                <option value="" disabled>
                  请选择
                </option>
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`${kind}-${field.key}`}
                placeholder={field.placeholder}
                spellCheck={false}
                disabled={disabled}
                aria-invalid={Boolean(error)}
                {...form.register(path)}
              />
            )}
            {error ? (
              <FieldDescription>{error.message}</FieldDescription>
            ) : null}
          </Field>
        );
      })}
      {plugin.limitations.length ? (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {plugin.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function CreateBinding({
  projectId,
  plugins,
  onCreated,
}: {
  projectId: string;
  plugins: PluginDescriptor[];
  onCreated: () => Promise<unknown>;
}) {
  const form = useForm<CreatePluginBindingInput>({
    defaultValues: bindingDefaults(plugins),
  });
  const connectorRef = form.watch('connector.packageRef');
  const processorRef = form.watch('processor.packageRef');
  const connector = plugins.find(
    (plugin) =>
      plugin.packageRef === connectorRef && plugin.capability === 'connector',
  );
  const processor = plugins.find(
    (plugin) =>
      plugin.packageRef === processorRef && plugin.capability === 'processor',
  );
  const mutation = useMutation({
    mutationFn: ({
      projectId: target,
      values,
    }: {
      projectId: string;
      values: CreatePluginBindingInput;
    }) =>
      api<Binding>(`/projects/${encodeURIComponent(target)}/bindings`, {
        method: 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      form.reset(bindingDefaults(plugins));
      void onCreated();
    },
  });
  const available = connector?.available && processor?.available;
  return (
    <form
      onSubmit={form.handleSubmit(async (values) => {
        form.clearErrors();
        if (!available || !connector || !processor) return;
        const valid = await validateForm(
          CreatePluginBindingSchema,
          values,
          form.setError,
        );
        const connectorValid = await validateForm(
          connector.configSchema,
          values.connector.config,
          (key, error) => form.setError(`connector.config.${key}`, error),
        );
        const processorValid = await validateForm(
          processor.configSchema,
          values.processor.config,
          (key, error) => form.setError(`processor.config.${key}`, error),
        );
        if (valid && connectorValid && processorValid)
          mutation.mutate({ projectId, values });
      })}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(form.formState.errors.name)}>
          <FieldLabel htmlFor="binding-name">来源名称</FieldLabel>
          <Input
            id="binding-name"
            placeholder="例如：项目文档"
            disabled={mutation.isPending}
            aria-invalid={Boolean(form.formState.errors.name)}
            {...form.register('name')}
          />
          {form.formState.errors.name ? (
            <FieldDescription>
              {form.formState.errors.name.message}
            </FieldDescription>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="connector-plugin">来源插件</FieldLabel>
          <select
            id="connector-plugin"
            className={selectClass}
            value={connectorRef}
            disabled={mutation.isPending}
            onChange={(event) => {
              const next = plugins.find(
                (plugin) => plugin.packageRef === event.target.value,
              );
              const recommended = defaultProcessor(plugins, next);
              form.setValue('connector', {
                packageRef: next?.packageRef ?? '',
                config: pluginDefaults(next),
              });
              form.setValue('processor', {
                packageRef: recommended?.packageRef ?? '',
                config: pluginDefaults(recommended),
              });
              form.clearErrors();
              mutation.reset();
            }}
          >
            {plugins
              .filter((plugin) => plugin.capability === 'connector')
              .map((plugin) => (
                <option
                  key={plugin.packageRef}
                  value={plugin.packageRef}
                  disabled={!plugin.available}
                >
                  {plugin.title}
                  {plugin.available ? '' : '（不可用）'}
                </option>
              ))}
          </select>
        </Field>
        <ConfigurationFields
          plugin={connector}
          kind="connector"
          form={form}
          disabled={mutation.isPending}
        />
        <Field>
          <FieldLabel htmlFor="processor-plugin">处理插件</FieldLabel>
          <select
            id="processor-plugin"
            className={selectClass}
            value={processorRef}
            disabled={mutation.isPending}
            onChange={(event) => {
              const next = plugins.find(
                (plugin) => plugin.packageRef === event.target.value,
              );
              form.setValue('processor', {
                packageRef: next?.packageRef ?? '',
                config: pluginDefaults(next),
              });
              form.clearErrors('processor');
              mutation.reset();
            }}
          >
            {plugins
              .filter((plugin) => plugin.capability === 'processor')
              .map((plugin) => (
                <option
                  key={plugin.packageRef}
                  value={plugin.packageRef}
                  disabled={!plugin.available}
                >
                  {plugin.title}
                  {plugin.available ? '' : '（不可用）'}
                </option>
              ))}
          </select>
        </Field>
        <ConfigurationFields
          plugin={processor}
          kind="processor"
          form={form}
          disabled={mutation.isPending}
        />
        <FieldDescription>
          {connector?.acceptsImports
            ? '创建来源后，明确选择你已脱敏的 JSON 导出文件上传；不会扫描本机目录或自动读取 Agent 历史。'
            : connector?.supportsConnectionTest
              ? '仅填写服务器上的凭据引用 secretRef，不粘贴 token。创建来源后先测试指定接口，再同步。'
              : '仅使用服务器可读取的来源。请勿在 URL 中粘贴密码或 token。'}
          切换空间会重置未提交的来源表单。
        </FieldDescription>
        {!available ? (
          <Alert>所需插件不可用，请选择可用插件或联系服务器管理员。</Alert>
        ) : null}
        {mutation.error ? <Alert>{errorText(mutation.error)}</Alert> : null}
        <Button type="submit" disabled={mutation.isPending || !available}>
          <Plus data-icon="inline-start" />
          {mutation.isPending ? '添加中…' : '添加来源'}
        </Button>
      </FieldGroup>
    </form>
  );
}

function ImportedFiles({
  binding,
  scope,
  disabled,
}: {
  binding: Binding;
  scope: readonly unknown[];
  disabled: boolean;
}) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File | null>(null);
  const [notice, setNotice] = useState('');
  const [localError, setLocalError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const path = `/projects/${encodeURIComponent(binding.projectId)}/bindings/${encodeURIComponent(binding.id)}/imports`;
  const queryKey = [...scope, 'imports', binding.id];
  const imported = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<ImportedObjectRef[]>(path, { signal }),
    refetchInterval: 5000,
  });
  const upload = useMutation({
    mutationFn: async ({
      file,
      expectedObjectId,
    }: {
      file: File;
      expectedObjectId: string | null;
    }) => {
      if (file.size > 1_048_576)
        throw new Error('文件超过 1 MiB，请拆分导出后重试。');
      let content: string;
      try {
        // Never silently normalize the approved file's bytes (including a BOM).
        content = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(await file.arrayBuffer());
        JSON.parse(content);
      } catch {
        throw new Error('请选择有效的 UTF-8 JSON 导出文件。');
      }
      const values = { filename: file.name, content, expectedObjectId };
      let valid = true;
      await validateForm(ImportUploadSchema, values, () => {
        valid = false;
      });
      if (!valid)
        throw new Error(
          '文件名需为不超过120字符的英文字母/数字开头，并以 .json 结尾；仅允许字母、数字、点、连字符和下划线。',
        );
      return api<ImportedObjectRef>(path, {
        method: 'POST',
        body: JSON.stringify(values),
      });
    },
    onSuccess: () => {
      setSelected(null);
      if (input.current) input.current.value = '';
      setNotice(
        '导入输入已保存，尚未发布。下一步点击“同步导入”，再运行处理插件。',
      );
      void client.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IMPORT_CONFLICT') {
        setSelected(null);
        if (input.current) input.current.value = '';
        void client.invalidateQueries({ queryKey });
      }
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteId(null);
      setNotice(
        '已从导入输入集合删除；执行下一次同步后，正式来源和依赖产物才会失效。',
      );
      void client.invalidateQueries({ queryKey });
    },
  });
  const busy = disabled || upload.isPending || remove.isPending;
  return (
    <section
      className="mt-4 flex flex-col gap-3 rounded-lg border p-3"
      aria-label={`导入文件 ${binding.name}`}
    >
      <p className="text-sm font-medium">1 · 导入文件集合</p>
      <FieldDescription>
        仅上传你明确选择、已脱敏的导出。每文件最多 1 MiB，最多32个文件、合计10
        MiB；同名上传替换输入，需再次同步才发布。此处不预览会话正文。
      </FieldDescription>
      <Field data-disabled={busy} data-invalid={Boolean(localError)}>
        <FieldLabel htmlFor={`import-${binding.id}`}>
          选择 JSON 导出文件
        </FieldLabel>
        <Input
          id={`import-${binding.id}`}
          ref={input}
          type="file"
          accept=".json,application/json"
          disabled={busy}
          aria-invalid={Boolean(localError)}
          onChange={(event) => {
            setNotice('');
            setLocalError('');
            upload.reset();
            setSelected(null);
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 1_048_576) {
              setLocalError('文件超过 1 MiB，请拆分导出后重试。');
              return;
            }
            setSelected(file);
          }}
        />
        {selected ? (
          <FieldDescription>
            待上传：{selected.name} · {selected.size} bytes
          </FieldDescription>
        ) : null}
      </Field>
      {localError ? <Alert>{localError}</Alert> : null}
      {upload.error ? (
        <Alert>
          {upload.error instanceof Error && !('status' in upload.error)
            ? upload.error.message
            : errorText(upload.error)}
        </Alert>
      ) : null}
      {remove.error || imported.error ? (
        <Alert>{errorText(remove.error ?? imported.error)}</Alert>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={
          busy || !selected || !imported.data || Boolean(imported.error)
        }
        onClick={() => {
          if (selected)
            upload.mutate({
              file: selected,
              expectedObjectId:
                imported.data?.find(
                  (object) => object.filename === selected.name,
                )?.id ?? null,
            });
        }}
      >
        <Upload data-icon="inline-start" />
        {upload.isPending ? '正在上传…' : '上传所选文件'}
      </Button>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {imported.isPending ? (
        <p role="status">正在读取导入列表…</p>
      ) : imported.data?.length ? (
        <ul className="flex flex-col gap-2">
          {imported.data.map((object) => (
            <li
              key={object.id}
              className="flex flex-col gap-2 rounded-md border p-2 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-all">
                  {object.filename} · {object.bytes} bytes
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDeleteId(object.id)}
                  aria-label={`删除导入 ${object.filename}`}
                >
                  <Trash2 data-icon="inline-start" />
                  删除导入
                </Button>
              </div>
              {deleteId === object.id ? (
                <Alert>
                  <p>
                    确认移除 {object.filename}
                    ？下一次同步将撤下对应来源及依赖产物。
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => remove.mutate(object.id)}
                    >
                      确认删除
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDeleteId(null)}
                    >
                      取消
                    </Button>
                  </div>
                </Alert>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          尚未导入文件。上传不会自动开始同步。
        </p>
      )}
    </section>
  );
}

export function BindingRow({
  binding,
  runs,
  owner,
  plugins,
  scope,
  onChanged,
}: {
  binding: Binding;
  runs: Run[];
  owner: boolean;
  plugins: PluginDescriptor[];
  scope: readonly unknown[];
  onChanged: () => Promise<unknown>;
}) {
  const connector = plugins.find(
    (plugin) =>
      plugin.packageRef ===
      (binding.connector?.packageRef ?? binding.packageRef),
  );
  const processor =
    plugins.find(
      (plugin) => plugin.packageRef === binding.processor?.packageRef,
    ) ?? defaultProcessor(plugins, connector);
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
  const config = binding.connector?.config ?? binding.config;
  const unavailable = !connector?.available || !processor?.available;
  return (
    <article className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{binding.name}</h3>
        <Badge>
          {!binding.active
            ? '已撤销'
            : binding.lastError
              ? '同步异常'
              : binding.sourceVersion
                ? '已有来源版本'
                : '等待首次同步'}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {owner
          ? `${connector?.title ?? '来源插件不可用'} → ${processor?.title ?? '处理插件不可用'}`
          : '已发布上下文来源'}
      </p>
      <dl className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
        {connector?.fields.map((field) =>
          typeof config[field.key] === 'string' ? (
            <div key={field.key} className="break-all">
              <dt className="inline">{field.label}：</dt>
              <dd className="inline">{String(config[field.key])}</dd>
            </div>
          ) : null,
        )}
      </dl>
      <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
        来源版本 · {binding.sourceVersion?.slice(0, 12) ?? '尚未同步'}
      </p>
      {!binding.active ? (
        <Alert className="mt-3">
          此来源已撤销，源文件及产物不再可读。保留此记录用于核对；如需重新授权，请添加新来源。
        </Alert>
      ) : unavailable && owner ? (
        <Alert className="mt-3">
          锁定的插件版本不可用，不能执行；现有授权内容仍可查阅。
        </Alert>
      ) : binding.lastError ? (
        <Alert className="mt-3">
          上次同步未成功，保留最近一次已发布版本。请检查来源与任务记录。
        </Alert>
      ) : null}
      {owner && connector?.acceptsImports && binding.active ? (
        <ImportedFiles
          key={binding.id}
          binding={binding}
          scope={scope}
          disabled={busy || unavailable}
        />
      ) : null}
      {owner && connector?.supportsConnectionTest && binding.active ? (
        <ConnectionDiagnostic
          key={`${binding.projectId}:${binding.id}:${binding.connector?.ref ?? ''}`}
          binding={binding}
          disabled={busy || !connector.available}
        />
      ) : null}
      {owner ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => action.mutate('sync')}
            disabled={busy || !binding.active || unavailable}
          >
            <RefreshCw data-icon="inline-start" />
            {action.isPending && action.variables === 'sync'
              ? '同步中…'
              : connector?.acceptsImports
                ? '同步导入'
                : connector?.supportsConnectionTest
                  ? '同步来源'
                  : '同步仓库'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => action.mutate('process')}
            disabled={
              busy || !binding.active || unavailable || !binding.sourceVersion
            }
          >
            <BookOpen data-icon="inline-start" />
            {action.isPending && action.variables === 'process'
              ? '生成中…'
              : `生成 ${processor?.title ?? '产物'}`}
          </Button>
        </div>
      ) : null}
      {connector?.acceptsImports ? (
        <p className="mt-2 text-xs text-muted-foreground">
          2 · 同步导入发布原文 · 3 · 运行处理插件生成可检索产物
        </p>
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
