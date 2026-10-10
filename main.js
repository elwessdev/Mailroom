const {
  app, BrowserWindow, WebContentsView, Menu, Tray, Notification, nativeImage, nativeTheme,
  ipcMain, shell, session, dialog,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const lib = require('./lib');

// Test hooks (used by test/e2e.js): isolated profile, fake Gmail URL, stdout events.
const TEST = process.env.MAILROOM_TEST === '1';
if (process.env.MAILROOM_USERDATA) app.setPath('userData', process.env.MAILROOM_USERDATA);
const GMAIL_URL = process.env.MAILROOM_START_URL || 'https://mail.google.com/mail/u/0/';

app.setName('Mailroom');
app.setDesktopName('mailroom.desktop');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

const TAB_H = 40;
// Google refuses sign-in from a Chromium-based app that presents as Chrome, but accepts a Firefox identity.
// MAILROOM_UA=chrome switches to a Chrome identity instead.
const FIREFOX = process.env.MAILROOM_UA !== 'chrome';
const UA = FIREFOX ? lib.buildFirefoxUserAgent() : lib.buildUserAgent(process.versions.chrome);
const ICON = path.join(__dirname, 'assets', 'icon.png');
const STORE = () => path.join(app.getPath('userData'), 'accounts.json');

let win, tray, quitting = false;
let data = { accounts: [], active: null, settings: { startMinimized: false, launchAtLogin: false, sound: true, gmailNotifications: false } };
const views = new Map();   // id -> WebContentsView
const unread = new Map();  // id -> number
let overlay = false;       // a tab-bar dialog is open: hide the Gmail views so it is visible

// ---------- persistence ----------
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(STORE(), 'utf8'));
    data = { ...data, ...d, settings: { ...data.settings, ...d.settings } };
  } catch {}
}
function save() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(STORE(), JSON.stringify(data, null, 2));
}

// ---------- helpers ----------
const account = (id) => data.accounts.find((a) => a.id === id);
const total = () => [...unread.values()].reduce((a, b) => a + b, 0);

function publicState() {
  return {
    accounts: data.accounts.map((a) => ({ id: a.id, label: a.label, unread: unread.get(a.id) || 0 })),
    active: data.active,
  };
}

function refresh() {
  win?.webContents.send('state', publicState());
  const n = total();
  win?.setTitle(n ? `Mailroom (${n})` : 'Mailroom');
  if (TEST) console.log(`TEST_TOTAL ${n}`);
  tray?.setToolTip(n ? `Mailroom - ${n} unread` : 'Mailroom');
  buildTrayMenu();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- account views ----------
function setupSession(id) {
  const ses = session.fromPartition('persist:acct-' + id);
  ses.setUserAgent(UA);
  // Gmail's own web notifications duplicate ours (which add the account label, sound and tab switch),
  // so they are off unless enabled in settings.
  const allow = (permission, origin) =>
    permission === 'notifications' && data.settings.gmailNotifications && lib.isGmailOrigin(origin);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(allow(permission, details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, permission, origin) => allow(permission, origin));
  return ses;
}

// Make Sec-CH-UA / navigator.userAgentData say "Google Chrome" like the UA string does;
// a bare Chromium brand list is what Google's sign-in flags as an embedded browser.
function spoofClientHints(wc) {
  try {
    wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: UA, acceptLanguage: app.getLocale() || 'en-US',
      userAgentMetadata: FIREFOX
        ? { brands: [], platform: '', platformVersion: '', architecture: '', model: '', mobile: false }
        : lib.buildUserAgentMetadata(process.versions.chrome),
    }).catch(() => {});
  } catch {}
}

