# Mailroom

> Unofficial. Mailroom is not affiliated with or endorsed by Google. It loads the real Gmail website
> in tabs; it does not store, proxy or analyse your mail.

Several Gmail accounts in one window, one tab each, with native desktop notifications.
It wraps the real Gmail web page (Electron, plain JavaScript, no telemetry).

- Each account has its own persistent, isolated session (`persist:acct-<id>`).
- Unread count per tab, total in the window title and tray tooltip; native notification when the count rises.
- Notifications show sender, subject and a preview (read from Gmail's unread feed with that account's own session; never logged or stored) and play the system "new message" sound (toggle: ⋮ menu or tray).
- Tray icon, close-to-tray, single instance, `mailto:` handler, optional start minimized / launch at login.
- Shortcuts: `Ctrl+T` add account, `Ctrl+Tab` / `Ctrl+Shift+Tab` and `Ctrl+1..9` switch, `Ctrl+R` reload. `Ctrl+W` is deliberately ignored.
- Right-click a tab to rename, reload or remove; drag tabs to reorder.

## Run

```bash
npm install
npm start
```

Needs Node 20+ (developed on Node 24). Wayland is used automatically (`ozone-platform-hint=auto`), X11 works too.

## Test

```bash
npm test   # unit tests + an end-to-end run against a fake Gmail on localhost
```

## Build

```bash
npm run dist   # dist/*.deb and dist/*.AppImage
sudo apt install ./dist/mailroom_0.3.1_amd64.deb
```

## Extensions (experimental)

Unpacked Chrome extensions in `~/.config/Mailroom/extensions/<name>/` are loaded into every account tab at
startup. Electron implements only part of the extension API, so Mailroom supplies `chrome.notifications`
(native notification + sound; clicking switches to the tab), `chrome.permissions` (always granted) and
`chrome.storage.sync` (backed by local storage). To do that it adds one line to the top of each extension's
service worker.

Install one from the Chrome Web Store by its id (the 32-letter id in the store URL):

```bash
npm run install-extension -- <extension-id> <folder-name>
```

Example, [Mailtrack](https://mailsuite.com) (email read receipts; id taken from its own site):

```bash
npm run install-extension -- ndnaehgpjlnokgebbaldlmgkapkpjkkb mailtrack
```

Restart Mailroom afterwards. Electron has no extensions toolbar, so each extension's popup is in the ⋮ menu
(and the tray menu), listed for the active account. Extensions are loaded per account, so set one up in each
tab. For Mailtrack: open ⋮ → *Mailtrack…* → *Sign in with Google*. Pages an extension opens
(`chrome.tabs.create`) appear in a small Mailroom window that shares that account's session.
Extensions can read your mail pages: only install ones you trust.

## Notes

- A tab shows `mail.google.com` and Google sign-in pages; every other link opens in your default browser.
- Sign-in: Google refuses sign-in from Chromium-based wrappers that identify as Chrome ("This browser or app
  may not be secure"). Mailroom therefore presents itself as Firefox (user agent, no client hints), which
  Google currently accepts. This is a workaround, not a guarantee: Google can change its check at any time.
  Set `MAILROOM_UA=chrome` to use a Chrome identity instead. There is never an "Electron" token.
- Gmail's own web notifications are blocked by default because they duplicate Mailroom's. Enable them with
  "Gmail's own notifications" in the ⋮ menu (restart needed) if you prefer them.
- Data lives in `~/.config/Mailroom`. Nothing is logged or sent anywhere except to Google.

MIT licensed.
