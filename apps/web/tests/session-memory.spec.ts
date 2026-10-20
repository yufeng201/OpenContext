import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const evidence =
  process.env['OPENCONTEXT_UI_EVIDENCE'] ?? '/tmp/opencontext-memory-ui';
let child: ChildProcess;
type Fixture = {
  origin: string;
  owner: string;
  root: string;
  selected: string;
  raw: string;
  response: { taskId: string; candidates: { markdown: string }[] };
  projectId: string;
};
async function fixture(mode = 'upload'): Promise<Fixture> {
  child = spawn(
    process.execPath,
    ['tests/fixtures/session-memory-browser.ts', mode],
    {
      cwd: resolve(import.meta.dirname, '../../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '' },
    },
  );
  return await new Promise((resolve, reject) => {
    let text = '';
    let errors = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('fixture startup timed out ' + errors));
    }, 15000);
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk);
    });
    child.stdout!.on('data', (chunk) => {
      text += String(chunk);
      if (text.includes('\n')) {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(text.split('\n')[0]!));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code) reject(new Error('fixture failed ' + errors));
    });
  });
}
test.afterEach(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
async function login(page: Page, f: Fixture, token = f.owner) {
  await page.goto(f.origin + '/?view=memory');
  await page.getByLabel('访问 token').fill(token);
  await page.getByRole('button', { name: '连接空间', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出连接' })).toBeVisible();
}
const auth = (f: Fixture) => ({ authorization: `Bearer ${f.owner}` });
const submit = async (page: Page, f: Fixture, response = f.response) => {
  const result = await page.request.post(
    f.origin + '/api/session-memory/submit',
    { headers: auth(f), data: response },
  );
  expect(result.ok(), await result.text()).toBe(true);
  return result.json();
};
const approve = (page: Page) =>
  page.getByRole('button', { name: '批准当前版本并发布', exact: true });
const confirm = (page: Page) =>
  page.getByRole('checkbox', { name: /我已阅读此版本/ });
test('owner reviews real fake-worker output, opens fixed sources, approves once, and browses published files on desktop/mobile', async ({
  page,
}) => {
  const f = await fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (
      msg.type() === 'error' &&
      msg.location().url === f.origin + '/api/session' &&
      msg.text().includes('401')
    )
      return;
    if (['warning', 'error'].includes(msg.type())) errors.push(msg.text());
  });
  await login(page, f);
  await expect(page).toHaveTitle(/OpenContext/);
  await expect(
    page.getByRole('heading', { name: '个人记忆', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('等待本地 Agent 候选', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/网页不会读取你的电脑/)).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await submit(page, f);
  await expect(page.getByTestId('memory-review')).toContainText(
    'cedar-browser-needle',
  );
  await expect(page.getByTestId('memory-review')).toContainText(
    'tool / tool_result',
  );
  await expect(approve(page)).toBeDisabled();
  expect(await page.evaluate(() => 'syntheticInjected' in window)).toBe(false);
  const sourceLink = page
    .getByRole('link', { name: /^文件 .* · 版本 / })
    .first();
  const href = await sourceLink.getAttribute('href');
  expect(href).toContain('revision=');
  await sourceLink.click();
  await expect(
    page.getByRole('region', { name: '固定版本原文' }),
  ).toBeVisible();
  await page.getByRole('link', { name: '个人记忆', exact: true }).click();
  await expect(confirm(page)).not.toBeChecked();
  mkdirSync(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: evidence + '/desktop-review.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: evidence + '/mobile-review.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await confirm(page).check();
  await expect(approve(page)).toBeEnabled();
  let requests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/session-memory/approve')) requests++;
  });
  await approve(page).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByText(/此批候选已发布为 Markdown 文件/)).toBeVisible();
  expect(requests).toBe(1);
  await page.screenshot({
    path: evidence + '/mobile-published.png',
    fullPage: true,
  });
  await page.getByRole('link', { name: '查看已发布文件' }).click();
  await expect(page).toHaveURL(/type=derived/);
  await expect(page.getByRole('button', { name: '退出连接' })).toBeVisible();
  expect(errors).toEqual([]);
  writeFileSync(evidence + '/console.json', JSON.stringify(errors));
});
test('stale previews cannot approve replacement hashes; reject, retry and navigation require fresh confirmation', async ({
  page,
}) => {
  const f = await fixture();
  await login(page, f);
  const initial = await submit(page, f);
  await expect(page.getByTestId('memory-review')).toContainText(
    'cedar-browser-needle',
  );
  await confirm(page).check();
  // Keep the old tab's display while the real server receives a different candidate.
  await page.route('**/api/session-memory', async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  const newer = structuredClone(f.response);
  newer.candidates[0]!.markdown = 'Replacement candidate cedar-revised';
  const updated = await submit(page, f, newer);
  expect(updated.reviewHash).not.toBe(initial.reviewHash);
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(page.getByTestId('memory-review')).toContainText(
    'cedar-revised',
  );
  await expect(confirm(page)).not.toBeChecked();
  await expect(approve(page)).toBeDisabled();
  const stale = await page.request.post(
    f.origin + '/api/session-memory/approve',
    {
      headers: auth(f),
      data: { taskId: initial.taskId, reviewHash: initial.reviewHash },
    },
  );
  expect(stale.ok()).toBe(false);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '拒绝候选并取消任务' }).click();
  await expect(page.getByText(/任务已取消。来源文件保留/)).toBeVisible();
  await expect(page.getByTestId('memory-review')).toHaveCount(0);
  await page.getByRole('button', { name: '重新同步并重试' }).click();
  await expect(
    page.getByText('等待本地 Agent 候选', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: '文件', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '个人记忆', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: '个人记忆', exact: true }).click();
  await expect(
    page.getByText('等待本地 Agent 候选', { exact: true }),
  ).toBeVisible();
});
test('disabled/failed/empty states, recovery, and reader access stay explicit', async ({
  page,
  browser,
}) => {
  const f = await fixture('directory');
  await login(page, f);
  await expect(page.getByText(/服务器目录（只读显示/)).toBeVisible();
  await expect(page.getByText(/尚无任务/)).toBeVisible();
  await page.getByRole('button', { name: '同步 / 核验来源' }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /INVALID_SESSION_JSONL/ })
      .first(),
  ).toBeVisible();
  writeFileSync(f.selected, f.raw);
  // A first failed sync may have no task yet; syncing repaired sources must recover.
  await page.getByRole('button', { name: '同步 / 核验来源' }).click();
  await expect(
    page.getByText('等待本地 Agent 候选', { exact: true }),
  ).toBeVisible();
  const status = await (
    await page.request.get(f.origin + '/api/session-memory', {
      headers: auth(f),
    })
  ).json();
  const tokenResponse = await page.request.post(
    f.origin + '/api/projects/' + status.projectId + '/tokens',
    { headers: auth(f) },
  );
  expect(tokenResponse.ok()).toBe(true);
  const reader = await tokenResponse.json();
  const context = await browser.newContext();
  const readerPage = await context.newPage();
  await login(readerPage, f, reader.token);
  await expect(
    readerPage.getByRole('link', { name: '个人记忆', exact: true }),
  ).toHaveCount(0);
  await expect(
    readerPage.getByText(/个人记忆管理仅对服务器所有者开放/),
  ).toBeVisible();
  const denied = await readerPage.request.get(f.origin + '/api/session-memory');
  expect(denied.status()).toBe(403);
  await context.close();
  child.kill('SIGTERM');
  await once(child, 'exit');
  const disabled = await fixture('disabled');
  await page.context().clearCookies();
  await login(page, disabled);
  await expect(page.getByText(/个人记忆尚未启用/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: '同步 / 核验来源' }),
  ).toHaveCount(0);
  await page.screenshot({ path: evidence + '/disabled.png', fullPage: true });
});