// Unpacked Chrome extensions in <userData>/extensions/<name>/ are loaded into every account session.
// ---------- extensions ----------
// Unpacked Chrome extensions in <userData>/extensions/<name>/ are loaded into every account session.
// Electron lacks chrome.notifications, chrome.permissions and chrome.storage.sync, so each extension's
// service worker gets one extra line (idempotent) that installs shims from sw-preload.js.
const SHIM_MARK = '/*mailroom-shim-3*/';
const SHIM_LINE = SHIM_MARK + "try{if(typeof chrome!=='undefined'){" +
  "if(!chrome.notifications&&self.__mrNotifications)chrome.notifications=self.__mrNotifications;" +
  "if(!chrome.permissions&&self.__mrPermissions)chrome.permissions=self.__mrPermissions;" +
  "if(chrome.tabs&&self.__mrTabs)chrome.tabs.create=self.__mrTabs.create;" +
  "if(chrome.storage&&!chrome.storage.sync)chrome.storage.sync=chrome.storage.local;}}catch(e){}\n";

function installShim(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const rel = manifest.background?.service_worker;
    if (!rel) return;
    const file = path.join(dir, rel);
    let code = fs.readFileSync(file, 'utf8');
    if (code.startsWith(SHIM_MARK)) return;
    if (code.startsWith('/*mailroom-shim-')) code = code.slice(code.indexOf('\n') + 1); // older shim line
    fs.writeFileSync(file, SHIM_LINE + code);
  } catch {}
}

const loaded = new Map();   // session -> [{ id, name, popup }] extensions loaded into it
const hooked = new WeakSet();
const extNotes = new Map(); // notification id -> Notification
function hookExtensionWorkers(ses) {
  if (hooked.has(ses)) return;
  hooked.add(ses);
  ses.registerPreloadScript({ type: 'service-worker', filePath: path.join(__dirname, 'sw-preload.js') });
  ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'ext-page-preload.js') });
  ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return;
    const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || worker.__hooked) return;
    worker.__hooked = true;
    const accountId = () => data.accounts.find((a) => views.get(a.id)?.webContents.session === ses)?.id;
    const fire = (name, id, index) => { try { worker.send('ext-notify-event', name, id, index); } catch {} };
    worker.ipc.on('ext-notify', (_e, { id, title, message, buttons }) => {
      if (TEST) console.log(`TEST_EXT_NOTIFY ${title} | ${message}`);
      if (data.settings.sound) playSound();
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title, body: message, icon: ICON, silent: true,
        actions: buttons.slice(0, 2).map((text) => ({ type: 'button', text })),
      });
      n.on('click', () => { showWindow(); const a = accountId(); if (a) select(a); fire('onClicked', id); });
      n.on('action', (_ev, index) => fire('onButtonClicked', id, index));
      n.on('close', () => { extNotes.delete(id); fire('onClosed', id, true); });
      extNotes.set(id, n);
      n.show();
      if (TEST && process.env.MAILROOM_TEST_CLICK) setTimeout(() => fire('onClicked', id), 500);
    });
    worker.ipc.on('ext-tab-create', (_e, url) => openFromExtension(ses, accountId(), url));
    worker.ipc.on('ext-notify-clear', (_e, id) => { extNotes.get(id)?.close(); extNotes.delete(id); });
  });
}

