// Content script: uses chrome.storage.sync like Mailtrack's sign-in page does.
(async () => {
  let r = 'fail';
  try { await chrome.storage.sync.set({ cs: 1 }); r = (await chrome.storage.local.get('cs')).cs === 1 ? 'ok' : 'lost'; } catch (e) { r = 'threw'; }
  document.documentElement.dataset.mrCs = r;
})();
