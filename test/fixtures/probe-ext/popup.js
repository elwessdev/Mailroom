(async () => {
  const cfg = await (await fetch(chrome.runtime.getURL('config.json'))).json();
  chrome.permissions.contains({ origins: ['https://mail.google.com/*'] }, (ok) => {
    fetch(`${cfg.popupUrl}?perm=${ok}&sync=${typeof chrome.storage.sync}`, { mode: 'no-cors' });
    chrome.tabs.create({ url: cfg.tabUrl + '2' });
  });
})();
