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
  wc.loadURL(GMAIL_URL);
  return view;
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  for (const [id, v] of views) {
    v.setBounds({ x: 0, y: TAB_H, width: w, height: Math.max(0, h - TAB_H) });
    v.setVisible(id === data.active);
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
    if (!data.settings.startMinimized && !process.argv.includes('--hidden')) showWindow();
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
