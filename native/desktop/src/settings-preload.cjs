const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zeroSettings', {
  read: () => ipcRenderer.invoke('zero:settings'),
  save: (value) => ipcRenderer.invoke('zero:save', value),
  testNotification: () => ipcRenderer.invoke('zero:test-notification'),
  openDefaults: () => ipcRenderer.invoke('zero:defaults'),
});
