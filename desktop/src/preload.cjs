const { contextBridge, ipcRenderer, webUtils } = require('electron');

const config = ipcRenderer.sendSync('runtime:config');

function requireFilePath(file) {
  if (!(file instanceof File)) throw new TypeError('A File is required.');
  const selected = webUtils.getPathForFile(file);
  if (typeof selected !== 'string' || selected.length === 0) {
    throw new TypeError('The selected file has no path.');
  }
  return selected;
}

function requireExternalUrl(url) {
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('A URL is required.');
  return url;
}

if (config) contextBridge.exposeInMainWorld('codeIntelligenceDesktop', Object.freeze({
  platform: process.platform,
  appVersion: config.appVersion,
  apiBaseUrl: config.apiBaseUrl,
  apiToken: config.apiToken,
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  authorizeDroppedFolder: (file) => ipcRenderer.invoke('folder:authorize', requireFilePath(file)),
  openExternal: (url) => ipcRenderer.invoke('external:open', requireExternalUrl(url)),
  backup: () => ipcRenderer.invoke('data:backup'),
  restore: () => ipcRenderer.invoke('data:restore'),
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  restartRuntime: () => ipcRenderer.invoke('runtime:restart')
}));
