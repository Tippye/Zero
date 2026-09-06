// Windows integration check; uses a disposable profile and never sends mail.
const { _electron: electron } = require('@playwright/test');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const { tmpdir } = require('node:os');
(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'zero-titlebar-check-'));
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      server: 'http://localhost:18080',
      allowHttp: true,
      notifications: false,
      closeToTray: true,
    }),
  );
  const env = { ...process.env, ZERO_DESKTOP_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    executablePath: process.env.ZERO_TEST_ELECTRON,
    args: [resolve(__dirname, '..')],
    cwd: tmpdir(),
    env,
    timeout: 60000,
  });
  application.process().stderr.on('data', (data) => process.stderr.write(data));
  try {
    console.log('Launched');
    for (const p of application.windows())
      p.on('dialog', (d) => {
        console.log('Dialog:', d.type());
        void d.accept();
      });
    application.on('window', (p) =>
      p.on('dialog', (d) => {
        console.log('Dialog:', d.type());
        void d.accept();
      }),
    );
    let chrome;
    for (let i = 0; i < 100; i++) {
      chrome = application.windows().find((p) => p.url().endsWith('/titlebar.html'));
      if (chrome) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(chrome, 'Local titlebar window is loaded');
    await chrome.locator('#app-menu').waitFor();
    const state = await application.evaluate(({ BrowserWindow, Menu }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const view = w.contentView.children.find(
        (v) => v.webContents && v.webContents !== w.webContents,
      );
      return {
        menu: Menu.getApplicationMenu(),
        view: view.getBounds(),
        size: w.getContentSize(),
        remotePreload: view.webContents.getLastWebPreferences().preload,
        remoteNode: view.webContents.getLastWebPreferences().nodeIntegration,
      };
    });
    assert.equal(state.menu, null);
    assert.equal(state.view.y, 44);
    assert.equal(state.view.height, state.size[1] - 44);
    assert.ok(!state.remotePreload);
    assert.equal(state.remoteNode, false);
    console.log('Verified view and isolation');
    await application.evaluate(({ Menu }) => {
      const popup = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        global.__zeroTitlebarTestMenu = this;
        return popup.call(this, options);
      };
    });
    await chrome.locator('#app-menu').click();
    console.log('Menu clicked');
    await application.evaluate(() => global.__zeroTitlebarTestMenu.closePopup());
    await chrome.waitForTimeout(300);
    assert.equal(await chrome.locator('#app-menu').getAttribute('aria-expanded'), 'false');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await chrome.waitForTimeout(400);
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMaximized(),
      ),
      true,
    );
    await application.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.unmaximize();
      w.setContentSize(1000, 700);
    });
    await chrome.waitForTimeout(400);
    const bounds = await application.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return w.contentView.children
        .find((v) => v.webContents && v.webContents !== w.webContents)
        .getBounds();
    });
    assert.deepEqual(bounds, { x: 0, y: 44, width: 1000, height: 656 });
    await application.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'dark'));
    await chrome.emulateMedia({ colorScheme: 'dark' });
    await chrome.waitForTimeout(300);
    assert.equal(
      await chrome.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
      true,
    );
    await chrome.screenshot({ path: join(profile, 'titlebar-dark.png') });
    await application.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'light'));
    await chrome.emulateMedia({ colorScheme: 'light' });
    await chrome.waitForTimeout(300);
    assert.equal(
      await chrome.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches),
      true,
    );
    await chrome.screenshot({ path: join(profile, 'titlebar-light.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      false,
    );
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await Promise.race([
      application.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Application quit timed out')), 15000),
      ),
    ]);
    console.log(
      'PASS Windows titlebar: menu, bounds, maximize, resize, themes, tray close, isolated mail view. Screenshots: ' +
        profile,
    );
  } finally {
    await application.evaluate(({ app }) => app.exit()).catch(() => {});
    await application.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
