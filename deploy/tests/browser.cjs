const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { chromium } = createRequire(resolve('packages/testing/package.json'))('@playwright/test');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort(),
    );
    await page.goto(
      'http://localhost:18080/mail/compose?subject=Initial%20link&body=plain%20%3Ctext%3E',
    );
    await page.getByRole('button', { name: '生成配对码 / Generate code' }).click();
    const code = page.getByTestId('pairing-code');
    await code.waitFor();
    const { approveTestCode } = await import('./pairing-helper.mjs');
    approveTestCode(await code.innerText());
    await page.waitForURL('**/mail/compose?**', { timeout: 30000 });
    await page.screenshot({ path: '/tmp/zero-compose-ui.png', fullPage: true });
    assert.ok(page.url().includes('subject=Initial%20link'), 'login lost the compose URL');
    await page.goto('http://localhost:18080/settings/connections');
    await page
      .getByRole('button', { name: /添加连接|Add Connection/i })
      .first()
      .waitFor({ timeout: 30000 });
    const body = await page.locator('body').innerText();
    assert.ok(!body.includes('The bridge requires HTTPS'), 'internal Docker bridge rejected');
    assert.deepEqual(errors, [], 'browser runtime errors');
    console.log('PASS browser login, preserved compose link and connections page');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
