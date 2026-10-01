import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import type { Binding, PluginDescriptor, Run } from '@opencontext/contracts';

const token = process.env['OPENCONTEXT_E2E_OWNER_TOKEN'];
if (!token)
  throw new Error(
    'Feishu browser checks require the explicit synthetic fixture server/token.',
  );
const headers = { authorization: `Bearer ${token}` };
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});
const config = {
  realm: 'feishu',
  chatId: 'oc_synthetic_group',
  secretRef: 'secret:feishu/synthetic',
  startTime: '2026-09-30T00:00:00Z',
  endTime: 'now',
  overlapSeconds: '300',
};

async function createProject(request: APIRequestContext, name: string) {
  const response = await request.post('/api/projects', {
    headers,
    data: { name },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string };
}
async function login(page: Page, projectId: string) {
  await page.goto(
    '/?' + new URLSearchParams({ project: projectId, view: 'sources' }),
  );
  await expect(page).toHaveTitle(/OpenContext/);
  await page.getByLabel('访问 token').fill(token!);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '退出连接', exact: true }),
  ).toBeVisible();
}
async function createBinding(
  page: Page,
  projectId: string,
  secretRef = config.secretRef,
) {
  const response = await page.request.get('/api/plugins', { headers });
  expect(response.ok()).toBe(true);
  const descriptors = (await response.json()) as PluginDescriptor[];
  const connector = descriptors.find(
    (plugin) => plugin.packageRef === 'org.opencontext.feishu-chat@0.1.0',
  )!;
  expect(connector?.available).toBe(true);
  expect(connector.supportsConnectionTest).toBe(true);
  await page.getByRole('button', { name: '新增数据源' }).click();
  await page
    .getByLabel('来源插件', { exact: true })
    .selectOption(connector.packageRef);
  await expect(page.getByLabel('处理插件', { exact: true })).toHaveValue(
    connector.recommendedProcessorRef!,
  );
  await page.getByLabel('来源名称').fill('Synthetic group archive');
  const values = { ...config, secretRef };
  for (const field of connector.fields) {
    const value = values[field.key as keyof typeof values];
    const input = page.getByLabel(field.label, { exact: true });
    if (field.kind === 'select') await input.selectOption(value);
    else await input.fill(value);
  }
  const pending = page.waitForResponse(
    (entry) =>
      entry.url().endsWith(`/api/projects/${projectId}/bindings`) &&
      entry.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '添加来源', exact: true }).click();
  const created = await pending;
  expect(created.ok()).toBe(true);
  expect(created.request().postDataJSON().connector.config).toEqual(values);
  return (await created.json()) as Binding;
}
function panel(page: Page, binding: Binding) {
  return page.getByRole('region', {
    name: `连接诊断 ${binding.name}`,
    exact: true,
  });
}
async function connection(page: Page, binding: Binding) {
  const response = page.waitForResponse(
    (entry) =>
      entry.url().endsWith(`/bindings/${binding.id}/test-connection`) &&
      entry.request().method() === 'POST',
  );
  await panel(page, binding)
    .getByRole('button', { name: '测试连接', exact: true })
    .click();
  const result = await response;
  expect(result.ok()).toBe(true);
  return result.json();
}
async function run(page: Page, binding: Binding, kind: 'sync' | 'process') {
  const response = page.waitForResponse(
    (entry) =>
      entry.url().endsWith(`/bindings/${binding.id}/${kind}`) &&
      entry.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: kind === 'sync' ? '同步来源' : /^生成 / })
    .click();
  const requested = await response;
  expect(requested.status()).toBe(202);
  const run = (await requested.json()) as Run;
  await expect
    .poll(
      async () => {
        const runs = await page.request.get(
          `/api/projects/${binding.projectId}/runs`,
          { headers },
        );
        return ((await runs.json()) as Run[]).find(
          (entry) => entry.id === run.id,
        )?.state;
      },
      { timeout: 30_000 },
    )
    .toBe('published');
  await expect(
    page.getByRole('button', { name: '同步来源', exact: true }),
  ).toBeEnabled();
}

