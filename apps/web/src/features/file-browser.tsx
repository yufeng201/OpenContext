import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ChevronRight,
  Check,
  FileText,
  Folder,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { FileEntry } from '@opencontext/contracts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Empty } from '../components/ui/panels';

export const parentPath = (path: string) =>
  path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .slice(0, -1)
    .join('/');
export const baseName = (path: string) =>
  path.split('/').filter(Boolean).at(-1) ?? '工作区';
export const fileKind = (file: FileEntry) =>
  /:rule:\d+$/.test(file.slotKey)
    ? '规则候选'
    : /:experience:\d+$/.test(file.slotKey)
      ? '经验候选'
      : /:memory:\d+$/.test(file.slotKey)
        ? '记忆候选'
        : file.logicalPath.endsWith('.json')
          ? 'JSON'
          : file.logicalPath.endsWith('.md')
            ? 'Markdown'
            : '文本';
export const ownershipLabel = (file: FileEntry) =>
  file.ownership === 'generated'
    ? '生成文件'
    : file.ownership === 'human_owned'
      ? '人工文件'
      : '原始文件';
export function directories(files: FileEntry[]) {
  const paths = new Set<string>();
  for (const file of files) {
    const parts = file.logicalPath.split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index++)
      paths.add(parts.slice(0, index).join('/'));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export function DirectoryTree({
  files,
  projectId,
  current,
  onNavigate,
}: {
  files: FileEntry[];
  projectId: string;
  current: string;
  onNavigate: (path: string) => void;
}) {
  const paths = useMemo(() => directories(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return (
    <nav className="directory-tree" aria-label="目录树">
      <Link
        className={
          'directory-item root-directory ' + (!current ? 'is-current' : '')
        }
        to={`/?${new URLSearchParams({ project: projectId, view: 'files' })}`}
        onClick={() => onNavigate('')}
      >
        <Folder />
        工作区
      </Link>
      {paths
        .filter(
          (path) =>
            ![...collapsed].some((parent) => path.startsWith(parent + '/')),
        )
        .map((path) => {
          const children = paths.some((child) => parentPath(child) === path);
          return (
            <div
              key={path}
              className={
                'directory-line ' + (path === current ? 'is-current' : '')
              }
              style={{ paddingLeft: 12 + (path.split('/').length - 1) * 16 }}
            >
              {children ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-label={`${collapsed.has(path) ? '展开' : '折叠'} ${path}`}
                  aria-expanded={!collapsed.has(path)}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })
                  }
                >
                  <ChevronRight
                    className={collapsed.has(path) ? '' : 'expanded'}
                  />
                </button>
              ) : (
                <span className="tree-toggle" />
              )}
              <button
                type="button"
                className="directory-item"
                title={path}
                onClick={() => onNavigate(path)}
                aria-current={current === path ? 'location' : undefined}
              >
                <Folder />
                <span>{baseName(path)}</span>
              </button>
            </div>
          );
        })}
    </nav>
  );
}

