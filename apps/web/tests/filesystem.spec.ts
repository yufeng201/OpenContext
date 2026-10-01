import { test, expect } from '@playwright/test';

const token = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
const repoUrl = process.env['OPENCONTEXT_E2E_REPO_URL'];
if (!token || !repoUrl)
  throw new Error('Filesystem checks require synthetic fixtures.');

test('filesystem navigation, filtering, fixed preview, tabs, close and modal focus', async ({
  page,
}) => {
  const headers = { authorization: 'Bearer ' + token };
  const response = await page.request.post('/api/projects', {
    headers,
    data: { name: 'Filesystem regression' },
  });
  const project = (await response.json()) as { id: string };
  const base = '/api/projects/' + project.id;
  const bindingResponse = await page.request.post(base + '/bindings', {
    headers,
    data: { name: 'Synthetic filesystem repo', repoUrl, branch: 'main' },
  });
  const binding = (await bindingResponse.json()) as { id: string };
  await page.request.post(base + '/bindings/' + binding.id + '/sync', {
    headers,
  });
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(base + '/runs', { headers })
          ).json()) as { state: string }[]
        )[0]?.state,
    )
    .toBe('published');
  const tree = (await (
    await page.request.get(base + '/tree', { headers })
  ).json()) as { fileId: string; revisionId: string; logicalPath: string }[];
  const file = tree.find((entry) => entry.logicalPath.endsWith('/README.md'))!;
  const directory = file.logicalPath.split('/').slice(0, -1).join('/');
  await page.goto('/?' + new URLSearchParams({ project: project.id }));
  await page.getByLabel('访问 token').fill(token);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: '文件路径' }),
  ).toContainText('工作区');
  await page
    .getByRole('navigation', { name: '目录树' })
    .locator(`button[title="${directory}"]`)
    .click();
  await expect(page).toHaveURL(new RegExp('dir='));
  await page.getByLabel('文件视图').selectOption('rules');
  await expect
    .poll(() => new URL(page.url()).searchParams.get('dir'))
    .toBe(directory);
  await expect(page.getByRole('region', { name: '文件目录' })).toContainText(
    '没有符合筛选的文件',
  );
  await page.getByLabel('文件视图').selectOption('all');
  await expect
    .poll(() => new URL(page.url()).searchParams.get('dir'))
    .toBe(directory);
  const table = page.getByRole('region', { name: '文件目录' });
  await expect(table.getByRole('button', { name: /README.md/ })).toBeVisible();
  await page.getByLabel('搜索当前目录').fill('no-such-file');
  await expect(table).toContainText('没有符合筛选的文件');
  await page.getByLabel('搜索当前目录').fill('README');
  await table.getByRole('button', { name: /README.md/ }).click();
  const reader = page.getByRole('region', { name: '固定版本原文' });
  await expect(reader).toContainText('browser-needle');
  await expect(page).toHaveURL(new RegExp(file.revisionId));
  await reader.getByRole('tab', { name: '版本', exact: true }).click();
  await expect(reader).toContainText(file.fileId);
  await expect(reader).toContainText(file.revisionId);
  await reader.getByRole('tab', { name: '来源', exact: true }).click();
  await expect(reader).toContainText(binding.id);
  await reader.getByRole('tab', { name: '预览', exact: true }).click();
  await expect(reader.locator('.markdown-preview')).toContainText(
    'browser-needle',
  );
  await table.getByRole('button', { name: /README.md/ }).click();
  await expect(page.getByRole('region', { name: '固定版本原文' })).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: '网格视图' }).click();
  await expect(page.getByRole('button', { name: '网格视图' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await reader.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(reader).toHaveCount(0);
  await page.getByRole('button', { name: '返回上级目录' }).click();
  await expect(
    page.getByRole('navigation', { name: '文件路径' }),
  ).not.toContainText(directory.split('/').at(-1)!);
  await page.goBack();
  await expect(table.getByRole('button', { name: /README.md/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '数据源', exact: true })
    .click();
  const add = page.getByRole('button', { name: '新增数据源' });
  await add.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '关闭添加来源' }),
  ).toBeFocused();
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press(index < 6 ? 'Tab' : 'Shift+Tab');
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('dialog') !== null,
      ),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await page.getByRole('button', { name: '关闭添加来源' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
