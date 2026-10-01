import { readFile } from 'node:fs/promises';
import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import type {
  PluginDescriptor,
  Binding,
  ImportedObjectRef,
  Run,
} from '@opencontext/contracts';

const ownerToken = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
if (!ownerToken)
  throw new Error(
    'Session browser tests require a synthetic owner token and real server.',
  );
const headers = { authorization: 'Bearer ' + ownerToken };
const packageRef = 'org.opencontext.codex-sessions@0.1.0';
const filename = 'session-browser.json';
async function fixture(provider: 'codex' | 'claude' = 'codex') {
  const raw = await readFile(
    new URL(
      `../../../plugins/session-connector/fixtures/${provider}-session.json`,
      import.meta.url,
    ),
    'utf8',
  );
  const content = raw.replace(
    /Memory:|Rule:|Experience:|记忆：|规则：|经验：/,
    (marker) => marker + ' session-browser-needle ',
  );
  if (!content.includes('session-browser-needle'))
    throw new Error('Fixture must contain an explicit candidate marker.');
  return {
    content,
    projectScope: (JSON.parse(content) as { projectScope: string })
      .projectScope,
  };
}
async function project(request: APIRequestContext, name: string) {
  const response = await request.post('/api/projects', {
    headers,
    data: { name },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string };
}
async function login(page: Page, projectId: string, token = ownerToken!) {
  await page.goto(
    '/?' + new URLSearchParams({ project: projectId, view: 'sources' }),
  );
  await page.getByLabel('访问 token').fill(token);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '退出连接', exact: true }),
  ).toBeVisible();
}
async function createFromForm(
  page: Page,
  id: string,
  scope: string,
  selectedPackageRef = packageRef,
) {
  const metadata = await page.request.get('/api/plugins', { headers });
  const plugins = (await metadata.json()) as PluginDescriptor[];
  const connector = plugins.find(
    (plugin) => plugin.packageRef === selectedPackageRef,
  )!;
  expect(connector?.available).toBe(true);
  await page.getByRole('button', { name: '新增数据源' }).click();
  await page
    .getByLabel('来源插件', { exact: true })
    .selectOption(selectedPackageRef);
  await expect(page.getByLabel('处理插件', { exact: true })).toHaveValue(
    connector.recommendedProcessorRef!,
  );
  await expect(page.getByLabel('仓库地址')).toHaveCount(0);
  await page.getByLabel('来源名称').fill('Synthetic session import');
  const scopeField = connector.fields.find(
    (field) => field.key === 'projectScope',
  )!;
  await page.getByLabel(scopeField.label, { exact: true }).fill(scope);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/projects/${id}/bindings`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '添加来源', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const submitted = response.request().postDataJSON() as {
    connector: { config: object };
  };
  expect(submitted.connector.config).toEqual({ projectScope: scope });
  return (await response.json()) as Binding;
}
async function upload(page: Page, binding: Binding, content: string) {
  const panel = page.getByRole('region', {
    name: `导入文件 ${binding.name}`,
    exact: true,
  });
  await panel.getByLabel('选择 JSON 导出文件').setInputFiles({
    name: filename,
    mimeType: 'application/json',
    buffer: Buffer.from(content),
  });
  await expect(panel).toContainText(`待上传：${filename}`);
  await expect(panel).not.toContainText('session-browser-needle');
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/bindings/${binding.id}/imports`) &&
      response.request().method() === 'POST',
  );
  await panel
    .getByRole('button', { name: '上传所选文件', exact: true })
    .click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await expect(panel.getByText(/导入输入已保存，尚未发布/)).toBeVisible();
  return (await response.json()) as ImportedObjectRef;
}
async function run(page: Page, binding: Binding, kind: 'sync' | 'process') {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/bindings/${binding.id}/${kind}`) &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: kind === 'sync' ? '同步导入' : /^生成 / })
    .click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const requested = (await response.json()) as Run;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/projects/${binding.projectId}/runs`,
          { headers },
        );
        return ((await response.json()) as Run[]).find(
          (entry) => entry.id === requested.id,
        )?.state;
      },
      { timeout: 30000 },
    )
    .toBe('published');
  // Wait for the UI's task query to catch up before another action.
  await expect(
    page.getByRole('button', { name: '同步导入', exact: true }),
  ).toBeEnabled({ timeout: 10000 });
}
async function go(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name, exact: true })
    .click();
}
async function search(page: Page, query: string) {
  await go(page, '搜索');
  await page.getByLabel('搜索内容').fill(query);
  await page.getByLabel('检索方式').selectOption('grep');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
}

