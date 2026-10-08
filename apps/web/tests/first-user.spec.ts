import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const token = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
if (!token) throw new Error('Synthetic demo server required.');
test('new empty workspace has a direct source step and scope errors explain safe recovery', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('访问 token').fill(token);
  const projectList = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/projects') &&
      response.request().method() === 'GET' &&
      response.ok(),
  );
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  const existing = await (await projectList).json();
  if (existing.length)
    await page.locator('summary').filter({ hasText: '新建空间' }).click();
  await page.getByLabel('空间名称').fill('First user regression');
  await page.getByRole('button', { name: '创建空间', exact: true }).click();
  const add = page.getByRole('button', { name: '新增数据源', exact: true });
  await expect(add).toBeVisible();
  await add.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await add.click();
  await page
    .getByLabel('来源插件', { exact: true })
    .selectOption('org.opencontext.codex-sessions@0.1.0');
  await page.getByLabel('来源名称').fill('First user sessions');
  await page
    .getByLabel('Export project scope', { exact: true })
    .fill('synthetic-project');
  await page.getByRole('button', { name: '添加来源', exact: true }).click();
  const panel = page.getByRole('region', {
    name: '导入文件 First user sessions',
    exact: true,
  });
  const content = await readFile(
    new URL(
      '../../../plugins/session-connector/fixtures/codex-session.json',
      import.meta.url,
    ),
    'utf8',
  );
  await panel.getByLabel('选择 JSON 导出文件').setInputFiles({
    name: 'synthetic.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      content.replace('"synthetic-project"', '"other-scope"'),
    ),
  });
  await panel
    .getByRole('button', { name: '上传所选文件', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('新建正确 scope');
  await expect(panel.getByRole('alert')).toContainText('不要修改正文');
  await panel.getByLabel('选择 JSON 导出文件').setInputFiles({
    name: 'synthetic.json',
    mimeType: 'application/json',
    buffer: Buffer.from(content),
  });
  await panel
    .getByRole('button', { name: '上传所选文件', exact: true })
    .click();
  await expect(panel.getByText(/导入输入已保存，尚未发布/)).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});
