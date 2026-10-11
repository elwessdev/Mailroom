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
  assert.strictEqual(lib.parseUnread('Lunch plans - name@gmail.com - Gmail'), null); // a thread says nothing about unread
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

const FEED = `<?xml version="1.0"?><feed><title>Gmail - Inbox</title><fullcount>7</fullcount>
<entry><title>Lunch &amp; plans?</title><summary>Are you free at noon&#39;s end</summary><id>tag:gmail.google.com,2004:1</id><link rel="alternate" href="https://mail.google.com/mail?account_id=a&amp;message_id=1&amp;view=conv"/><author><name>Sam Lee</name><email>sam@x.com</email></author></entry>
<entry><title>Invoice</title><summary>Attached</summary><id>tag:gmail.google.com,2004:2</id><author><name>Billing</name></author></entry></feed>`;

test('atom feed parsing', () => {
  const f = lib.parseAtomFeed(FEED);
  assert.strictEqual(f.valid, true);
  assert.strictEqual(f.count, 7); // the feed's own total, not just the entries it lists
  assert.strictEqual(f.mails.length, 2);
  assert.deepStrictEqual(f.mails[0], {
    id: 'tag:gmail.google.com,2004:1', from: 'Sam Lee', subject: 'Lunch & plans?', summary: "Are you free at noon's end",
    link: 'https://mail.google.com/mail?account_id=a&message_id=1&view=conv',
  });
  assert.strictEqual(f.mails[1].link, '');
  assert.strictEqual(lib.parseAtomFeed('<html>Sign in</html>').valid, false);
});

test('notification text', () => {
  const [m1, m2] = lib.parseAtomFeed(FEED).mails;
  assert.deepStrictEqual(lib.formatMail('Work', m1), { title: 'Sam Lee - Work', body: "Lunch & plans?\nAre you free at noon's end" });
  const two = lib.formatSummary('Work', 5, [m1, m2]);
  assert.strictEqual(two.title, 'Work: 2 new messages');
  assert.strictEqual(two.body, 'Sam Lee: Lunch & plans?\nBilling: Invoice');
  const many = lib.formatSummary('Work', 9, [m1, m2, m1, m2, m1]);
  assert.strictEqual(many.body.split('\n').pop(), '+2 more');
  assert.deepStrictEqual(lib.formatSummary('Work', 5, [], 1), { title: 'Work: new mail', body: '5 unread' });
  assert.strictEqual(lib.formatSummary('Work', 5, [], 3).title, 'Work: 3 new messages');
});

test('mute deadlines', () => {
  const now = new Date(2026, 9, 10, 15, 30).getTime(); // Oct 10 2026, 15:30 local
  assert.strictEqual(lib.muteDeadline('1h', now), now + 3600e3);
  assert.strictEqual(lib.muteDeadline('8h', now), now + 8 * 3600e3);
  const t = new Date(lib.muteDeadline('tomorrow', now));
  assert.deepStrictEqual([t.getDate(), t.getHours(), t.getMinutes()], [11, 8, 0]);
  const early = new Date(lib.muteDeadline('tomorrow', new Date(2026, 9, 10, 2, 0).getTime()));
  assert.strictEqual(early.getDate(), 11); // "tomorrow morning", even at 02:00
  assert.strictEqual(lib.muteDeadline('forever', now), lib.FOREVER);
  assert.ok(lib.isMuted({ mutedUntil: now + 1 }, now));
  assert.ok(!lib.isMuted({ mutedUntil: now }, now));
  assert.ok(!lib.isMuted({}, now) && !lib.isMuted(undefined, now));
  assert.strictEqual(lib.describeMute(lib.FOREVER), 'Muted');
});

test('quiet rules', () => {
  assert.strictEqual(lib.quietReason({ enabled: false, muted: true, looking: true }), 'off');
  assert.strictEqual(lib.quietReason({ enabled: true, muted: true, looking: true }), 'muted');
  assert.strictEqual(lib.quietReason({ enabled: true, muted: false, looking: true }), 'looking');
  assert.strictEqual(lib.quietReason({ enabled: true, muted: false, looking: false }), null);
});