test('Feishu simulated group configuration → diagnosis → sync → candidate → shared fixed citation', async ({
  page,
}) => {
  const project = await createProject(
    page.request,
    'Feishu browser ' + Date.now(),
  );
  await login(page, project.id);
  const binding = await createBinding(page, project.id);
  const result = await connection(page, binding);
  expect(result.status).toBe('reachable');
  expect(result.evidence).toBe('simulated');
  await expect(
    panel(page, binding).getByText('模拟接口验证，未连接真实飞书', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel(page, binding).getByText('指定群历史接口可读', { exact: true }),
  ).toHaveCount(0);
  expect(
    await (
      await page.request.get(`/api/projects/${project.id}/tree`, { headers })
    ).json(),
  ).toEqual([]);
  expect(
    await (
      await page.request.get(`/api/projects/${project.id}/runs`, { headers })
    ).json(),
  ).toEqual([]);
  await page.screenshot({
    path: '/tmp/opencontext-web-evidence/feishu-diagnosis-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/opencontext-web-evidence/feishu-diagnosis-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await run(page, binding, 'sync');
  await run(page, binding, 'process');
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '搜索', exact: true })
    .click();
  await page.getByLabel('搜索内容').fill('feishu-amber-plan');
  await page.getByLabel('检索方式').selectOption('grep');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('原文', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('产物', { exact: true }).first()).toBeVisible();
  await page
    .getByRole('button')
    .filter({ hasText: 'derived/' })
    .first()
    .click();
  const reader = page.getByRole('region', { name: '固定版本原文' });
  await expect(reader.locator('.markdown-preview')).toContainText(
    'feishu-amber-plan',
  );
  await expect(reader.locator('.markdown-preview')).toContainText('simulated');
  await expect(reader).toContainText('oc://');
  await page.screenshot({
    path: '/tmp/opencontext-web-evidence/feishu-shared-recall.png',
    fullPage: true,
  });
});

test('Feishu missing server secret is blocked without a token-entry shortcut or publication', async ({
  page,
}) => {
  const project = await createProject(
    page.request,
    'Feishu missing secret ' + Date.now(),
  );
  await login(page, project.id);
  const binding = await createBinding(
    page,
    project.id,
    'secret:feishu/missing',
  );
  const result = await connection(page, binding);
  expect(result.status).toBe('blocked');
  expect(result.code).toBe('SECRET_NOT_CONFIGURED');
  await expect(panel(page, binding)).toContainText('管理员');
  await expect(panel(page, binding)).toContainText('不要在表单中粘贴 token');
  await expect(page.getByLabel('访问 token')).toHaveCount(0);
  expect(
    await (
      await page.request.get(`/api/projects/${project.id}/tree`, { headers })
    ).json(),
  ).toEqual([]);
});

test('Feishu diagnosis clears on project change, cancellation and revocation and recovers after offline failure', async ({
  page,
}) => {
  const a = await createProject(
    page.request,
    'Feishu diagnostic A ' + Date.now(),
  );
  const b = await createProject(
    page.request,
    'Feishu diagnostic B ' + Date.now(),
  );
  await login(page, a.id);
  const binding = await createBinding(page, a.id);
  const diagnostic = panel(page, binding);
  let diagnosticRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith(`/bindings/${binding.id}/test-connection`)
    )
      diagnosticRequests += 1;
  });
  await connection(page, binding);
  await page.getByLabel('当前空间').selectOption(b.id);
  await expect(diagnostic).toHaveCount(0);
  await page.getByLabel('当前空间').selectOption(a.id);
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '数据源', exact: true })
    .click();
  await expect(
    diagnostic.getByText('模拟接口验证，未连接真实飞书', { exact: true }),
  ).toHaveCount(0);
  const routePattern = `**/bindings/${binding.id}/test-connection`;
  let release = () => {};
  let held = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(routePattern, async (route) => {
    // Delay a real request; never manufacture a diagnostic response.
    held = true;
    await wait;
    await route.continue().catch(() => undefined);
  });
  try {
    await diagnostic
      .getByRole('button', { name: '测试连接', exact: true })
      .click();
    await expect.poll(() => held).toBe(true);
    await expect(
      diagnostic.getByRole('button', { name: '测试中…', exact: true }),
    ).toBeDisabled();
    await diagnostic
      .getByRole('button', { name: '取消测试', exact: true })
      .click();
    release();
    await expect(diagnostic).toContainText('已取消等待并清除结果');
    await expect(
      diagnostic.getByText('模拟接口验证，未连接真实飞书', { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
    await page.unroute(routePattern);
  }
  await page.context().setOffline(true);
  let requestsAfterOfflineFailure: number;
  try {
    await diagnostic
      .getByRole('button', { name: '测试连接', exact: true })
      .click();
    await expect(diagnostic.getByRole('alert')).toContainText('无法连接服务器');
    requestsAfterOfflineFailure = diagnosticRequests;
  } finally {
    await page.context().setOffline(false);
  }
  await page.waitForTimeout(500);
  expect(diagnosticRequests).toBe(requestsAfterOfflineFailure);
  await connection(page, binding);
  await expect(
    diagnostic.getByText('模拟接口验证，未连接真实飞书', { exact: true }),
  ).toBeVisible();
  const response = await page.request.delete(
    `/api/projects/${a.id}/bindings/${binding.id}`,
    { headers },
  );
  expect(response.ok()).toBe(true);
  await expect(diagnostic).toHaveCount(0, { timeout: 8000 });
  await expect(
    page.getByRole('button', { name: '同步来源', exact: true }),
  ).toBeDisabled();
});
