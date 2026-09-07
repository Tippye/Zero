const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { chromium, webkit } = createRequire(resolve('packages/testing/package.json'))(
  '@playwright/test',
);
const origin = 'http://localhost:19180';
const compose = ['compose', '-f', 'deploy/tests/compose.pairing.yaml'];
function approve(code) {
  const r = spawnSync(
    'docker',
    [...compose, 'exec', '-T', 'api', 'node', 'pairing.mjs', 'approve', code, '--yes'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
}
(async () => {
  const engine = process.env.ZERO_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
  const browser = process.env.ZERO_PLAYWRIGHT_WS
    ? await engine.connect(process.env.ZERO_PLAYWRIGHT_WS, { exposeNetwork: '<loopback>' })
    : await engine.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
          : {}),
        ...(engine === chromium ? { args: ['--no-sandbox'] } : {}),
      });
  try {
    const create = async (viewport) => {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.route('**/*', (route) =>
        route.request().url().startsWith(origin) || route.request().url().startsWith('data:')
          ? route.continue()
          : route.abort(),
      );
      // The initial destination is the device screen, which requires no real mailbox.
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(origin + '/login?next=%2Fpair');
      await page.getByRole('button', { name: '生成配对码 / Generate code' }).waitFor();
      assert.equal(await page.locator('input[type=password]').count(), 0);
      await page
        .getByLabel('本机名称 / Device name')
        .fill(viewport.width < 500 ? 'Phone UI test' : 'Desktop UI test');
      await page.getByRole('button', { name: '生成配对码 / Generate code' }).click();
      const code = page.getByTestId('pairing-code');
      await code.waitFor();
      const text = await code.innerText();
      await page.getByAltText('使用已登录设备扫描此配对二维码 / Pairing QR code').waitFor();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        'login must fit viewport',
      );
      // A reload must resume the same private request rather than creating a new one.
      await page.reload();
      await code.waitFor();
      assert.equal(await code.innerText(), text);
      return { context, page, code: text, errors };
    };
    const desktop = await create({ width: 1280, height: 900 });
    approve(desktop.code);
    await desktop.page.waitForURL(origin + '/pair', { timeout: 25000 });
    await desktop.page.getByRole('heading', { name: '已登录设备 / Signed-in devices' }).waitFor();
    const phone = await create({ width: 390, height: 844 });
    await desktop.page.goto(origin + '/pair#code=' + phone.code);
    // Opening a QR URL only pre-fills the code; no approval happens automatically.
    await desktop.page.getByRole('button', { name: '查看配对请求 / Review request' }).click();
    await desktop.page.getByRole('button', { name: '确认登录 / Approve', exact: true }).waitFor();
    assert.ok(phone.page.url().includes('/login'));
    await desktop.page.getByRole('button', { name: '确认登录 / Approve', exact: true }).click();
    await phone.page.waitForURL(origin + '/pair', { timeout: 25000 });
    await phone.page.getByRole('heading', { name: '已登录设备 / Signed-in devices' }).waitFor();
    assert.ok(
      await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'device screen must fit phone',
    );
    await desktop.page.getByRole('button', { name: '刷新 / Refresh', exact: true }).click();
    const device = desktop.page
      .locator('section')
      .filter({
        has: desktop.page.getByRole('heading', { name: '已登录设备 / Signed-in devices' }),
      })
      .locator('div.rounded-lg')
      .filter({ hasText: 'Phone UI test' });
    await device.getByRole('button', { name: '退出设备 / Sign out', exact: true }).click();
    await desktop.page
      .getByRole('dialog', { name: '确认退出设备 / Confirm sign out' })
      .getByRole('button', { name: '确认退出 / Confirm', exact: true })
      .click();
    await device.waitFor({ state: 'detached' });
    await phone.page.reload();
    await phone.page
      .getByText('请使用已登录设备扫描二维码，或在其「设置 → 安全」中输入配对码。', { exact: true })
      .waitFor();
    assert.deepEqual(desktop.errors, []);
    assert.deepEqual(phone.errors, []);
    console.log(
      `PASS ${engine === chromium ? 'Chromium' : 'WebKit'}: desktop/phone layouts, QR rendering, reload resume, CLI bootstrap, explicit approval, shared identity, immediate device revocation.`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
