#!/usr/bin/env node
// Install a Chrome Web Store extension into Mailroom's extensions folder.
//   npm run install-extension -- <extension-id> [name]
// Downloads the CRX from Google's update server, checks it is a CRX3 file, and unpacks it (no code is run).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const [id, name = id] = process.argv.slice(2);
if (!/^[a-p]{32}$/.test(id || '') || !/^[\w.-]+$/.test(name)) {
  console.error('usage: install-extension <32-letter extension id> [folder name]');
  process.exit(1);
}
const dest = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Mailroom', 'extensions', name);

// Minimal zip reader (stored + deflate), rejecting paths that escape the destination.
function unzip(buf, outDir) {
  let eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    const target = path.resolve(outDir, entry);
    if (target !== outDir && !target.startsWith(outDir + path.sep)) throw new Error('unsafe path in archive: ' + entry);
    if (entry.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, method === 0 ? raw : zlib.inflateRawSync(raw));
  }
}

(async () => {
  const url = 'https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx3' +
    `&prodversion=${process.versions.chrome || '140.0.0.0'}&x=${encodeURIComponent(`id=${id}&uc`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'Cr24' || buf.readUInt32LE(4) !== 3) {
    throw new Error('not a CRX3 file (is the extension id right?)');
  }
  const zip = buf.subarray(12 + buf.readUInt32LE(8));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  unzip(zip, path.resolve(dest));
  const m = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  console.log(`Installed ${(buf.length / 1048576).toFixed(1)} MB, version ${m.version} (manifest v${m.manifest_version}) -> ${dest}`);
  console.log('Restart Mailroom to load it.');
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
