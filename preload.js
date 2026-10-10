// Preload for the tab bar UI only. Gmail views get no preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  getState: () => ipcRenderer.invoke('state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onRequestAdd: (cb) => ipcRenderer.on('request-add', () => cb()),
  onRequestRename: (cb) => ipcRenderer.on('request-rename', (_e, id) => cb(id)),
  add: (label) => ipcRenderer.send('add', label),
  select: (id) => ipcRenderer.send('select', id),
  rename: (id, label) => ipcRenderer.send('rename', id, label),
  reorder: (ids) => ipcRenderer.send('reorder', ids),
  tabMenu: (id) => ipcRenderer.send('tab-menu', id),
  dialog: (open) => ipcRenderer.send('dialog', !!open),
  settingsMenu: () => ipcRenderer.send('settings-menu'),
});
