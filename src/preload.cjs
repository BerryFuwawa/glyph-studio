const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-updates'),
  openUpdatePage: () => ipcRenderer.invoke('open-update'),
  openImage: () => ipcRenderer.invoke('open-image'),
  pasteImage: () => ipcRenderer.invoke('paste-image'),
  copyText: text => ipcRenderer.invoke('copy-text', text),
  copyImage: dataURL => ipcRenderer.invoke('copy-image', dataURL),
  saveOutput: payload => ipcRenderer.invoke('save-output', payload),
  windowControl: action => ipcRenderer.send('window-control', action),
  onWindowState: callback => ipcRenderer.on('window-state', (_event, maximized) => callback(maximized))
});
