// Run against the installed test client started with --remote-debugging-port=9333.
// Use an isolated ZERO_DESKTOP_TEST_PROFILE for both this script and the client.
process.noAsar = true;
const { execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const origin = process.env.ZERO_TEST_URL || 'http://localhost:18080';
(async () => {
  const endpoint = await (await fetch('http://127.0.0.1:9333/json/version')).json();
  const browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  try {
    const page = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().startsWith(origin));
    assert.ok(page, 'Start and log in to the isolated acceptance client first');
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
    // The test must start from an inbox without an edited message.
    assert.equal(new URL(page.url()).pathname, '/mail/inbox');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; Start-Process 'zeromail://compose?to=second@example.invalid&subject=Native%20warm%20start'",
    ]);
    await page.waitForURL((url) => url.searchParams.get('subject') === 'Native warm start', {
      timeout: 30000,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('input')).some(
        (input) => input.value === 'Native warm start',
      ),
    );
    assert.equal(new URL(page.url()).searchParams.get('to'), 'second@example.invalid');
    console.log('PASS Windows Shell zeromail activation, editor subject and recipient');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
