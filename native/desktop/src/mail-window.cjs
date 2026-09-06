const { BrowserWindow, WebContentsView, nativeTheme } = require('electron');
const { join } = require('node:path');

const TITLEBAR_HEIGHT = 44;
function overlay() {
  return {
    color: nativeTheme.shouldUseDarkColors ? '#141414' : '#fafafa',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#ececec' : '#242424',
    height: TITLEBAR_HEIGHT,
  };
}
function createMailWindow({ icon, session }) {
  const window = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    title: 'Zero Mail',
    icon,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    backgroundColor: overlay().color,
    webPreferences: {
      preload: join(__dirname, 'titlebar-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.setMenu(null);
  const view = new WebContentsView({
    webPreferences: {
      session,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.contentView.addChildView(view);
  const resize = () => {
    const [width, height] = window.getContentSize();
    view.setBounds({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    });
  };
  resize();
  window.on('resize', resize);
  const updateTheme = () => window.setTitleBarOverlay(overlay());
  nativeTheme.on('updated', updateTheme);
  window.on('closed', () => {
    nativeTheme.removeListener('updated', updateTheme);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  view.webContents.once('destroyed', () => {
    if (!window.isDestroyed()) window.destroy();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => {
    window.show();
    view.webContents.focus();
  });
  void window.loadFile(join(__dirname, 'titlebar.html'));
  return { window, contents: view.webContents };
}
module.exports = { createMailWindow };