test('selected session export → published source → candidates → shared recall, replacement and explicit deletion', async ({
  page,
}) => {
  const data = await fixture();
  const space = await project(
    page.request,
    'Session browser lifecycle ' + Date.now(),
  );
  await login(page, space.id);
  const binding = await createFromForm(page, space.id, data.projectScope);
  await upload(page, binding, data.content);
  expect(
    await (
      await page.request.get(`/api/projects/${space.id}/tree`, { headers })
    ).json(),
  ).toEqual([]);
  await run(page, binding, 'sync');
  await run(page, binding, 'process');
  await search(page, 'session-browser-needle');
  await expect(page.getByText('原文', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('产物', { exact: true }).first()).toBeVisible();
  await page
    .getByRole('button')
    .filter({ hasText: 'derived/' })
    .first()
    .click();
  const reader = page.getByRole('region', { name: '固定版本原文' });
  await expect(reader.locator('.markdown-preview')).toContainText(
    'session-browser-needle',
  );
  await expect(reader).toContainText('oc://');
  const oldUrl = page.url();
  await page.screenshot({
    path: '/tmp/opencontext-web-evidence/session-shared-recall.png',
    fullPage: true,
  });
  await go(page, '数据源');
  await upload(
    page,
    binding,
    data.content.replaceAll(
      'session-browser-needle',
      'session-browser-updated',
    ),
  );
  await run(page, binding, 'sync');
  await run(page, binding, 'process');
  await search(page, 'session-browser-updated');
  await expect(page.getByText('产物', { exact: true }).first()).toBeVisible();
  await go(page, '数据源');
  const panel = page.getByRole('region', { name: `导入文件 ${binding.name}` });
  await panel
    .getByRole('button', { name: `删除导入 ${filename}`, exact: true })
    .click();
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: `删除导入 ${filename}`, exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: `删除导入 ${filename}`, exact: true })
    .click();
  await panel.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(panel.getByText(/已从导入输入集合删除/)).toBeVisible();
  expect(
    (
      await (
        await page.request.get(`/api/projects/${space.id}/tree`, { headers })
      ).json()
    ).length,
  ).toBeGreaterThan(0);
  await run(page, binding, 'sync');
  await search(page, 'session-browser-updated');
  await expect(page.getByText('0 条结果', { exact: true })).toBeVisible();
  await page.goto(oldUrl);
  await expect(reader.getByText(/已清除缓存正文/)).toBeVisible();
  await expect(reader.locator('.markdown-preview')).toHaveCount(0);
});

