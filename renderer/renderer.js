const $ = (id) => document.getElementById(id);
let state = { accounts: [], active: null };
let dragId = null;

function render() {
  const box = $('tabs');
  box.replaceChildren();
  for (const a of state.accounts) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (a.id === state.active ? ' active' : '');
    tab.draggable = true;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = a.label;
    tab.append(label);
    if (a.unread > 0) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = a.unread > 99 ? '99+' : a.unread;
      tab.append(b);
    }
    tab.addEventListener('click', () => window.tabs.select(a.id));
    tab.addEventListener('contextmenu', (e) => { e.preventDefault(); window.tabs.tabMenu(a.id); });
    tab.addEventListener('dragstart', () => { dragId = a.id; });
    tab.addEventListener('dragover', (e) => { e.preventDefault(); tab.classList.add('dragover'); });
    tab.addEventListener('dragleave', () => tab.classList.remove('dragover'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId || dragId === a.id) return;
      const ids = state.accounts.map((x) => x.id).filter((id) => id !== dragId);
      ids.splice(ids.indexOf(a.id), 0, dragId);
      dragId = null;
      window.tabs.reorder(ids);
    });
    box.append(tab);
  }
}

// <dialog> based prompt (window.prompt is not available in Electron).
function ask(title, value = '') {
  return new Promise((resolve) => {
    const dlg = $('dlg');
    if (dlg.open) return resolve(null);
    $('dlg-title').textContent = title;
    $('dlg-input').value = value;
    dlg.addEventListener('close', () => {
      const v = $('dlg-input').value.trim();
      resolve(dlg.returnValue === 'ok' && v ? v : null);
    }, { once: true });
    dlg.showModal();
    $('dlg-input').select();
  });
}

async function addAccount() {
  const label = await ask('Name for the new account (e.g. Work)');
  if (label) window.tabs.add(label);
}

$('add').addEventListener('click', addAccount);
$('settings').addEventListener('click', () => window.tabs.settingsMenu());
window.tabs.onRequestAdd(addAccount);
window.tabs.onRequestRename(async (id) => {
  const a = state.accounts.find((x) => x.id === id);
  const label = a && (await ask('Rename account', a.label));
  if (label) window.tabs.rename(id, label);
});
window.tabs.onState((s) => { state = s; render(); });
window.tabs.getState().then((s) => {
  state = s;
  render();
  if (!s.accounts.length) addAccount();
});
