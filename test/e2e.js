// End-to-end check against a fake "Gmail" on localhost. Run: node test/e2e.js
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const electron = require('electron');
const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mailroom-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = []; // request headers seen by the fake Gmail
const hits = []; // extension windows: { path, ua }

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/tab-test') || req.url.startsWith('/popup-test')) hits.push({ path: req.url.split('?')[0], query: req.url.split('?')[1] || '', ua: req.headers['user-agent'] });
  if (req.url.startsWith('/mail/u/0/feed/atom')) {
    res.setHeader('content-type', 'application/atom+xml');
    res.end('<feed><entry><title>Quarterly report</title><summary>Numbers inside</summary><author><name>Pat Boss</name></author></entry><entry><title>Older</title><summary>x</summary><author><name>Z</name></author></entry></feed>');
    return;
  }
  if (req.url === '/echo') {
    seen.push({ ua: req.headers['user-agent'], chua: req.headers['sec-ch-ua'] || '' });
    res.end('ok');
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end('<title>Inbox (0) - test@example.com - Gmail</title><body>fake</body>');
});

async function cdp(port, match) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const t = list.find((x) => (x.type === 'page' || x.type === 'service_worker') && match(x));
  assert(t, 'CDP target not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  return {
    eval: (expr) => new Promise((resolve) => {
      const i = ++id; pending.set(i, (d) => resolve(d.result?.result?.value));
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    }),
    close: () => ws.close(),
  };
}