export function FileBrowser({
  files,
  loading,
  onOpen,
  onRefresh,
  children,
}: {
  files: FileEntry[];
  loading: boolean;
  onOpen: (file: FileEntry) => void;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const directory = (
    params.get('dir') ??
    parentPath(
      files.find((file) => file.fileId === params.get('file'))?.logicalPath ??
        '',
    )
  ).replace(/^\/+|\/+$/g, '');
  const filter = params.get('filter') ?? '';
  const type = params.get('type') ?? 'all';
  const grid = params.get('layout') === 'grid';
  const descending = params.get('sort') === 'desc';
  const update = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
  };
  const changeDirectory = (path: string) =>
    update({ dir: path, file: '', revision: '', filter: '' });
  const allDirectories = useMemo(() => directories(files), [files]);
  const childrenDirs = allDirectories.filter(
    (path) => parentPath(path) === directory,
  );
  const eligible = (file: FileEntry) =>
    type === 'all' ||
    type === file.collection ||
    (type === 'rules' && /:rule:\d+$/.test(file.slotKey)) ||
    (type === 'experiences' && /:experience:\d+$/.test(file.slotKey)) ||
    (type === 'memories' && /:memory:\d+$/.test(file.slotKey));
  const visibleFiles = files.filter(
    (file) =>
      parentPath(file.logicalPath) === directory &&
      eligible(file) &&
      baseName(file.logicalPath)
        .toLocaleLowerCase()
        .includes(filter.toLocaleLowerCase()),
  );
  const folders = childrenDirs.filter(
    (path) =>
      baseName(path).toLocaleLowerCase().includes(filter.toLocaleLowerCase()) &&
      files.some(
        (file) => file.logicalPath.startsWith(path + '/') && eligible(file),
      ),
  );
  const rows = [
    ...folders.map((path) => ({ path, file: null as FileEntry | null })),
    ...visibleFiles.map((file) => ({ path: file.logicalPath, file })),
  ].sort(
    (a, b) =>
      Number(Boolean(a.file)) - Number(Boolean(b.file)) ||
      (descending ? -1 : 1) * baseName(a.path).localeCompare(baseName(b.path)),
  );
  const crumbs = directory.split('/').filter(Boolean);
  return (
    <div className={'files-layout ' + (children ? 'with-reader' : '')}>
      <div className="file-workspace">
        <nav className="breadcrumbs" aria-label="文件路径">
          <button
            type="button"
            onClick={() => changeDirectory(parentPath(directory))}
            aria-label="返回上级目录"
          >
            <ChevronRight className="rotate-180" />
          </button>
          <button type="button" onClick={() => changeDirectory('')}>
            工作区
          </button>
          {crumbs.map((name, index) => (
            <span key={index}>
              <span className="crumb-slash">/</span>
              <button
                type="button"
                title={'/' + crumbs.slice(0, index + 1).join('/')}
                onClick={() =>
                  changeDirectory(crumbs.slice(0, index + 1).join('/'))
                }
              >
                {name}
              </button>
            </span>
          ))}
        </nav>
        <div className="file-toolbar">
          <div className="directory-heading">
            <h1>{baseName(directory)}</h1>
            <span>{rows.length} 项</span>
            <div className="file-filter">
              <label htmlFor="file-type">文件视图</label>
              <select
                id="file-type"
                value={type}
                onChange={(event) => update({ type: event.target.value })}
              >
                <option value="all">全部文件</option>
                <option value="sources">原始文件</option>
                <option value="derived">生成文件</option>
                <option value="authored">人工文件</option>
                <option value="memories">记忆</option>
                <option value="rules">规则</option>
                <option value="experiences">经验</option>
              </select>
              <span>源文件与产出 · 统一文件系统</span>
            </div>
          </div>
          <div className="file-controls">
            <div className="directory-search">
              <Search />
              <Input
                aria-label="搜索当前目录"
                placeholder="搜索当前目录…"
                value={filter}
                onChange={(event) => update({ filter: event.target.value })}
              />
            </div>
            <div className="layout-toggle">
              <button
                type="button"
                aria-label="列表视图"
                aria-pressed={!grid}
                onClick={() => update({ layout: '' })}
              >
                <List />
              </button>
              <button
                type="button"
                aria-label="网格视图"
                aria-pressed={grid}
                onClick={() => update({ layout: 'grid' })}
              >
                <LayoutGrid />
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw />
              刷新
            </Button>
          </div>
        </div>
        <section
          className={'file-table ' + (grid ? 'file-grid' : '')}
          aria-label="文件目录"
        >
          <div className="table-head">
            <button
              type="button"
              onClick={() => update({ sort: descending ? '' : 'desc' })}
            >
              名称 {descending ? '↓' : '↑'}
            </button>
            <span>类型</span>
            <span>来源</span>
            <span>修改时间</span>
            <span>状态</span>
          </div>
          <div className="table-body">
            {loading ? (
              <p className="p-6" role="status">
                正在读取文件…
              </p>
            ) : rows.length ? (
              rows.map(({ path, file }) => (
                <button
                  type="button"
                  key={file?.fileId ?? path}
                  title={path}
                  className={
                    'table-row ' +
                    (file?.fileId === params.get('file') ? 'is-selected' : '')
                  }
                  aria-pressed={
                    file ? file.fileId === params.get('file') : undefined
                  }
                  onClick={() => (file ? onOpen(file) : changeDirectory(path))}
                >
                  <span className="file-name">
                    <span
                      className={
                        'selection-marker ' +
                        (file?.fileId === params.get('file') ? 'checked' : '')
                      }
                      aria-hidden="true"
                    >
                      {file?.fileId === params.get('file') ? <Check /> : null}
                    </span>
                    {file ? <FileText /> : <Folder className="folder-icon" />}
                    <span>{baseName(path)}</span>
                  </span>
                  <span className="row-type">
                    {file ? fileKind(file) : '文件夹'}
                  </span>
                  <span>
                    {file ? (
                      <span className={'file-origin ' + file.ownership}>
                        {ownershipLabel(file)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </span>
                  <time dateTime={file?.createdAt}>
                    {file
                      ? new Date(file.createdAt).toLocaleString('zh-CN', {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })
                      : '—'}
                  </time>
                  <span className="row-state">
                    {file
                      ? file.freshness === 'fresh'
                        ? '有效'
                        : file.freshness === 'stale'
                          ? '已过期'
                          : '已失效'
                      : '—'}
                  </span>
                </button>
              ))
            ) : (
              <Empty>
                {filter || type !== 'all'
                  ? '没有符合筛选的文件。请调整搜索或文件视图。'
                  : '此目录暂无已发布文件。请从数据源完成同步。'}
              </Empty>
            )}
          </div>
          <footer className="table-footer">
            {folders.length} 个文件夹 · {visibleFiles.length} 个文件
          </footer>
        </section>
      </div>
      {children}
    </div>
  );
}
