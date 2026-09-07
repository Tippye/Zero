// Regression checks use synthetic mail and mocked APIs; no account or provider access.
const { createRequire } = require('node:module');
const { resolve, join, extname } = require('node:path');
const { readFileSync, existsSync } = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const serverRequire = createRequire(resolve('apps/server/package.json'));
const esbuild = createRequire(serverRequire.resolve('wrangler/package.json'))('esbuild');
const { chromium } = createRequire(resolve('packages/testing/package.json'))('@playwright/test');
async function processor() {
  const result = await esbuild.build({ entryPoints: ['apps/server/src/lib/email-processor.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', plugins: [{ name: 'css-esm', setup(build) { build.onResolve({ filter: /^@barkleapp\/css-sanitizer$/ }, () => ({ path: serverRequire.resolve('@barkleapp/css-sanitizer') })); } }] });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(serverRequire, module, module.exports);
  return module.exports.processEmailHtml;
}
(async () => {
  const processEmailHtml = await processor();
  const themeScript = (await esbuild.build({ entryPoints: ['apps/mail/lib/mail-theme.ts'], bundle: true, write: false, format: 'iife', globalName: 'MailTheme' })).outputFiles[0].text;
  const web = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const root = resolve('apps/mail/build/client');
    let file = join(root, pathname); if (!file.startsWith(root) || !existsSync(file) || !extname(file)) file = join(root, 'index.html');
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[extname(file)] || 'text/html');
    response.end(readFileSync(file));
  });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  const origin = 'http://localhost:' + web.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ locale: 'zh-CN', colorScheme: 'light', viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { localStorage.setItem('hasCompletedOnboarding', 'true'); localStorage.setItem('theme', 'dark'); });
    const themePage = await context.newPage();
    await themePage.goto('about:blank');
    const source = '<html><head><style>@media (prefers-color-scheme: dark) {.custom { color: rgb(90,200,100) !important; }}</style></head><body bgcolor="#ffffff"><p id="black" style="color:#000!important;background:#fff!important">Readable mail</p><p class="custom">Authored dark theme</p><pre>Plain text &lt;literal&gt;\nsecond line</pre><a href="https://example.invalid">Link</a><img src="data:image/png;base64,iVBORw0KGgo=" alt="Image"></body></html>';
    for (const theme of ['dark', 'light']) {
      await themePage.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
      const { processedHtml } = processEmailHtml({ html: source, theme, shouldLoadImages: true });
      await themePage.setContent('<div id="host"></div>');
      await themePage.addScriptTag({ content: themeScript });
      const colors = await themePage.evaluate(({ html, theme }) => {
        const root = document.querySelector('#host').attachShadow({ mode: 'open' });
        root.append(document.importNode(new DOMParser().parseFromString(html, 'text/html').documentElement, true));
        MailTheme.applyMailTheme(root, theme);
        const color = selector => getComputedStyle(root.querySelector(selector)).color;
        return { black: color('#black'), pre: color('pre'), custom: color('.custom'), background: getComputedStyle(root.querySelector('#black')).backgroundColor, imageFilter: getComputedStyle(root.querySelector('img')).filter, marker: root.querySelector('html').dataset.theme, text: root.querySelector('pre').textContent };
      }, { html: processedHtml, theme });
      assert.equal(colors.marker, theme); assert.equal(colors.imageFilter, 'none'); assert.equal(colors.text, 'Plain text <literal>\nsecond line');
      if (theme === 'dark') { assert.equal(colors.black, 'rgb(235, 235, 235)'); assert.equal(colors.background, 'rgb(26, 26, 26)'); assert.notEqual(colors.pre, 'rgb(0, 0, 0)'); assert.equal(colors.custom, 'rgb(90, 200, 100)'); }
      else { assert.equal(colors.black, 'rgb(0, 0, 0)'); assert.equal(colors.background, 'rgb(255, 255, 255)'); }
    }
    await themePage.close();
    let paused = false, completed = 1, running = false, restoredCursor = false, listCalls = 0, mailboxFailed = true, syncCalls = 0;
    const actions = [], errors = [], account = { id: 'synthetic-a', email: 'mail@example.invalid', name: 'Synthetic mailbox', providerId: 'imap', connected: true };
    const id = 'mbx.synthetic-a.native';
    const message = { id, threadId: id, subject: 'Synthetic regression mail', sender: { name: 'Sender', email: 'sender@example.invalid' }, to: [], cc: [], bcc: [], tags: [{ id: 'INBOX', name: 'INBOX', type: 'system' }], attachments: [], body: '', decodedBody: source, processedHtml: source, receivedOn: '2026-09-06T00:00:00Z', isDraft: false, unread: false };
    const thread = { messages: [message], latest: message, labels: message.tags, hasUnread: false, totalReplies: 1 };
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.includes('/auth/get-session')) return route.fulfill({ json: { user: { id: 'synthetic-owner', email: 'user@example.invalid', name: 'Test', emailVerified: true }, session: { id: 'synthetic-session', userId: 'synthetic-owner', expiresAt: '2030-01-01T00:00:00Z' } } });
      if (!url.pathname.includes('/api/')) return route.continue();
      if (!url.pathname.includes('/trpc/')) return route.fulfill({ json: {} });
      const payload = route.request().method() === 'POST' ? route.request().postDataJSON() : JSON.parse(url.searchParams.get('input') || '{}');
      const names = url.pathname.split('/').at(-1).split(',');
      const result = names.map((name, index) => {
        const input = payload[index]?.json; let data = [];
        if (name === 'mailboxes.accounts') data = [account];
        if (name === 'connections.list') data = { connections: [], disconnectedIds: [] };
        if (name === 'connections.getDefault') data = account;
        if (name === 'settings.get') data = { settings: { language: 'zh-CN', timezone: 'Asia/Hong_Kong', externalImages: true, trustedSenders: [], isOnboarded: true, colorTheme: 'dark', defaultEmailAlias: '', categories: [{ id: 'all', name: 'All', searchValue: '', order: 0, isDefault: true }], animations: false } };
        if (name === 'llm.list') data = { ready: true, activeId: 'environment', profiles: [] };
        if (name === 'mailboxes.syncStatus') data = { enabled: true, workerOnline: true, accounts: [{ accountId: account.id, email: account.email, status: mailboxFailed ? 'error' : 'ready', errorCode: mailboxFailed ? 'UNAVAILABLE' : null, lastSyncedAt: '2026-09-06T00:00:00Z', cachedCount: 4, classificationTotal: 4, classifiedCount: completed, classificationPaused: paused, classificationRunning: running, classificationError: null, folderErrors: {} }] };
        if (name === 'mailboxes.syncNow') { syncCalls++; mailboxFailed = false; data = { success: true }; }
        if (name === 'mailboxes.classify') { actions.push(input.action); paused = input.action === 'pause'; running = !paused; if (!paused) completed = Math.min(4, completed + 1); if (completed === 4) running = false; data = { success: true }; }
        if (name === 'mail.listThreads') {
          listCalls++;
          assert.equal(input.workspaceId, 'synthetic-owner');
          if (input.cursor === 'stale') { restoredCursor = true; return { error: { json: { message: 'Refresh this folder to restart local pagination.', code: -32600, data: { code: 'BAD_REQUEST', httpStatus: 400, path: name } } } }; }
          data = { threads: Array.from({ length: 20 }, (_, i) => ({ id: i ? id + i : id, historyId: null, accountId: account.id, accountEmail: account.email, $raw: { preview: thread } })), warnings: mailboxFailed ? [{ accountId: account.id, email: account.email, code: 'UNAVAILABLE', message: 'Synthetic sync failure' }] : [], nextPageToken: restoredCursor ? null : 'stale' };
        }
        if (name === 'mail.get') data = thread;
        if (name === 'mail.processEmailContent') data = processEmailHtml({ html: input.html, theme: input.theme, shouldLoadImages: true });
        if (name === 'mail.verifyEmail') data = { isVerified: false };
        if (name === 'mailboxes.category') data = { category: null };
        return { result: { data: { json: data } } };
      });
      return route.fulfill({ json: result });
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/settings/llm');
    const controls = page.locator('[data-classification-controls]');
    await controls.getByRole('button', { name: '立即分类邮件', exact: true }).click();
    await controls.locator('progress[value="2"]').waitFor();
    await controls.getByRole('button', { name: '暂停分类' }).click();
    await controls.getByText('分类已暂停，继续后将从当前进度开始。').waitFor();
    await page.reload();
    await controls.getByRole('button', { name: '继续分类' }).click();
    await controls.locator('progress[value="3"]').waitFor();
    await controls.getByRole('button', { name: '暂停分类' }).click();
    await controls.getByRole('button', { name: '继续分类' }).click();
    await controls.getByText('分类已完成', { exact: true }).waitFor();
    await controls.locator('progress[value="4"]').waitFor();
    await controls.getByRole('button', { name: '重新分类邮件' }).waitFor();
    for (const width of [390, 1440]) { await page.setViewportSize({ width, height: 900 }); const box = await controls.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1); }
    assert.deepEqual(actions, ['start', 'pause', 'start', 'pause', 'start']);
    await page.goto(origin + '/mail/inbox');
    await page.locator('#mail-list-scroll').waitFor();
    await page.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    assert.equal(syncCalls, 1, 'retry requests background mailbox synchronization');
    await page.locator('#mail-list-scroll > div').first().evaluate(el => { el.scrollTop = el.scrollHeight; });
    for (let i = 0; i < 100 && !restoredCursor; i++) await page.waitForTimeout(100);
    assert.equal(restoredCursor, true, 'expired pagination cursor exercised');
    for (let i = 0; i < 150 && listCalls < 3; i++) await page.waitForTimeout(100);
    assert.ok(listCalls >= 3, 'expired cursor restarts from first page');
    await page.goto(origin + '/mail/inbox?threadId=' + id);
    await page.locator('.mail-content').first().waitFor();
    await page.locator('.mail-content #black').first().waitFor();
    assert.equal(await page.locator('.h-3.w-0\\.5').count(), 0, 'no orphan subject separators');
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'), { timeout: 15000 });
    const subjectContrast = await page.locator('[data-thread-id]').first().getByText('Synthetic regression mail', { exact: true }).evaluate(element => {
      const parse = value => value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      let opacity = 1, background;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node); opacity *= Number(style.opacity);
        if (!background && style.backgroundColor !== 'rgba(0, 0, 0, 0)') background = parse(style.backgroundColor);
      }
      background ||= [26, 26, 26];
      const foreground = parse(getComputedStyle(element).color).map((c, i) => c * opacity + background[i] * (1 - opacity));
      const lum = rgb => rgb.map(c => c / 255 <= .04045 ? c / 255 / 12.92 : ((c / 255 + .055) / 1.055) ** 2.4).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0);
      const a = lum(foreground), b = lum(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
    assert.ok(subjectContrast >= 4.5, 'read mail subject contrast: ' + subjectContrast);
    await page.screenshot({ path: '/tmp/zero-mail-fixes-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/zero-mail-fixes-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: HTML/plain text dark contrast, authored dark CSS with light OS, light mode, unchanged images, classification progress/pause/resume across reload, completion, mobile/desktop controls, subject separators. Synthetic APIs only.', { listCalls, restoredCursor, syncCalls });
    await context.close();
  } finally { await browser.close(); await new Promise(r => web.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
