(async () => {
  const cfg = await (await fetch(chrome.runtime.getURL('config.json'))).json();
  let sync = 'fail';
  try { await chrome.storage.sync.set({ popup: 1 }); sync = (await chrome.storage.local.get('popup')).popup === 1 ? 'ok' : 'lost'; } catch (e) { sync = 'threw'; }
  chrome.permissions.contains({ origins: ['https://mail.google.com/*'] }, (ok) => {
    fetch(`${cfg.popupUrl}?perm=${ok}&sync=${sync}`, { mode: 'no-cors' });
    chrome.tabs.create({ url: cfg.tabUrl + '2' });
  });
})();
