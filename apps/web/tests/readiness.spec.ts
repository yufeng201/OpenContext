import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { FileEntry } from '@opencontext/contracts';
const token = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
const repoUrl = process.env['OPENCONTEXT_E2E_REPO_URL'];
if (!token || !repoUrl)
  throw new Error(
    'Readiness browser checks require explicit synthetic fixture token/repo; no skip fallback.',
  );
const headers = { authorization: 'Bearer ' + token };
const evidence = '/tmp/opencontext-readiness-evidence';
mkdirSync(evidence, { recursive: true });
async function setup(request: APIRequestContext, branch = 'main') {
  const pr = await request.post('/api/projects', {
    headers,
    data: { name: 'Fresh reverify ' + Date.now() },
  });
  expect(pr.ok()).toBe(true);
  const project = await pr.json();
  const base = '/api/projects/' + project.id;
  const br = await request.post(base + '/bindings', {
    headers,
    data: { name: 'Fresh multilevel repo', repoUrl, branch },
  });
  expect(br.ok()).toBe(true);
  const binding = await br.json();
  const sr = await request.post(base + '/bindings/' + binding.id + '/sync', {
    headers,
  });
  expect(sr.status()).toBe(202);
  await expect
    .poll(
      async () => {
        const rr = await request.get(base + '/runs', { headers });
        return (await rr.json())[0]?.state;
      },
      { timeout: 30000 },
    )
    .toBe(branch === 'main' ? 'published' : 'failed');
  const tr = await request.get(base + '/tree', { headers });
  return { project, binding, base, tree: (await tr.json()) as FileEntry[] };
}
async function login(page: Page, id: string) {
  await page.goto('/?' + new URLSearchParams({ project: id }));
  await page.getByLabel('访问 token').fill(token!);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出连接' })).toBeVisible();
}
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name, exact: true });
test('fresh multilevel navigation, rapid filters, pinned search, history, cross-space clearing, focus and narrow screen', async ({
  page,
  request,
}) => {
  const f = await setup(request);
  const file = f.tree.find((x) =>
    x.logicalPath.endsWith('/docs/architecture/decision.md'),
  )!;
  expect(file).toBeTruthy();
  const dir = file.logicalPath.split('/').slice(0, -1).join('/');
  const other = await request.post('/api/projects', {
    headers,
    data: { name: 'Empty reverify space ' + Date.now() },
  });
  const b = await other.json();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await login(page, f.project.id);
  const table = page.getByRole('region', { name: '文件目录' });
  const crumbs = page.getByRole('navigation', { name: '文件路径' });
  await expect(
    table.getByRole('button', { name: /sources 文件夹/ }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '目录树' })
    .locator('button[title="' + dir + '"]')
    .click();
  await page.setViewportSize({ width: 1280, height: 600 });
  const geometry = await page.evaluate(() => {
    const tree = document.querySelector('.directory-tree'),
      nav = document.querySelector('.auxiliary-navigation');
    return {
      treeBottom: tree!.getBoundingClientRect().bottom,
      lastChildBottom: tree!.lastElementChild!.getBoundingClientRect().bottom,
      navTop: nav!.getBoundingClientRect().top,
    };
  });
  expect(geometry.lastChildBottom).toBeLessThanOrEqual(geometry.treeBottom + 1);
  expect(geometry.navTop).toBeGreaterThanOrEqual(geometry.treeBottom);
  await page.screenshot({
    path: evidence + '/' + 'short-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1487, height: 1058 });
  await expect(crumbs).toContainText('architecture');
  await expect(
    table.getByRole('button', { name: /decision.md/ }),
  ).toBeVisible();
  for (let i = 0; i < 8; i++) {
    await page.getByLabel('文件视图').selectOption('rules');
    await expect(table).toContainText('没有符合筛选的文件');
    await page.getByLabel('文件视图').selectOption('all');
    await expect(
      table.getByRole('button', { name: /decision.md/ }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get('dir')).toBe(dir);
  }
  // Rapid consecutive events without intervening visual waits.
  for (let i = 0; i < 8; i++) {
    await page.getByLabel('文件视图').selectOption('rules');
    await page.getByLabel('文件视图').selectOption('all');
  }
  await expect(
    table.getByRole('button', { name: /decision.md/ }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get('dir')).toBe(dir);
  await table.getByRole('button', { name: /decision.md/ }).click();
  const reader = page.getByRole('region', { name: '固定版本原文' });
  await expect(reader).toContainText('reverify-multilevel-needle');
  await reader.getByRole('tab', { name: '版本', exact: true }).click();
  await expect(reader).toContainText(file.revisionId);
  await reader.getByRole('tab', { name: '来源', exact: true }).click();
  await expect(reader).toContainText(f.binding.id);
  await reader.getByRole('tab', { name: '预览', exact: true }).click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(reader).toContainText('reverify-multilevel-needle');
  await page.reload();
  await expect(reader).toContainText('reverify-multilevel-needle');
  expect(new URL(page.url()).searchParams.get('revision')).toBe(
    file.revisionId,
  );
  await page.screenshot({
    path: evidence + '/' + 'fresh-multilevel.png',
    fullPage: true,
  });
  await crumbs.getByRole('button', { name: 'docs', exact: true }).click();
  await expect(table.getByRole('button', { name: /guide.md/ })).toBeVisible();
  await expect(reader).toHaveCount(0);
  await page.goBack();
  await expect(reader).toContainText('reverify-multilevel-needle');
  await page.goForward();
  await expect(table.getByRole('button', { name: /guide.md/ })).toBeVisible();
  await nav(page, '搜索').click();
  await page.getByLabel('搜索内容').fill('reverify-multilevel-needle');
  await page.getByLabel('检索方式').selectOption('grep');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page
    .getByRole('button')
    .filter({ hasText: 'decision.md' })
    .first()
    .click();
  await expect(reader).toContainText('reverify-multilevel-needle');
  expect(new URL(page.url()).searchParams.get('revision')).toBe(
    file.revisionId,
  );
  await expect(crumbs).toContainText('architecture');
  await page.getByLabel('当前空间').selectOption(b.id);
  await expect(reader).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '工作区', exact: true }),
  ).toBeVisible();
  for (const key of ['dir', 'file', 'revision', 'filter', 'q', 'type'])
    expect(new URL(page.url()).searchParams.has(key)).toBe(false);
  await expect(table).not.toContainText('decision.md');
  await nav(page, '插件').click();
  await expect(page.getByRole('heading', { name: '已安装插件' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Git 仓库', exact: true }),
  ).toBeVisible();
  await nav(page, '数据源').click();
  const add = page.getByRole('button', { name: '新增数据源' });
  await add.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '关闭添加来源' }),
  ).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('dialog') !== null,
      ),
    ).toBe(true);
  }
  await page.getByLabel('来源名称').fill('cancelled draft');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await expect(page.getByLabel('来源名称')).toHaveValue('');
  await page.getByRole('button', { name: '关闭添加来源' }).click();
  await expect(add).toBeFocused();
  await nav(page, '任务').click();
  await expect(
    page.getByText('尚未执行任务。在来源中同步或生成导航。'),
  ).toBeVisible();
  await page.getByLabel('当前空间').selectOption(f.project.id);
  await page
    .getByRole('navigation', { name: '目录树' })
    .locator('button[title="' + dir + '"]')
    .click();
  await table.getByRole('button', { name: /decision.md/ }).click();
  await expect(reader).toContainText('reverify-multilevel-needle');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    reader.getByRole('button', { name: '关闭', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: evidence + '/' + 'fresh-mobile.png',
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});
test('failed task presents recovery and routes to source configuration', async ({
  page,
  request,
}) => {
  const f = await setup(request, 'missing-reverify-branch');
  await login(page, f.project.id);
  await nav(page, '任务').click();
  await expect(page.getByText('执行失败', { exact: true })).toBeVisible();
  await expect(page.getByText(/最近已发布内容仍保留/)).toBeVisible();
  await page.screenshot({
    path: evidence + '/' + 'failed-task.png',
    fullPage: true,
  });
  await page.getByRole('link', { name: '检查来源配置' }).click();
  await expect(page).toHaveURL(/view=sources/);
  await expect(page.getByRole('heading', { name: '已配置来源' })).toBeVisible();
});
test('live MCP search/read pinned revision, unauthenticated and cross-space denial, source/token revocation', async ({
  request,
}) => {
  const f = await setup(request);
  const file = f.tree.find((x) =>
    x.logicalPath.endsWith('/docs/architecture/decision.md'),
  )!;
  const tr = await request.post(f.base + '/tokens', { headers });
  const reader = await tr.json();
  const other = await request.post('/api/projects', {
    headers,
    data: { name: 'MCP other synthetic' },
  });
  const b = await other.json();
  async function mcp(
    name: string,
    args: Record<string, unknown>,
    bearer: string = reader.token,
  ) {
    const r = await request.post('/mcp', {
      headers: {
        ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    });
    return { status: r.status(), body: await r.json() };
  }
  const s = await mcp('context_search', {
    projectId: f.project.id,
    query: 'reverify-multilevel-needle',
    mode: 'grep',
  });
  expect(s.status).toBe(200);
  const result = s.body.result.structuredContent;
  expect(result.hits[0].file.revisionId).toBe(file.revisionId);
  const args = {
    projectId: f.project.id,
    fileId: file.fileId,
    revisionId: file.revisionId,
  };
  const r = await mcp('context_read', args);
  expect(r.body.result.structuredContent.text).toContain(
    'reverify-multilevel-needle',
  );
  expect(r.body.result.structuredContent.citation.revisionId).toBe(
    file.revisionId,
  );
  expect((await mcp('context_read', args, '')).status).toBe(401);
  const denied = await mcp('context_search', {
    projectId: b.id,
    query: 'reverify-multilevel-needle',
  });
  expect(JSON.stringify(denied.body)).not.toContain('Design decision');
  expect(denied.body.error).toBeTruthy();
  const removed = await request.delete(f.base + '/bindings/' + f.binding.id, {
    headers,
  });
  expect(removed.ok()).toBe(true);
  const revoked = await mcp('context_read', args);
  expect(revoked.body.error.message).toBe('NOT_FOUND');
  expect(JSON.stringify(revoked.body)).not.toContain(
    'reverify-multilevel-needle',
  );
  const sr = await mcp('context_search', {
    projectId: f.project.id,
    query: 'reverify-multilevel-needle',
    freshness: 'include_stale',
  });
  expect(sr.body.result.structuredContent.hits).toHaveLength(0);
  await request.delete('/api/tokens/' + reader.id, { headers });
  expect((await mcp('context_read', args)).status).toBe(401);
});
