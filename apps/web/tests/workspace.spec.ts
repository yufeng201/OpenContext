import { test, expect } from '@playwright/test';

const ownerToken = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
const repoUrl = process.env['OPENCONTEXT_E2E_REPO_URL'];
if (!ownerToken || !repoUrl) {
  throw new Error(
    'Real API browser tests require OPENCONTEXT_E2E_OWNER_TOKEN and OPENCONTEXT_E2E_REPO_URL pointing to synthetic fixtures. No mock/skip fallback.',
  );
}

test('real Git → source search → fixed revision → derived navigation → logout', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().includes('401 (Unauthorized)')
    )
      errors.push(message.text());
  });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenContext · 上下文空间');
  await expect(
    page.getByRole('heading', { name: '连接你的上下文空间' }),
  ).toBeVisible();
  await page.getByLabel('访问 token').fill(ownerToken);
  await page.getByRole('button', { name: '连接空间' }).click();
  await expect(page.getByRole('button', { name: '退出连接' })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await page.getByLabel('空间名称').isVisible()) ||
        (await page.getByText('新建空间', { exact: true }).isVisible()),
    )
    .toBe(true);
  const name = `浏览器验证 ${Date.now()}`;
  if (!(await page.getByLabel('空间名称').isVisible())) {
    await page.getByText('新建空间', { exact: true }).click();
  }
  await page.getByLabel('空间名称').fill(name);
  await page.getByRole('button', { name: '创建空间' }).click();
  await expect(
    page.getByRole('heading', { name: '添加 Git 仓库' }),
  ).toBeVisible();
  await page.getByLabel('来源名称').fill('合成仓库');
  await page.getByLabel('仓库地址').fill(repoUrl);
  await page.getByLabel('分支', { exact: true }).fill('main');
  await page.getByRole('button', { name: '添加来源', exact: true }).click();
  await expect(page.getByRole('heading', { name: '合成仓库' })).toBeVisible();
  await page.getByRole('button', { name: '同步仓库' }).click();
  await expect(page.getByText('已有来源版本', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/^head /)).not.toContainText('尚未发布');
  await page.screenshot({
    path: '/tmp/opencontext-web-evidence/desktop-sources.png',
    fullPage: true,
  });
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '任务', exact: true })
    .click();
  await page
    .getByText(/^未摄入 \d+ 个条目$/)
    .first()
    .click();
  await expect(page.getByText(/asset\.bin/)).toBeVisible();
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '搜索', exact: true })
    .click();
  await page.getByLabel('搜索内容').fill('browser-needle');
  await page.getByLabel('检索方式').selectOption('grep');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('0 条结果', { exact: true })).not.toBeVisible();
  const fileButton = page
    .getByRole('button')
    .filter({ hasText: 'README.md' })
    .first();
  await expect(fileButton).toBeVisible();
  await fileButton.click();
  await expect(
    page.getByRole('region', { name: '固定版本原文' }),
  ).toContainText('browser-needle');
  await expect(
    page.getByRole('region', { name: '固定版本原文' }),
  ).toContainText('oc://');
  await expect(page).toHaveURL(/revision=/);
  await page.reload();
  await expect(
    page.getByRole('region', { name: '固定版本原文' }),
  ).toContainText('browser-needle');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.screenshot({
    path: '/tmp/opencontext-web-evidence/desktop-read.png',
    fullPage: true,
  });
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '来源', exact: true })
    .click();
  await page.getByRole('button', { name: '生成 Markdown 导航' }).click();
  await expect(
    page.getByRole('button', { name: '生成 Markdown 导航' }),
  ).toBeEnabled({ timeout: 30_000 });
  await expect(
    page.getByText('任务状态：内容已发布，可到“任务”查看记录。'),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '搜索', exact: true })
    .click();
  await page.getByLabel('搜索内容').fill('browser-needle');
  await page.getByLabel('检索方式').selectOption('grep');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('原文', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('产物', { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: '/tmp/opencontext-web-evidence/desktop-shared-recall.png',
    fullPage: true,
  });
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '文件', exact: true })
    .click();
  await expect(page.getByText('产物', { exact: true }).first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('navigation', { name: '主要导航' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/opencontext-web-evidence/mobile-files.png',
    fullPage: true,
  });
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  await page.getByRole('button', { name: '退出连接' }).click();
  await expect(
    page.getByRole('heading', { name: '连接你的上下文空间' }),
  ).toBeVisible();
  await expect(
    page.getByText('browser-needle', { exact: false }),
  ).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('revoking a source clears an already-open fixed revision without manual refresh', async ({
  page,
}) => {
  const headers = { authorization: 'Bearer ' + ownerToken };
  const projectResponse = await page.request.post('/api/projects', {
    headers,
    data: { name: 'Revocation regression ' + Date.now() },
  });
  expect(projectResponse.ok()).toBe(true);
  const project = (await projectResponse.json()) as { id: string };
  const base = '/api/projects/' + project.id;
  const bindingResponse = await page.request.post(base + '/bindings', {
    headers,
    data: { name: 'Revocation fixture', repoUrl, branch: 'main' },
  });
  expect(bindingResponse.ok()).toBe(true);
  const binding = (await bindingResponse.json()) as { id: string };
  const runResponse = await page.request.post(
    base + '/bindings/' + binding.id + '/sync',
    { headers },
  );
  expect(runResponse.status()).toBe(202);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(base + '/runs', { headers });
        const runs = (await response.json()) as { state: string }[];
        return runs[0]?.state;
      },
      { timeout: 30_000 },
    )
    .toBe('published');
  const response = await page.request.get(base + '/tree', { headers });
  const files = (await response.json()) as {
    fileId: string;
    revisionId: string;
    logicalPath: string;
  }[];
  const file = files.find((item) => item.logicalPath.endsWith('/README.md'))!;
  await page.goto(
    '/?' +
      new URLSearchParams({
        project: project.id,
        view: 'files',
        file: file.fileId,
        revision: file.revisionId,
      }),
  );
  await page.getByLabel('访问 token').fill(ownerToken);
  await page.getByRole('button', { name: '连接空间' }).click();
  const reader = page.getByRole('region', { name: '固定版本原文' });
  await expect(reader.locator('pre')).toContainText('browser-needle');
  const revoked = await page.request.delete(base + '/bindings/' + binding.id, {
    headers,
  });
  expect(revoked.ok()).toBe(true);
  await expect(reader).toContainText('已清除缓存正文', { timeout: 8000 });
  await expect(reader.locator('pre')).toHaveCount(0);
  await expect(reader).not.toContainText(file.logicalPath);
  await expect(
    reader.getByRole('button', { name: '复制固定引用' }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('region', { name: '固定版本原文' }),
  ).toContainText('已清除缓存正文');
});
