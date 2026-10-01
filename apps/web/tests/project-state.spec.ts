import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

const ownerToken = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
const repoUrl = process.env['OPENCONTEXT_E2E_REPO_URL'];
if (!ownerToken || !repoUrl)
  throw new Error(
    'Project state tests require a real server and synthetic Git fixture.',
  );

async function createProject(request: APIRequestContext, label: string) {
  const response = await request.post('/api/projects', {
    headers: { authorization: 'Bearer ' + ownerToken },
    data: { name: `${label} ${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string };
}

async function loginAt(page: Page, projectId: string) {
  await page.goto(
    '/?' + new URLSearchParams({ project: projectId, view: 'sources' }),
  );
  await page.getByLabel('访问 token').fill(ownerToken!);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  await page.getByRole('button', { name: '新增数据源' }).click();
  await expect(page.getByRole('heading', { name: '添加来源' })).toBeVisible();
}

test('switching projects resets the source draft to the new project defaults', async ({
  page,
}) => {
  const a = await createProject(page.request, 'Draft A');
  const b = await createProject(page.request, 'Draft B');
  await loginAt(page, a.id);
  await page.getByLabel('来源名称').fill('Only belongs to A');
  await page.getByLabel('仓库地址').fill(repoUrl!);
  await page.getByLabel('分支', { exact: true }).fill('draft-a');
  await page.getByLabel('当前空间').selectOption(b.id);
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '数据源', exact: true })
    .click();
  await page.getByRole('button', { name: '新增数据源' }).click();

  await expect(page.getByLabel('来源名称')).toHaveValue('');
  await expect(page.getByLabel('仓库地址')).toHaveValue('');
  await expect(page.getByLabel('分支', { exact: true })).toHaveValue('main');
  await expect(
    page.getByRole('button', { name: '添加来源', exact: true }),
  ).toBeEnabled();
});

test('a delayed real create response from A cannot reset the new draft in B', async ({
  page,
}) => {
  const a = await createProject(page.request, 'Pending A');
  const b = await createProject(page.request, 'Pending B');
  await loginAt(page, a.id);
  const path = `/api/projects/${a.id}/bindings`;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let responseHeld = false;
  let createdProject: string | undefined;
  await page.route('**' + path, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    // This is the real API response, held only to make the completion order deterministic.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    createdProject = ((await response.json()) as { projectId: string })
      .projectId;
    responseHeld = true;
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByLabel('来源名称').fill('Created in A');
    await page.getByLabel('仓库地址').fill(repoUrl!);
    await page.getByRole('button', { name: '添加来源', exact: true }).click();
    await expect.poll(() => responseHeld).toBe(true);
    await page.getByLabel('当前空间').selectOption(b.id);
    await page
      .getByRole('navigation', { name: '主要导航' })
      .getByRole('link', { name: '数据源', exact: true })
      .click();
    await page.getByRole('button', { name: '新增数据源' }).click();
    await page.getByLabel('来源名称').fill('Unsaved B draft');
    await page.getByLabel('仓库地址').fill(repoUrl!);
    await page.getByLabel('分支', { exact: true }).fill('draft-b');
    const received = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST',
    );
    release();
    await received;
    // Let the resolved fetch body and React mutation callbacks finish before
    // checking that the unrelated B draft survived the late completion.
    await page.waitForTimeout(350);
    expect(createdProject).toBe(a.id);
    await expect(page.getByLabel('来源名称')).toHaveValue('Unsaved B draft');
    await expect(page.getByLabel('仓库地址')).toHaveValue(repoUrl!);
    await expect(page.getByLabel('分支', { exact: true })).toHaveValue(
      'draft-b',
    );
    await expect(
      page.getByRole('button', { name: '添加来源', exact: true }),
    ).toBeEnabled();
    const bSources = await page.request.get(`/api/projects/${b.id}/bindings`);
    expect(await bSources.json()).toEqual([]);
  } finally {
    release();
    await page.unroute('**' + path);
  }
});
