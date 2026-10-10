// Preload for extension service workers. Electron lacks chrome.notifications and chrome.permissions, so this
// provides them (notifications are forwarded to the main process, which shows a native notification).
// main.js adds one line to each extension's service worker that installs these as chrome.* APIs.
const { ipcRenderer, contextBridge } = require('electron');

const listeners = { onClicked: [], onClosed: [], onButtonClicked: [] };
const event = (name) => ({
  addListener: (f) => listeners[name].push(f),
  removeListener: (f) => { listeners[name] = listeners[name].filter((x) => x !== f); },
  hasListener: (f) => listeners[name].includes(f),
});
const done = (cb, value) => { if (typeof cb === 'function') cb(value); return Promise.resolve(value); };
let counter = 0;

const notifications = {
  create(id, options, cb) {
    if (typeof id === 'object') { cb = options; options = id; id = undefined; }
    id = id || `n${Date.now()}-${counter++}`;
    const o = options || {};
    ipcRenderer.send('ext-notify', {
      id, title: String(o.title || ''), message: String(o.message || ''),
      buttons: (o.buttons || []).map((b) => String(b.title || '')),
    });
    return done(cb, id);
  },
  update: (id, options, cb) => done(cb, true),
  clear(id, cb) { ipcRenderer.send('ext-notify-clear', id); return done(cb, true); },
  getAll: (cb) => done(cb, {}),
  getPermissionLevel: (cb) => done(cb, 'granted'),
  onClicked: event('onClicked'),
  onClosed: event('onClosed'),
  onButtonClicked: event('onButtonClicked'),
};

ipcRenderer.on('ext-notify-event', (_e, name, id, index) => {
  for (const f of listeners[name] || []) { try { f(id, index); } catch {} }
});

// The extension's host access is already granted by its manifest.
const none = { addListener() {}, removeListener() {}, hasListener: () => false };
const permissions = {
  contains: (p, cb) => done(cb, true),
  request: (p, cb) => done(cb, true),
  remove: (p, cb) => done(cb, false),
  getAll: (cb) => done(cb, { permissions: [], origins: [] }),
  onAdded: none,
  onRemoved: none,
};

contextBridge.exposeInMainWorld('__mrNotifications', notifications);
contextBridge.exposeInMainWorld('__mrPermissions', permissions);
