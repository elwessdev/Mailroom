const test = require('node:test');
const assert = require('node:assert');
const lib = require('../lib');

test('user agent has no Electron/app tokens and tracks Chrome major', () => {
  const ua = lib.buildUserAgent('140.0.7339.82');
  assert.match(ua, /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(ua, /Electron|Gmail|mailroom/i);
  assert.ok(ua.includes('Chrome/140.0.0.0'));
});

test('parseUnread', () => {
  assert.strictEqual(lib.parseUnread('Inbox (3) - name@gmail.com - Gmail'), 3);
  assert.strictEqual(lib.parseUnread('Inbox - name@gmail.com - Gmail'), 0);
  assert.strictEqual(lib.parseUnread('Gmail'), null);
  assert.strictEqual(lib.parseUnread(''), null);
});

test('google host routing', () => {
  assert.ok(lib.isGoogleHost('https://accounts.google.com/signin'));
  assert.ok(lib.isGoogleHost('https://mail.google.com/mail/u/0/'));
  assert.ok(!lib.isGoogleHost('https://evilgoogle.com/'));
  assert.ok(!lib.isGoogleHost('https://google.com.evil.org/'));
  assert.ok(!lib.isGoogleHost('http://mail.google.com/'));
  assert.ok(!lib.isGoogleHost('https://example.org/'));
  assert.ok(lib.isGmailOrigin('https://mail.google.com'));
  assert.ok(!lib.isGmailOrigin('https://accounts.google.com'));
  assert.strictEqual(lib.unwrapGoogleRedirect('https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fx'), 'https://example.org/x');
  assert.strictEqual(lib.unwrapGoogleRedirect('https://www.google.com/url?q=javascript:alert(1)'), null);
});

test('mailto', () => {
  assert.strictEqual(lib.findMailto(['x', 'mailto:a@b.c?subject=hi']), 'mailto:a@b.c?subject=hi');
  assert.strictEqual(lib.mailtoUrl('mailto:a@b.c'), 'https://mail.google.com/mail/?extsrc=mailto&url=mailto%3Aa%40b.c');
});

const FEED = `<?xml version="1.0"?><feed><title>Gmail - Inbox</title><fullcount>2</fullcount>
<entry><title>Lunch &amp; plans?</title><summary>Are you free at noon&#39;s end</summary><author><name>Sam Lee</name><email>sam@x.com</email></author></entry>
<entry><title>Invoice</title><summary>Attached</summary><author><name>Billing</name></author></entry></feed>`;

test('atom feed + notification text', () => {
  const mails = lib.parseAtomFeed(FEED);
  assert.deepStrictEqual(mails[0], { from: 'Sam Lee', subject: 'Lunch & plans?', summary: "Are you free at noon's end" });
  assert.strictEqual(mails.length, 2);
  const one = lib.formatNotification('Work', 5, 1, mails);
  assert.strictEqual(one.title, 'Sam Lee - Work');
  assert.match(one.body, /Lunch & plans\?\nAre you free/);
  const two = lib.formatNotification('Work', 5, 2, mails);
  assert.strictEqual(two.title, 'Work: 2 new messages');
  assert.strictEqual(two.body, 'Sam Lee: Lunch & plans?\nBilling: Invoice');
  assert.strictEqual(lib.formatNotification('Work', 5, 4, mails).body.split('\n').pop(), '+2 more');
  assert.strictEqual(lib.formatNotification('Work', 5, 1, []).body, '5 unread');
});
