// Pure helpers (no Electron imports) so they can be unit-tested.

// Chrome-style reduced UA built from the engine version; no "Electron" or app tokens.
function buildUserAgent(chromeVersion) {
  const major = String(chromeVersion).split('.')[0];
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Firefox identity: Google's embedded-browser check is most lenient with it. Firefox sends no client hints.
function buildFirefoxUserAgent() {
  return 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
}

// Client-hint metadata matching a stock Google Chrome on Linux (brands + full version list).
function buildUserAgentMetadata(chromeVersion) {
  const major = String(chromeVersion).split('.')[0];
  const list = (v) => [
    { brand: 'Not.A/Brand', version: v === major ? '99' : '99.0.0.0' },
    { brand: 'Chromium', version: v },
    { brand: 'Google Chrome', version: v },
  ];
  return {
    brands: list(major), fullVersionList: list(String(chromeVersion)),
    platform: 'Linux', platformVersion: '6.8.0', architecture: 'x86', model: '',
    mobile: false, bitness: '64', wow64: false,
  };
}

const GOOGLE_SUFFIXES = ['google.com', 'gstatic.com', 'googleusercontent.com', 'youtube.com'];

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

// Hosts that may load inside an account tab (Gmail + Google sign-in).
function isGoogleHost(url) {
  const h = hostOf(url);
  return !!h && GOOGLE_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

function isGmailOrigin(url) {
  return hostOf(url) === 'mail.google.com';
}

// Gmail wraps outbound links in https://www.google.com/url?q=<target>; return the target.
function unwrapGoogleRedirect(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('google.com') && u.pathname === '/url') {
      const t = u.searchParams.get('q') || u.searchParams.get('url');
      if (t && /^https?:/i.test(t)) return t;
    }
  } catch {}
  return null;
}

// "Inbox (3) - name@gmail.com - Gmail" -> 3 ; no count but an address -> 0 ; otherwise null (unknown).
function parseUnread(title) {
  const m = /^[^()]*\((\d+)\)\s*-\s*[^\s@]+@\S+/.exec(title || '');
  if (m) return parseInt(m[1], 10);
  return /^Inbox\b.*-\s*[^\s@]+@[^\s@]+\.\S+/.test(title || '') ? 0 : null;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

// Gmail's unread Atom feed -> { valid, count, mails: [{ id, from, subject, summary, link }] }, newest first.
// `valid` is false when the response is not a feed (for example a sign-in page).
function parseAtomFeed(xml) {
  xml = String(xml);
  const tag = (block, t) => {
    const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(block);
    return m ? decodeXml(m[1].trim()) : '';
  };
  const mails = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const link = /<link[^>]*\bhref="([^"]+)"/.exec(m[1]);
    mails.push({
      id: tag(m[1], 'id'), from: tag(m[1], 'name'), subject: tag(m[1], 'title'),
      summary: tag(m[1], 'summary'), link: link ? decodeXml(link[1]) : '',
    });
  }
  const full = /<fullcount>(\d+)<\/fullcount>/.exec(xml);
  return { valid: /<feed[\s>]/.test(xml), count: full ? parseInt(full[1], 10) : mails.length, mails };
}

// Text for one mail.
function formatMail(label, mail) {
  return {
    title: `${mail.from || 'New mail'} - ${label}`,
    body: [mail.subject, mail.summary].filter(Boolean).join('\n'),
  };
}

// Text for several mails at once (or just a count when the feed was unavailable).
function formatSummary(label, count, mails, added = mails.length) {
  const shown = mails.slice(0, 3);
  const lines = shown.map((m) => `${m.from}: ${m.subject}`.trim());
  if (shown.length && mails.length > shown.length) lines.push(`+${mails.length - shown.length} more`);
  return {
    title: added === 1 ? `${label}: new mail` : `${label}: ${added} new messages`,
    body: lines.length ? lines.join('\n') : `${count} unread`,
  };
}

// ----- mute -----
const FOREVER = Number.MAX_SAFE_INTEGER;

// When a mute of the given kind ends (epoch ms): '1h', '8h', 'tomorrow' (next 8:00 local) or 'forever'.
function muteDeadline(kind, now = Date.now()) {
  if (kind === '1h') return now + 3600e3;
  if (kind === '8h') return now + 8 * 3600e3;
  if (kind === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  }
  return FOREVER;
}

function isMuted(account, now = Date.now()) {
  return !!account && typeof account.mutedUntil === 'number' && account.mutedUntil > now;
}

// Why a notification should stay quiet, or null to show it: switched off, tab muted, or you are looking at it.
function quietReason({ enabled, muted, looking }) {
  if (!enabled) return 'off';
  if (muted) return 'muted';
  return looking ? 'looking' : null;
}

function describeMute(until) {
  if (until >= FOREVER) return 'Muted';
  const t = new Date(until);
  const hm = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return t.toDateString() === new Date().toDateString() ? `Muted until ${hm}` : `Muted until tomorrow ${hm}`;
}

function composeUrl() {
  return 'https://mail.google.com/mail/?view=cm&fs=1';
}

function mailtoUrl(mailto) {
  return 'https://mail.google.com/mail/?extsrc=mailto&url=' + encodeURIComponent(mailto);
}

function findMailto(argv) {
  return argv.find((a) => /^mailto:/i.test(a)) || null;
}

module.exports = {
  buildUserAgent, buildFirefoxUserAgent, buildUserAgentMetadata, isGoogleHost, isGmailOrigin, unwrapGoogleRedirect,
  parseUnread, parseAtomFeed, formatMail, formatSummary, muteDeadline, isMuted, describeMute, quietReason, FOREVER, composeUrl, mailtoUrl, findMailto,
};