// A page an extension asked to open (chrome.tabs.create): Gmail goes to that account's tab, anything else
// opens in a small window that shares the account's session, so the extension's own scripts run on it.
function openFromExtension(ses, accId, url) {
  if (!/^https?:\/\//i.test(url)) return;
  if (lib.isGmailOrigin(url) && accId) {
    showWindow();
    select(accId);
    views.get(accId)?.webContents.loadURL(url);
  } else {
    openExtWindow(ses, url, 520, 740);
  }
}

function openExtWindow(ses, url, width, height) {
  const w = new BrowserWindow({
    width, height, parent: win, show: !TEST, icon: ICON, autoHideMenuBar: true,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  w.setMenu(null);
  w.webContents.setUserAgent(UA);
  spoofClientHints(w.webContents);
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:\/\//i.test(u)) setImmediate(() => w.loadURL(u));
    return { action: 'deny' };
  });
  // A popup that sends you to a web page (sign-in) needs more room.
  w.webContents.on('did-navigate', (_e, u) => {
    if (!u.startsWith('chrome-extension:') && w.getSize()[0] < 520) w.setSize(560, 780);
  });
  if (TEST) console.log(`TEST_EXT_WINDOW ${url.split('?')[0]}`);
  w.loadURL(url);
}

// Menu entries standing in for the toolbar icons Electron does not have: each extension's popup.
function extensionItems() {
  const ses = views.get(data.active)?.webContents.session;
  const list = (ses && loaded.get(ses) || []).filter((e) => e.popup);
  if (!list.length) return [];
  return [
    { type: 'separator' },
    ...list.map((e) => ({ label: `${e.name}…`, click: () => openExtWindow(ses, `chrome-extension://${e.id}/${e.popup}`, 400, 620) })),
  ];
}

async function loadExtensions(ses) {
  hookExtensionWorkers(ses);
  const dir = path.join(app.getPath('userData'), 'extensions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const full = path.join(dir, name);
    if (!fs.existsSync(path.join(full, 'manifest.json'))) continue;
    try {
      installShim(full);
      const ext = await ses.extensions.loadExtension(full);
      const popup = ext.manifest?.action?.default_popup || ext.manifest?.browser_action?.default_popup;
      loaded.set(ses, [...(loaded.get(ses) || []), { id: ext.id, name: ext.name, popup }]);
      if (TEST) console.log(`TEST_EXT_LOADED ${ext.name}`);
      if (TEST && popup && process.env.MAILROOM_TEST_POPUP) openExtWindow(ses, `chrome-extension://${ext.id}/${popup}`, 400, 620);
    } catch (e) {
      console.warn(`Extension "${name}" failed to load: ${e.message}`);
    }
  }
}

// Keep Google pages inside the tab; send everything else to the system browser.
function guard(wc) {
  const external = (url) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); };
  const route = (url) => {
    const target = lib.unwrapGoogleRedirect(url);
    if (target) { external(target); return 'external'; }
    return lib.isGoogleHost(url) ? 'internal' : (external(url), 'external');
  };
  wc.setUserAgent(UA);
  spoofClientHints(wc);
  wc.setWindowOpenHandler(({ url }) => {
    if (route(url) === 'external') return { action: 'deny' };
    // Gmail pop-out compose etc.: real child window, same session. Sign-in pages stay in the tab.
    if (lib.isGmailOrigin(url)) return { action: 'allow' };
    setImmediate(() => wc.loadURL(url));
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => guard(child.webContents));
  wc.on('will-navigate', (e, url) => { if (route(url) === 'external') e.preventDefault(); });
  attachShortcuts(wc);
}

function createView(acct) {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:acct-' + acct.id,
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  setupSession(acct.id);
  const wc = view.webContents;
  guard(wc);
  wc.on('page-title-updated', (_e, title) => onTitle(acct.id, title));
  win.contentView.addChildView(view);
  views.set(acct.id, view);
  layout();
  loadExtensions(wc.session).finally(() => wc.loadURL(GMAIL_URL));
  return view;
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  for (const [id, v] of views) {
    v.setBounds({ x: 0, y: TAB_H, width: w, height: Math.max(0, h - TAB_H) });
    v.setVisible(id === data.active && !overlay);
  }
}

function select(id) {
  if (!account(id)) return;
  data.active = id;
  save();
  layout();
  views.get(id)?.webContents.focus();
  refresh();
}

// ---------- unread tracking + notifications ----------
function onTitle(id, title) {
  const n = lib.parseUnread(title);
  if (n === null) return;
  const prev = unread.get(id);
  unread.set(id, n);
  if (prev !== undefined && n > prev) notify(id, n, n - prev);
  refresh();
}

