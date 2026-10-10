// Preload for extension pages (popups etc.), like sw-preload.js does for service workers: provides
// chrome.permissions, chrome.storage.sync and chrome.tabs.create, which Electron lacks.
// Registered for every frame of the account sessions, so it does nothing outside chrome-extension:// pages.
const { webFrame, ipcRenderer, contextBridge } = require('electron');

if (location.protocol === 'chrome-extension:') {
  contextBridge.exposeInMainWorld('__mrCreateTab', (url) => ipcRenderer.send('ext-tab-create-page', String(url || '')));
  webFrame.executeJavaScript(`(() => { try {
    const c = window.chrome; if (!c) return;
    const done = (cb, v) => { if (typeof cb === 'function') cb(v); return Promise.resolve(v); };
    const none = { addListener() {}, removeListener() {}, hasListener: () => false };
    if (!c.permissions) c.permissions = {
      contains: (p, cb) => done(cb, true), request: (p, cb) => done(cb, true), remove: (p, cb) => done(cb, false),
      getAll: (cb) => done(cb, { permissions: [], origins: [] }), onAdded: none, onRemoved: none };
    if (c.storage) c.storage.sync = c.storage.local; // Electron's sync exists but every call throws
    if (c.tabs && window.__mrCreateTab) c.tabs.create = (o, cb) => { window.__mrCreateTab(o && o.url); return done(cb, { id: 1000, url: o && o.url, active: true }); };
  } catch (e) {} })();`);
}