test('session import conflict requires reselection, pending file is scoped, and readers cannot see imports', async ({
  page,
  browser,
}) => {
  const data = await fixture();
  const a = await project(page.request, 'Session scope A ' + Date.now());
  const b = await project(page.request, 'Session scope B ' + Date.now());
  await login(page, a.id);
  const binding = await createFromForm(page, a.id, data.projectScope);
  const first = await upload(page, binding, data.content);
  const path = `/api/projects/${a.id}/bindings/${binding.id}/imports`;
  const panel = page.getByRole('region', { name: `导入文件 ${binding.name}` });
  await panel.getByLabel('选择 JSON 导出文件').setInputFiles({
    name: filename,
    mimeType: 'application/json',
    buffer: Buffer.from(
      data.content.replace('session-browser-needle', 'candidate-client'),
    ),
  });
  let release = () => {};
  let held = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**' + path, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    held = true;
    await wait;
    await route.continue();
  });
  await panel
    .getByRole('button', { name: '上传所选文件', exact: true })
    .click();
  await expect.poll(() => held).toBe(true);
  const concurrent = await page.request.post(path, {
    headers,
    data: {
      filename,
      content: data.content.replace(
        'session-browser-needle',
        'candidate-other-client',
      ),
      expectedObjectId: first.id,
    },
  });
  expect(concurrent.ok()).toBe(true);
  release();
  await expect(panel.getByText(/IMPORT_CONFLICT/)).toBeVisible();
  await expect(
    panel.getByRole('button', { name: '上传所选文件', exact: true }),
  ).toBeDisabled();
  await page.unroute('**' + path);
  await upload(page, binding, data.content);
  await panel.getByLabel('选择 JSON 导出文件').setInputFiles({
    name: 'not-uploaded.json',
    mimeType: 'application/json',
    buffer: Buffer.from(data.content),
  });
  await page.getByLabel('当前空间').selectOption(b.id);
  await expect(
    page.getByRole('region', { name: `导入文件 ${binding.name}` }),
  ).toHaveCount(0);
  await page.getByLabel('当前空间').selectOption(a.id);
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '数据源', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: '上传所选文件', exact: true }),
  ).toBeDisabled();
  await run(page, binding, 'sync');
  const createdToken = await page.request.post(`/api/projects/${a.id}/tokens`, {
    headers,
  });
  expect(createdToken.ok()).toBe(true);
  const token = (await createdToken.json()) as { token: string };
  const readerContext = await browser.newContext({
    baseURL: process.env['OPENCONTEXT_E2E_URL'] ?? 'http://127.0.0.1:4310',
  });
  try {
    const readPage = await readerContext.newPage();
    const denied: string[] = [];
    readPage.on('response', (response) => {
      if (response.status() === 403) denied.push(response.url());
    });
    await login(readPage, a.id, token.token);
    await expect(
      readPage.getByRole('heading', { name: binding.name }),
    ).toBeVisible();
    await expect(
      readPage.getByRole('region', { name: `导入文件 ${binding.name}` }),
    ).toHaveCount(0);
    await expect(readPage.getByLabel('来源插件', { exact: true })).toHaveCount(
      0,
    );
    await readPage.waitForTimeout(1000);
    expect(denied).toEqual([]);
    const revoked = await page.request.delete(
      `/api/projects/${a.id}/bindings/${binding.id}`,
      { headers },
    );
    expect(revoked.ok()).toBe(true);
    await expect(page.getByText('已撤销', { exact: true })).toBeVisible({
      timeout: 8000,
    });
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '同步导入', exact: true }),
    ).toBeDisabled();
    await expect(
      readPage.getByRole('heading', { name: binding.name }),
    ).toHaveCount(0, { timeout: 8000 });
  } finally {
    await readerContext.close();
  }
});

test('Claude SDK export uses the same descriptor form and source/candidate recall', async ({
  page,
}) => {
  const data = await fixture('claude');
  const space = await project(
    page.request,
    'Claude session browser ' + Date.now(),
  );
  await login(page, space.id);
  const binding = await createFromForm(
    page,
    space.id,
    data.projectScope,
    'org.opencontext.claude-sessions@0.1.0',
  );
  await upload(page, binding, data.content);
  await run(page, binding, 'sync');
  await run(page, binding, 'process');
  await search(page, 'session-browser-needle');
  await expect(page.getByText('原文', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('产物', { exact: true }).first()).toBeVisible();
  await page
    .getByRole('button')
    .filter({ hasText: 'derived/' })
    .first()
    .click();
  const reader = page.getByRole('region', { name: '固定版本原文' });
  await expect(reader.locator('.markdown-preview')).toContainText(
    'session-browser-needle',
  );
  await expect(reader).toContainText('oc://');
});