// Unread mail from Gmail's Atom feed, fetched with that account's own session. Used only for the
// notification text; never logged or stored.
async function latestMail(id) {
  try {
    const feed = new URL('/mail/u/0/feed/atom', GMAIL_URL).href;
    const res = await views.get(id).webContents.session.fetch(feed, { credentials: 'include' });
    return res.ok ? lib.parseAtomFeed(await res.text()) : [];
  } catch {
    return [];
  }
}

function playSound() {
  const file = '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga';
  execFile('canberra-gtk-play', ['-i', 'message-new-instant'], (err) => {
    if (err) execFile('pw-play', [file], () => {});
  });
}

async function notify(id, count, added) {
  const a = account(id);
  if (!a) return;
  const mails = await latestMail(id);
  const { title, body } = lib.formatNotification(a.label, count, added, mails);
  if (TEST) console.log(`TEST_NOTIFY ${a.label} ${count} +${added} | ${title} | ${body.replace(/\n/g, ' / ')}`);
  if (data.settings.sound) playSound();
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: true });
  n.on('click', () => { showWindow(); select(id); });
  n.show();
}

// ---------- account management ----------
function addAccount(label) {
  const acct = { id: crypto.randomUUID(), label };
  data.accounts.push(acct);
  createView(acct);
  select(acct.id);
}

async function removeAccount(id) {
  const a = account(id);
  if (!a) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0,
    message: `Remove "${a.label}"?`,
    detail: 'This signs the account out and deletes its stored data in this app.',
  });
  if (response !== 1) return;
  const view = views.get(id);
  win.contentView.removeChildView(view);
  views.delete(id);
  unread.delete(id);
  const ses = view.webContents.session;
  view.webContents.close();
  await ses.clearStorageData();
  await ses.clearCache();
  data.accounts = data.accounts.filter((x) => x.id !== id);
  if (data.active === id) data.active = data.accounts[0]?.id ?? null;
  save();
  layout();
  refresh();
}

function cycle(step) {
  const ids = data.accounts.map((a) => a.id);
  if (ids.length) select(ids[(ids.indexOf(data.active) + step + ids.length) % ids.length]);
}

// ---------- shortcuts ----------
function attachShortcuts(wc) {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
    const k = input.key.toLowerCase();
    if (k === 'w') return e.preventDefault(); // never close anything by accident
    if (k === 't') { e.preventDefault(); showWindow(); return win.webContents.send('request-add'); }
    if (k === 'r') { e.preventDefault(); return views.get(data.active)?.webContents.reload(); }
    if (k === 'tab') { e.preventDefault(); return cycle(input.shift ? -1 : 1); }
    if (/^[1-9]$/.test(k)) {
      const a = data.accounts[Number(k) - 1];
      if (a) { e.preventDefault(); select(a.id); }
    }
  });
}

