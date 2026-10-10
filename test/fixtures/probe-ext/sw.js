// Exercises the APIs Electron lacks; used by test/e2e.js (which writes config.json next to this file).
self.clicked = null;
self.syncResult = 'pending';
chrome.notifications.onClicked.addListener((id) => { self.clicked = id; });
(async () => {
  try { await chrome.storage.sync.set({ sw: 1 }); self.syncResult = (await chrome.storage.local.get('sw')).sw === 1 ? 'ok' : 'lost'; }
  catch (e) { self.syncResult = 'threw'; }
})();
chrome.permissions.contains({ origins: ['https://mail.google.com/*'] }, async (ok) => {
  chrome.notifications.create('probe', {
    type: 'basic', title: 'Probe title', message: `perm:${ok} sync:${typeof chrome.storage.sync}`, iconUrl: 'x.png',
  });
  const cfg = await (await fetch(chrome.runtime.getURL('config.json'))).json();
  chrome.tabs.create({ url: cfg.tabUrl });
});
