import { test, expect, type Page } from '@playwright/test';

const ownerToken = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
const repoUrl = process.env['OPENCONTEXT_E2E_REPO_URL'];
if (!ownerToken || !repoUrl)
  throw new Error(
    'Reader tests require a real server and synthetic Git fixture.',
  );

async function openFixture(page: Page) {
  const headers = { authorization: 'Bearer ' + ownerToken };
  const projectResponse = await page.request.post('/api/projects', {
    headers,
    data: { name: 'Reader regression ' + Date.now() },
  });
  expect(projectResponse.ok()).toBe(true);
  const project = (await projectResponse.json()) as { id: string };
  const base = '/api/projects/' + project.id;
  const bindingResponse = await page.request.post(base + '/bindings', {
    headers,
    data: { name: 'Reader source', repoUrl, branch: 'main' },
  });
  expect(bindingResponse.ok()).toBe(true);
  const binding = (await bindingResponse.json()) as { id: string };
  expect(
    (
      await page.request.post(base + '/bindings/' + binding.id + '/sync', {
        headers,
      })
    ).status(),
  ).toBe(202);
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
  const tree = await page.request.get(base + '/tree', { headers });
  const files = (await tree.json()) as {
    fileId: string;
    revisionId: string;
    logicalPath: string;
  }[];
  const file = files.find((entry) => entry.logicalPath.endsWith('/README.md'))!;
  await page.goto(
    '/?' +
      new URLSearchParams({
        project: project.id,
        view: 'files',
        file: file.fileId,
        revision: file.revisionId,
      }),
  );
  await page.getByLabel('访问 token').fill(ownerToken!);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '固定版本原文' })
      .locator('.markdown-preview'),
  ).toBeVisible();
  return { project, binding, base, headers };
}

test('offline logout immediately hides content and requires explicit reconnect after reload', async ({
  page,
  context,
}) => {
  await openFixture(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: '退出连接', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '连接你的上下文空间' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: '固定版本原文' })).toHaveCount(
    0,
  );
  await expect(page.getByText(/HttpOnly 会话 cookie 可能仍保留/)).toBeVisible();
  // The browser owns an HttpOnly cookie; a failed request cannot clear it.
  expect(
    (await context.cookies()).some((cookie) => cookie.name === 'oc_session'),
  ).toBe(true);
  await context.setOffline(false);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '连接你的上下文空间' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: '固定版本原文' })).toHaveCount(
    0,
  );
  await page.getByLabel('访问 token').fill(ownerToken!);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '固定版本原文' })
      .locator('.markdown-preview'),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem('opencontext.disconnected'),
    ),
  ).toBeNull();
});

test('reader distinguishes historical sources and stale artifacts without replacing the pinned revision', async ({
  page,
}) => {
  await openFixture(page);
  const reader = page.getByRole('region', { name: '固定版本原文' });
  const originalText = await reader.locator('.markdown-preview').innerText();
  const originalUrl = page.url();
  // Rendering contract fixtures only: server freshness rules have separate API
  // integration coverage. Keep real text/identity, varying status and collection.
  let collection = 'sources';
  await page.route('**/api/projects/*/read?*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      file: { freshness: string; collection: string };
    };
    body.file.freshness = 'stale';
    body.file.collection = collection;
    await route.fulfill({ response, json: body });
  });
  await expect(reader.getByText(/正在查看历史来源版本/)).toBeVisible({
    timeout: 8000,
  });
  await expect(reader.getByText(/重新加工/)).toHaveCount(0);
  collection = 'derived';
  await expect(reader.getByText(/此产物已过期/)).toBeVisible({ timeout: 8000 });
  expect(await reader.locator('.markdown-preview').innerText()).toBe(
    originalText,
  );
  expect(page.url()).toBe(originalUrl);
  await reader.getByRole('tab', { name: '版本', exact: true }).click();
  await expect(reader.getByText(/正在查看固定 revision/)).toBeVisible();
});

test('owner source card reflects revocation and disables impossible retries', async ({
  page,
}) => {
  const { base, binding, headers } = await openFixture(page);
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '数据源', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '同步仓库', exact: true }),
  ).toBeEnabled();
  const revoked = await page.request.delete(base + '/bindings/' + binding.id, {
    headers,
  });
  expect(revoked.ok()).toBe(true);
  await expect(page.getByText('已撤销', { exact: true })).toBeVisible({
    timeout: 8000,
  });
  await expect(
    page.getByRole('button', { name: '同步仓库', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '生成 Markdown 导航', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/如需重新授权，请添加新来源/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: '退出连接', exact: true }),
  ).toBeVisible();
});