// ---------- settings: start minimized, autostart ----------
function autostartFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'mailroom.desktop');
}
function applyAutostart() {
  const file = autostartFile();
  if (!data.settings.launchAtLogin) return fs.rmSync(file, { force: true });
  const q = (s) => `"${s.replace(/(["\\`$])/g, '\\$1')}"`;
  const exec = process.env.APPIMAGE
    ? q(process.env.APPIMAGE)
    : app.isPackaged ? q(process.execPath) : `${q(process.execPath)} ${q(app.getAppPath())}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '[Desktop Entry]', 'Type=Application', 'Name=Mailroom', `Exec=${exec}`,
    `Icon=mailroom`, 'X-GNOME-Autostart-enabled=true', '',
  ].join('\n'));
}

function settingItems() {
  const toggle = (key, label, after) => ({
    label, type: 'checkbox', checked: data.settings[key],
    click: (item) => { data.settings[key] = item.checked; save(); after?.(); },
  });
  return [
    toggle('startMinimized', 'Start minimized'),
    toggle('sound', 'Notification sound'),
    toggle('gmailNotifications', "Gmail's own notifications (needs restart)"),
    toggle('launchAtLogin', 'Launch at login', applyAutostart),
    ...extensionItems(),
  ];
}

// ---------- tray ----------
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: showWindow },
    ...data.accounts.map((a) => ({ label: `Compose in ${a.label}`, click: () => compose(a.id, lib.composeUrl()) })),
    { type: 'separator' },
    ...settingItems(),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 }));
  tray.on('click', () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
  refresh();
}

function compose(id, url) {
  showWindow();
  select(id);
  views.get(id)?.webContents.loadURL(url);
}

// ---------- mailto ----------
async function handleMailto(mailto) {
  if (!mailto || !data.accounts.length) return;
  showWindow();
  let id = data.accounts[0].id;
  if (data.accounts.length > 1) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', message: 'Compose with which account?',
      buttons: [...data.accounts.map((a) => a.label), 'Cancel'], cancelId: data.accounts.length,
    });
    if (response >= data.accounts.length) return;
    id = data.accounts[response].id;
  }
  compose(id, lib.mailtoUrl(mailto));
}

// ---------- IPC (tab bar UI) ----------
function wireIpc() {
  ipcMain.handle('state', () => publicState());
  ipcMain.on('add', (_e, label) => { if (typeof label === 'string' && label.trim()) addAccount(label.trim().slice(0, 40)); });
  ipcMain.on('select', (_e, id) => select(id));
  ipcMain.on('rename', (_e, id, label) => {
    const a = account(id);
    if (a && typeof label === 'string' && label.trim()) { a.label = label.trim().slice(0, 40); save(); refresh(); }
  });
  ipcMain.on('reorder', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length !== data.accounts.length) return;
    const by = new Map(data.accounts.map((a) => [a.id, a]));
    if (!ids.every((i) => by.has(i))) return;
    data.accounts = ids.map((i) => by.get(i));
    save();
    refresh();
  });
  ipcMain.on('tab-menu', (_e, id) => {
    Menu.buildFromTemplate([
      { label: 'Rename…', click: () => win.webContents.send('request-rename', id) },
      { label: 'Reload', click: () => views.get(id)?.webContents.reload() },
      { type: 'separator' },
      { label: 'Remove…', click: () => removeAccount(id) },
    ]).popup({ window: win });
  });
  // chrome.tabs.create called from an extension page (e.g. a popup); only extension pages may ask.
  ipcMain.on('ext-tab-create-page', (e, url) => {
    if (!e.senderFrame?.url.startsWith('chrome-extension://')) return;
    const ses = e.sender.session;
    const id = data.accounts.find((a) => views.get(a.id)?.webContents.session === ses)?.id;
    openFromExtension(ses, id, url);
  });
  ipcMain.on('dialog', (_e, open) => {
    overlay = !!open;
    if (TEST) console.log(`TEST_OVERLAY ${overlay}`);
    layout();
    if (!overlay) views.get(data.active)?.webContents.focus();
  });
  ipcMain.on('settings-menu', () => Menu.buildFromTemplate(settingItems()).popup({ window: win }));
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, show: false, icon: ICON, title: 'Mailroom',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202124' : '#e8eaed',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  win.setMenu(null);
  attachShortcuts(win.webContents);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('resize', layout);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.once('ready-to-show', () => {
    if (!TEST && !data.settings.startMinimized && !process.argv.includes('--hidden')) showWindow();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  app.on('browser-window-focus', () => views.get(data.active)?.webContents.focus());
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow();
    handleMailto(lib.findMailto(argv));
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {}); // keep running in the tray

  app.whenReady().then(() => {
    load();
    wireIpc();
    createWindow();
    for (const a of data.accounts) createView(a);
    if (!account(data.active)) data.active = data.accounts[0]?.id ?? null;
    layout();
    createTray();
    if (app.isPackaged && !TEST) app.setAsDefaultProtocolClient('mailto');
    win.webContents.once('did-finish-load', () => handleMailto(lib.findMailto(process.argv)));
    if (TEST) console.log('TEST_READY');
  });
}
