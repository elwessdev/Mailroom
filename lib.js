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
  return /-\s*[^\s@]+@[^\s@]+\.\S+/.test(title || '') ? 0 : null;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

// Gmail's unread Atom feed -> [{from, subject, summary}], newest first.
function parseAtomFeed(xml) {
  const tag = (block, t) => {
    const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(block);
    return m ? decodeXml(m[1].trim()) : '';
  };
  const out = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    out.push({ from: tag(m[1], 'name'), subject: tag(m[1], 'title'), summary: tag(m[1], 'summary') });
  }
  return out;
}

// Notification text. `mails` may be empty (feed unavailable): fall back to counts only.
function formatNotification(label, count, added, mails) {
  const shown = mails.slice(0, Math.min(added, 3));
  if (shown.length === 1 && added === 1) {
    const m = shown[0];
    return { title: `${m.from || 'New mail'} - ${label}`, body: [m.subject, m.summary].filter(Boolean).join('\n') };
  }
  const lines = shown.map((m) => `${m.from}: ${m.subject}`.trim());
  const more = added - shown.length;
  if (shown.length && more > 0) lines.push(`+${more} more`);
  return {
    title: `${label}: ${added} new messages`,
    body: lines.length ? lines.join('\n') : `${count} unread`,
  };
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
  parseUnread, parseAtomFeed, formatNotification, composeUrl, mailtoUrl, findMailto,
};
