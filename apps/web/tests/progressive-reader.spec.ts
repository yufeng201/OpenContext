import { test, expect } from '@playwright/test';
const token = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
const repoUrl = process.env['OPENCONTEXT_E2E_REPO_URL'];
if (!token || !repoUrl) throw new Error('Explicit synthetic fixture required.');
test('Reader starts bounded, discovers headings, jumps, continues and explicitly reads the same full revision', async ({
  page,
  request,
}) => {
  const headers = { authorization: 'Bearer ' + token };
  const project = await (
    await request.post('/api/projects', {
      headers,
      data: { name: 'Progressive Reader' },
    })
  ).json();
  const base = '/api/projects/' + project.id;
  const binding = await (
    await request.post(base + '/bindings', {
      headers,
      data: { name: 'Large synthetic Markdown', repoUrl, branch: 'main' },
    })
  ).json();
  await request.post(base + '/bindings/' + binding.id + '/sync', { headers });
  await expect
    .poll(
      async () =>
        (
          (await (await request.get(base + '/runs', { headers })).json()) as {
            state: string;
          }[]
        )[0]?.state,
    )
    .toBe('published');
  const files = await (await request.get(base + '/tree', { headers })).json();
  const file = files.find((f: { logicalPath: string }) =>
    f.logicalPath.endsWith('/docs/large.md'),
  );
  expect(file).toBeTruthy();
  expect(file.bytes).toBeGreaterThan(8192);
  await page.goto(
    '/?' +
      new URLSearchParams({
        project: project.id,
        file: file.fileId,
        revision: file.revisionId,
      }),
  );
  await page.getByLabel('访问 token').fill(token);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  const reader = page.getByRole('region', { name: '固定版本原文' }),
    preview = reader.locator('.markdown-preview');
  await expect(reader.getByRole('group', { name: '渐进式读取' })).toContainText(
    '本次 8192 bytes',
  );
  await expect(preview).not.toContainText('budget-tail-needle');
  const directory = reader.getByRole('navigation', {
    name: 'Markdown 章节目录',
  });
  await directory.getByRole('button', { name: /^End · 第 / }).click();
  await expect(preview).toContainText('budget-tail-needle');
  await reader
    .getByRole('button', { name: '从头有限读取', exact: true })
    .click();
  await expect(preview).not.toContainText('budget-tail-needle');
  await reader.getByRole('button', { name: '读取下一段', exact: true }).click();
  await expect(preview.locator('pre')).toContainText('synthetic-budget-line');
  await reader.getByRole('button', { name: '读取全文', exact: true }).click();
  await expect(preview).toContainText('budget-tail-needle');
  await expect(reader.getByRole('group', { name: '渐进式读取' })).toContainText(
    `全文 ${file.bytes} bytes`,
  );
  expect(new URL(page.url()).searchParams.get('revision')).toBe(
    file.revisionId,
  );
  await page.reload();
  await expect(reader.getByRole('group', { name: '渐进式读取' })).toContainText(
    '本次 8192 bytes',
  );
  await expect(preview).not.toContainText('budget-tail-needle');
});
