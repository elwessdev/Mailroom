// Exercises the APIs Electron lacks; used by test/e2e.js (which writes config.json next to this file).
self.clicked = null;
chrome.notifications.onClicked.addListener((id) => { self.clicked = id; });
chrome.permissions.contains({ origins: ['https://mail.google.com/*'] }, async (ok) => {
  chrome.notifications.create('probe', {
    type: 'basic', title: 'Probe title', message: `perm:${ok} sync:${typeof chrome.storage.sync}`, iconUrl: 'x.png',
  });
  const cfg = await (await fetch(chrome.runtime.getURL('config.json'))).json();
  chrome.tabs.create({ url: cfg.tabUrl });
});
