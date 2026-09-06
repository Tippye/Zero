const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  Notification,
  dialog,
  ipcMain,
  shell,
  session,
  nativeImage,
} = require('electron');
const { readFile, writeFile, mkdir, rename, appendFile } = require('node:fs/promises');
const { NotificationFeed } = require('./notifications.cjs');
const { createMailWindow } = require('./mail-window.cjs');
const { join, normalize } = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const testProfile = process.env.ZERO_DESKTOP_TEST_PROFILE;
if (testProfile) app.setPath('userData', testProfile);
function record(event, details = {}) {
  if (testProfile)
    void appendFile(
      join(testProfile, 'diagnostics.jsonl'),
      JSON.stringify({ event, ...details }) + '\n',
    ).catch(() => {});
}
app.setAppUserModelId('org.zero.mail');
async function isDefaultMail() {
  try {
    if (process.platform === 'win32') {
      // NSIS registers ZeroMail.mailto, which differs from Electron's own ProgID.
      const handler = await app.getApplicationInfoForProtocol('mailto:');
      return normalize(handler.path).toLowerCase() === normalize(app.getPath('exe')).toLowerCase();
    }
    return app.isDefaultProtocolClient('mailto');
  } catch {
    return false;
  }
}
const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  let mainWindow,
    mailContents,
    applicationMenu,
    settingsWindow,
    tray,
    profile,
    activeSession,
    feed,
    polling,
    quitting = false;
  let config = {
    server: '',
    allowHttp: false,
    notifications: true,
    preview: false,
    closeToTray: true,
    launchAtLogin: false,
  };
  let pendingLinks = process.argv.filter((arg) => /^(mailto:|zeromail:)/i.test(arg)).slice(0, 10);
  let links;
  const file = () => join(app.getPath('userData'), 'settings.json');
  const icon = nativeImage.createFromPath(join(__dirname, 'icon.png'));
  async function persist() {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(file() + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(file() + '.tmp', file());
  }
  function focus() {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mailContents?.focus();
    }
  }
  function navigate(path) {
    if (!mainWindow || !config.server) return;
    void mailContents.loadURL(config.server + path).catch(() => {});
    focus();
  }
  async function openLink(raw) {
    try {
      const path = links.linkPath(raw);
      record('protocol', { scheme: new URL(raw).protocol, destination: path.split('?')[0] });
      if (!mainWindow || !config.server) {
        pendingLinks.push(raw);
        openSettings();
        return;
      }
      navigate(path);
    } catch {
      await dialog.showMessageBox({
        type: 'warning',
        message: '不支持的邮件链接 / Invalid mail link',
      });
    }
  }
  app.on('second-instance', (_event, argv) => {
    const incoming = argv.filter((arg) => /^(mailto:|zeromail:)/i.test(arg)).slice(0, 10);
    if (links) incoming.forEach((raw) => void openLink(raw));
    else pendingLinks.push(...incoming);
    focus();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (links) void openLink(url);
    else pendingLinks.push(url);
  });
  function notify(event, test = false) {
    if (!Notification.isSupported()) throw new Error('System notifications are unavailable');
    const toast = new Notification({
      title: test ? 'Zero Mail 通知测试' : 'Zero Mail · 新邮件',
      body: test
        ? '点击此通知返回 Zero Mail。 / Click to open Zero Mail.'
        : config.preview
          ? `${event.sender}\n${event.subject}`
          : '收到一封新邮件，点击查看。 / You have new mail.',
      silent: false,
    });
    toast.on('show', () => record('notification-shown', { test }));
    toast.on('click', () => {
      record('notification-clicked');
      if (test) focus();
      else navigate(links.notificationPath(event));
    });
    toast.on('failed', () => {
      console.warn('System notification could not be displayed');
    });
    toast.show();
  }
  function menu() {
    const entries = [
      { label: '收件箱 / Inbox', click: () => navigate('/mail/inbox') },
      {
        label: '写邮件 / Compose',
        accelerator: 'CmdOrCtrl+N',
        click: () => navigate('/mail/compose'),
      },
      { label: '服务器与桌面设置 / Settings', click: openSettings },
      { label: '重新连接 / Reconnect', click: () => void connect() },
      { type: 'separator' },
      { label: '退出 / Quit', click: () => app.quit() },
    ];
    applicationMenu = Menu.buildFromTemplate([
      ...entries.slice(0, -2),
      { type: 'separator' },
      {
        label: '编辑 / Edit',
        submenu: [
          {
            label: '撤销',
            click: () => {
              mailContents?.focus();
              mailContents?.undo();
            },
          },
          {
            label: '重做',
            click: () => {
              mailContents?.focus();
              mailContents?.redo();
            },
          },
          {
            label: '剪切',
            click: () => {
              mailContents?.focus();
              mailContents?.cut();
            },
          },
          {
            label: '复制',
            click: () => {
              mailContents?.focus();
              mailContents?.copy();
            },
          },
          {
            label: '粘贴',
            click: () => {
              mailContents?.focus();
              mailContents?.paste();
            },
          },
          {
            label: '全选',
            click: () => {
              mailContents?.focus();
              mailContents?.selectAll();
            },
          },
        ],
      },
      {
        label: '视图 / View',
        submenu: [
          { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mailContents?.reload() },
          {
            label: '实际大小',
            accelerator: 'CmdOrCtrl+0',
            click: () => mailContents?.setZoomLevel(0),
          },
          {
            label: '放大',
            accelerator: 'CmdOrCtrl+Plus',
            click: () => mailContents?.setZoomLevel(Math.min(5, mailContents.getZoomLevel() + 1)),
          },
          {
            label: '缩小',
            accelerator: 'CmdOrCtrl+-',
            click: () => mailContents?.setZoomLevel(Math.max(-5, mailContents.getZoomLevel() - 1)),
          },
        ],
      },
      { type: 'separator' },
      entries.at(-1),
    ]);
    Menu.setApplicationMenu(null);
    if (!tray) {
      tray = new Tray(icon);
      tray.setToolTip('Zero Mail');
      tray.on('double-click', focus);
    }
    tray.setContextMenu(Menu.buildFromTemplate(entries));
  }
  async function connect() {
    clearInterval(polling);
    feed = null;
    if (!config.server) return openSettings();
    config.server = links.normalizeServer(config.server, config.allowHttp);
    profile = createHash('sha256').update(config.server).digest('hex').slice(0, 24);
    activeSession = session.fromPartition('persist:zero-' + profile);
    activeSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    activeSession.setPermissionCheckHandler(() => false);
    if (mainWindow) {
      const previousWindow = mainWindow;
      mainWindow = null;
      previousWindow.removeAllListeners('close');
      previousWindow.destroy();
    }
    ({ window: mainWindow, contents: mailContents } = createMailWindow({
      icon,
      session: activeSession,
    }));
    const window = mainWindow;
    const contents = mailContents;
    const shortcuts = (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
      const key = input.key.toLowerCase();
      if (key === 'n') navigate('/mail/compose');
      else if (key === 'r') contents.reload();
      else if (key === '0') contents.setZoomLevel(0);
      else if (key === '+' || key === '=')
        contents.setZoomLevel(Math.min(5, contents.getZoomLevel() + 1));
      else if (key === '-') contents.setZoomLevel(Math.max(-5, contents.getZoomLevel() - 1));
      else return;
      event.preventDefault();
    };
    contents.on('before-input-event', shortcuts);
    window.webContents.on('before-input-event', shortcuts);
    const handleNavigation = (event, url) => {
      const parsed = new URL(url);
      if (parsed.origin === config.server) return;
      event.preventDefault();
      if (['mailto:', 'zeromail:'].includes(parsed.protocol)) void openLink(url);
      else if (['http:', 'https:'].includes(parsed.protocol)) void shell.openExternal(url);
    };
    mailContents.on('will-navigate', handleNavigation);
    mailContents.setWindowOpenHandler(({ url }) => {
      handleNavigation({ preventDefault() {} }, url);
      if (new URL(url).origin === config.server)
        navigate(new URL(url).pathname + new URL(url).search);
      return { action: 'deny' };
    });
    mailContents.on('will-attach-webview', (event) => event.preventDefault());
    mailContents.on('will-prevent-unload', (event) => {
      record('unsaved-message-prompt');
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        message: '当前邮件有编辑内容，是否离开？ / Leave this edited message?',
        buttons: ['留在当前邮件 / Stay', '离开 / Leave'],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice === 1) event.preventDefault();
    });
    mainWindow.on('close', (event) => {
      record('window-close', { quitting, closeToTray: config.closeToTray });
      if (!quitting && config.closeToTray) {
        event.preventDefault();
        mainWindow.hide();
      } else if (!contents.isDestroyed()) {
        event.preventDefault();
        setImmediate(() => {
          if (contents.isDestroyed()) return;
          // Finish the page's beforeunload flow before disposing the containing window.
          void contents
            .loadURL('about:blank')
            .then(() => {
              if (!window.isDestroyed()) window.destroy();
            })
            .catch(() => {
              // A cancelled beforeunload keeps the mail window open.
              quitting = false;
            });
        });
      }
    });
    mainWindow.on('closed', () => {
      record('window-closed');
      if (mainWindow !== window) return;
      mainWindow = null;
      if (quitting || !config.closeToTray) setImmediate(() => app.quit());
    });
    mailContents.on('did-finish-load', () =>
      record('page-loaded', { path: new URL(mailContents.getURL()).pathname }),
    );
    const stateFile = join(app.getPath('userData'), `notifications-${profile}.json`);
    let state = {};
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'));
    } catch {
      /* First run. */
    }
    const capturedSession = activeSession,
      server = config.server;
    feed = new NotificationFeed({
      fetchFeed: async (after) => {
        const url = new URL('/api/desktop/events', server);
        if (after !== undefined) url.searchParams.set('after', after);
        const res = await capturedSession.fetch(url.href, {
          credentials: 'include',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error('Mail feed unavailable');
        const body = await res.json();
        if (
          typeof body.owner !== 'string' ||
          !/^\d+$/.test(body.cursor) ||
          !Array.isArray(body.events)
        )
          throw new Error('Invalid feed');
        return body;
      },
      show: async (event) => {
        links.notificationPath(event);
        if (activeSession === capturedSession && config.notifications) notify(event);
      },
      load: async (owner) => state[owner],
      save: async (owner, value) => {
        state[owner] = value;
        await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
      },
    });
    const currentFeed = feed;
    polling = setInterval(() => void currentFeed.poll().catch(() => {}), 15000);
    await mailContents.loadURL(config.server + '/mail/inbox').catch(() => {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: '无法连接邮件服务器。可从菜单重新连接或修改服务器地址。 / Server unavailable.',
      });
    });
    for (const url of pendingLinks.splice(0)) await openLink(url);
    void currentFeed.poll().catch(() => {});
  }
  function openSettings() {
    if (settingsWindow) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = new BrowserWindow({
      width: 600,
      height: 720,
      resizable: false,
      title: 'Zero Mail settings',
      webPreferences: {
        preload: join(__dirname, 'settings-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
    void settingsWindow.loadFile(join(__dirname, 'settings.html'));
  }
  ipcMain.handle('zero:titlebar-menu', (event) => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(join(__dirname, 'titlebar.html')).href
    ) {
      throw new Error('Invalid titlebar request');
    }
    return new Promise((resolve) =>
      applicationMenu.popup({ window: mainWindow, x: 12, y: 42, callback: resolve }),
    );
  });
  function trusted(event) {
    return (
      settingsWindow &&
      event.sender === settingsWindow.webContents &&
      event.senderFrame === settingsWindow.webContents.mainFrame &&
      event.senderFrame.url === pathToFileURL(join(__dirname, 'settings.html')).href
    );
  }
  function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('Invalid settings request');
      return fn(...args);
    });
  }
  handle('zero:settings', async () => ({
    ...config,
    notificationsSupported: Notification.isSupported(),
    defaultMail: await isDefaultMail(),
    version: app.getVersion(),
    platform: process.platform,
  }));
  handle('zero:save', async (value) => {
    const server = links.normalizeServer(value.server, value.allowHttp === true);
    const response = await session.defaultSession.fetch(server + '/api/desktop/info', {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || (await response.json()).server !== 'zero')
      throw new Error('This address is not a compatible Zero server');
    config = {
      server,
      ...Object.fromEntries(
        ['allowHttp', 'notifications', 'preview', 'closeToTray', 'launchAtLogin'].map((k) => [
          k,
          value[k] === true,
        ]),
      ),
    };
    await persist();
    if (process.platform === 'win32')
      app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
    await connect();
    return true;
  });
  handle('zero:test-notification', () => {
    notify({}, true);
    return true;
  });
  handle('zero:defaults', async () => {
    if (process.platform === 'win32')
      await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Zero%20Mail');
    else
      await dialog.showMessageBox({
        message:
          '请在系统设置中选择默认邮件应用。 / Choose the default email app in system settings.',
      });
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (!config.closeToTray) app.quit();
  });
  app
    .whenReady()
    .then(async () => {
      links = await import('./links.mjs');
      try {
        config = { ...config, ...JSON.parse(await readFile(file(), 'utf8')) };
      } catch {
        /* First run. */
      }
      menu();
      await connect();
      record('ready', {
        platform: process.platform,
        notifications: Notification.isSupported(),
        defaultMail: await isDefaultMail(),
      });
      if (testProfile && process.env.ZERO_DESKTOP_TEST_NOTIFICATION === '1') notify({}, true);
    })
    .catch((error) => {
      console.error(error.message);
      app.quit();
    });
}
