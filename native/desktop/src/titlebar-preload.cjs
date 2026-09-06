const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zeroTitlebar', {
  openMenu: () => ipcRenderer.invoke('zero:titlebar-menu'),
});
