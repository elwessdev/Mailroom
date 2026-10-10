// Exercises the APIs Electron lacks; used by test/e2e.js.
self.clicked = null;
chrome.notifications.onClicked.addListener((id) => { self.clicked = id; });
chrome.permissions.contains({ origins: ['https://mail.google.com/*'] }, (ok) => {
  chrome.notifications.create('probe', {
    type: 'basic', title: 'Probe title', message: `perm:${ok} sync:${typeof chrome.storage.sync}`, iconUrl: 'x.png',
  });
});