for (const leave of ['navigate', 'logout'] as const) {
  test(`leaving by ${leave} aborts approval preflight before POST`, async ({
    page,
  }) => {
    const f = await fixture();
    await login(page, f);
    await submit(page, f);
    await expect(page.getByTestId('memory-review')).toContainText(
      'cedar-browser-needle',
    );
    await confirm(page).check();
    await expect(approve(page)).toBeEnabled();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercepted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route('**/api/session-memory/review', async (route) => {
      const response = await route.fetch();
      entered();
      await held;
      await route.fulfill({ response }).catch(() => undefined);
    });
    let posts = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith('/session-memory/approve')
      )
        posts++;
    });
    await approve(page).click();
    await intercepted;
    if (leave === 'logout') {
      await page.getByRole('button', { name: '退出连接' }).click();
      await expect(page.getByLabel('访问 token')).toBeVisible();
    } else {
      await page.getByRole('link', { name: '文件', exact: true }).click();
      await expect(page.getByTestId('memory-review')).toHaveCount(0);
    }
    release();
    await page.waitForTimeout(300);
    expect(posts).toBe(0);
    expect(
      (
        await (
          await page.request.get(f.origin + '/api/session-memory', {
            headers: auth(f),
          })
        ).json()
      ).status,
    ).toBe('review');
  });
}

test('a damaged review is hidden and cannot be approved; restoring the exact file requires fresh confirmation', async ({
  page,
}) => {
  const f = await fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, f);
  await submit(page, f);
  await expect(page.getByTestId('memory-review')).toContainText(
    'cedar-browser-needle',
  );
  await confirm(page).check();
  const path = f.root + '/data/plugin-state/session-memory/review.md';
  const preview = readFileSync(path, 'utf8');
  try {
    writeFileSync(path, '# Forged synthetic browser preview');
    await expect(page.getByTestId('memory-review')).toHaveCount(0, {
      timeout: 15000,
    });
    await expect(page.getByText(/INPUT_CHANGED/)).toBeVisible();
    await expect(approve(page)).toHaveCount(0);
    await expect(
      page.getByText('Forged synthetic browser preview', { exact: true }),
    ).toHaveCount(0);
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({
      path: evidence + '/damaged-review.png',
      fullPage: false,
    });
  } finally {
    writeFileSync(path, preview);
  }
  await expect(page.getByTestId('memory-review')).toContainText(
    'cedar-browser-needle',
    { timeout: 15000 },
  );
  await expect(confirm(page)).not.toBeChecked();
  await expect(approve(page)).toBeDisabled();
  expect(errors).toEqual([]);
});