function launch(port, url) {
  const extDir = path.join(userData, 'extensions', 'probe');
  fs.cpSync(path.join(__dirname, 'fixtures', 'probe-ext'), extDir, { recursive: true });
  const base = new URL(url);
  fs.writeFileSync(path.join(extDir, 'config.json'), JSON.stringify({
    tabUrl: `http://localhost:${base.port}/tab-test`, popupUrl: `http://localhost:${base.port}/popup-test`,
  }));
  const child = spawn(electron, [root, `--remote-debugging-port=${port}`, ...(process.env.GT_NO_SANDBOX ? ['--no-sandbox'] : [])], {
    env: { ...process.env, MAILROOM_TEST: '1', MAILROOM_TEST_CLICK: '1', MAILROOM_TEST_POPUP: '1', MAILROOM_USERDATA: userData, MAILROOM_START_URL: url },
  });
  const out = [];
  child.stdout.on('data', (d) => out.push(...d.toString().split('\n').filter(Boolean)));
  child.stderr.on('data', (d) => { if (process.env.GT_DEBUG) process.stderr.write(d); });
  return { child, out };
}
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error('timeout waiting for ' + what);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const port = 9300 + Math.floor(Math.random() * 500);
  let app = launch(port, url);
  try {
    await waitFor(() => app.out.includes('TEST_READY'), 'app ready');
    const ui = await waitFor(() => cdp(port, (t) => t.url.includes('renderer/index.html')).catch(() => null), 'tab bar');
    console.log('ok  window + tab bar UI opened');

    // First account through the real "+" dialog (no Gmail view yet), second one with a view already open.
    const count = (line) => app.out.filter((l) => l === line).length;
    for (const [i, name] of ['Alpha', 'Beta'].entries()) {
      // An empty profile opens the dialog by itself; otherwise click "+".
      if (!(await ui.eval(`document.getElementById('dlg').open`))) await ui.eval(`document.getElementById('add').click()`);
      await waitFor(async () => (await ui.eval(`document.getElementById('dlg').open`)) === true, 'dialog open');
      await waitFor(() => count('TEST_OVERLAY true') > i, 'Gmail views hidden while dialog open');
      await ui.eval(`document.getElementById('dlg-input').value='${name}'; document.querySelector('#form button[value=ok]').click()`);
      await waitFor(() => count('TEST_OVERLAY false') > i, 'overlay cleared');
      await waitFor(async () => (await ui.eval(`document.querySelectorAll('.tab').length`)) === i + 1, 'tab ' + name);
    }
    await waitFor(async () => (await ui.eval(`document.querySelectorAll('.tab').length`)) === 2, 'two tabs (have ' + (await ui.eval(`[...document.querySelectorAll('.tab .label')].map(x=>x.textContent).join('+')`)) + ', out=' + app.out.slice(-6).join(';') + ')');
    console.log('ok  two accounts added through the real + dialog (views hidden while it is open)');

    const pages = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const p = list.filter((x) => x.type === 'page' && x.url.startsWith(url));
      return p.length === 2 ? p : null;
    }, 'two account pages');
    const [A, B] = await Promise.all(pages.map((p) => cdp(port, (t) => t.id === p.id)));

    // extensions: a probe extension uses chrome.notifications / permissions / storage.sync, then gets a click
    await waitFor(() => app.out.find((l) => l === 'TEST_EXT_NOTIFY Probe title | perm:true sync:object'), 'extension notification');
    const sw = await waitFor(() => cdp(port, (t) => t.type === 'service_worker').catch(() => null), 'extension worker');
    await waitFor(async () => (await sw.eval('self.clicked')) === 'probe', 'click delivered to extension');
    assert.strictEqual(await waitFor(async () => { const v = await sw.eval('self.syncResult'); return v !== 'pending' && v; }, 'worker sync result'), 'ok', 'chrome.storage.sync write/read in the service worker');
    console.log('ok  extension loads; chrome.notifications/permissions work, chrome.storage.sync really writes; click reaches the extension');
    await waitFor(() => hits.find((h) => h.path === '/tab-test'), 'chrome.tabs.create window');
    const pop = await waitFor(() => hits.find((h) => h.path === '/popup-test'), 'extension popup window');
    assert.strictEqual(pop.query, 'perm=true&sync=ok', 'popup page shims: ' + pop.query);
    await waitFor(() => hits.find((h) => h.path === '/tab-test2'), 'chrome.tabs.create from an extension page');
    assert(hits.every((h) => /Firefox\//.test(h.ua) && !/Electron/.test(h.ua)), 'extension window UA: ' + JSON.stringify(hits));
    console.log('ok  chrome.tabs.create opens a window with the session; extension popup page loads and runs');

    for (const pg of [A, B]) {
      assert.strictEqual(await waitFor(() => pg.eval('document.documentElement.dataset.mrCs'), 'content script sync result'), 'ok', 'chrome.storage.sync write/read in a content script');
    }
    console.log('ok  content scripts can use chrome.storage.sync (what Mailtrack sign-in needs)');

    // user agent
    const ua = await A.eval('navigator.userAgent');
    assert(!/Electron|Mailroom|mailroom/i.test(ua), 'UA leaks Electron/app: ' + ua);
    const brands = await A.eval('JSON.stringify(navigator.userAgentData.brands)');
    console.log('    brands:', brands, 'window.chrome:', await A.eval('typeof window.chrome'), 'webdriver:', await A.eval('navigator.webdriver'));
    assert(!/Electron/i.test(brands) && !/Chromium|Chrome/.test(brands), 'client hints wrong: ' + brands);
    assert(/Firefox\//.test(ua), 'expected Firefox identity: ' + ua);
    await A.eval(`fetch('/echo')`); await B.eval(`fetch('/echo')`);
    console.log('    headers seen:', JSON.stringify(seen[0]), 'uaData:', await A.eval('typeof navigator.userAgentData'));
    assert(seen.length >= 2 && seen.every((s) => !/Electron/i.test(s.ua + s.chua)), 'request headers leak Electron');
    console.log('ok  user agent + client hints have Firefox identity, no Electron token:', ua);

    // isolation
    await A.eval(`document.cookie='who=alpha; max-age=3600'; localStorage.setItem('k','A')`);
    assert.strictEqual(await B.eval('document.cookie'), '', 'cookie leaked to other account');
    assert.strictEqual(await B.eval(`localStorage.getItem('k')`), null, 'localStorage leaked');
    assert.strictEqual(await A.eval('document.cookie'), 'who=alpha');
    console.log('ok  sessions isolated (cookies + localStorage)');

    // notifications: title counts
    app.out.length = 0;
    await A.eval(`document.title='Inbox (2) - a@example.com - Gmail'`);
    const na = await waitFor(() => app.out.find((l) => /^TEST_NOTIFY \w+ 2 \+2 \| \w+: 2 new messages \| Pat Boss: Quarterly report \/ Z: Older$/.test(l)), 'notification for first page');
    await B.eval(`document.title='Inbox (1) - b@example.com - Gmail'`);
    const nb = await waitFor(() => app.out.find((l) => /^TEST_NOTIFY \w+ 1 \+1 \| Pat Boss - \w+ \| Quarterly report \/ Numbers inside$/.test(l)), 'notification for second page');
    assert.notStrictEqual(na.split(' ')[1], nb.split(' ')[1], 'both notifications named the same account');
    assert.deepStrictEqual([na.split(' ')[1], nb.split(' ')[1]].sort(), ['Alpha', 'Beta']);
    await A.eval(`document.title='Inbox (1) - a@example.com - Gmail'`); // decrease: no notification
    await sleep(400);
    assert(!app.out.some((l) => /^TEST_NOTIFY \w+ 1 \+/.test(l) && l !== nb), 'notified on decrease');
    await waitFor(() => app.out.includes('TEST_TOTAL 2'), 'total=2');
    const badges = await ui.eval(`[...document.querySelectorAll('.badge')].map(b=>b.textContent).join(',')`);
    assert.strictEqual(badges, '1,1');
    console.log('ok  title change -> native notification, no notify on decrease, badges + total updated');

    // persistence across restart
    app.child.kill('SIGTERM'); await sleep(1500);
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'accounts.json'), 'utf8'));
    assert.deepStrictEqual(saved.accounts.map((a) => a.label), ['Alpha', 'Beta']);
    app = launch(port + 1, url);
    await waitFor(() => app.out.includes('TEST_READY'), 'app ready 2');
    const ui2 = await waitFor(() => cdp(port + 1, (t) => t.url.includes('renderer/index.html')).catch(() => null), 'tab bar 2');
    await waitFor(async () => (await ui2.eval(`document.querySelectorAll('.tab').length`)) === 2, 'tabs restored');
    const list = await (await fetch(`http://127.0.0.1:${port + 1}/json`)).json();
    const first = list.find((x) => x.type === 'page' && x.url.startsWith(url));
    const A2 = await cdp(port + 1, (t) => t.id === first.id);
    const cookies = await waitFor(async () => {
      const l = await (await fetch(`http://127.0.0.1:${port + 1}/json`)).json();
      for (const p of l.filter((x) => x.type === 'page' && x.url.startsWith(url))) {
        const c = await cdp(port + 1, (t) => t.id === p.id);
        const v = await c.eval('document.cookie'); c.close();
        if (v) return v;
      }
    }, 'persisted cookie');
    assert.strictEqual(cookies, 'who=alpha');
    console.log('ok  accounts restored and login cookie persisted after restart');
    console.log('\nALL E2E CHECKS PASSED');
  } finally {
    app.child.kill('SIGTERM');
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; });
