'use strict';
/* node --test test/packaging.test.js — electron-builder.yml fuses, scripts/verify-fuses.js helpers,
 * the Windows installer hooks (build/installer.nsh), the release workflow's signing job
 * (.github/workflows/build.yml) and the docs that describe them. Pure Node: reads files, builds
 * nothing, opens no socket. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const vf = require('../scripts/verify-fuses');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readText = (rel) => read(rel).replace(/\r\n/g, '\n'); // docs: same result on a CRLF checkout
const BUILDER_YML = read('electron-builder.yml');
const NSH = read('build/installer.nsh');

// ---------------------------------------------------------------------------------------------
// electron-builder.yml → electronFuses
// ---------------------------------------------------------------------------------------------

test('electronFuses: hardening fuses are set exactly as reviewed', () => {
  assert.deepEqual(vf.parseFuseConfig(BUILDER_YML), {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  });
});

test('electronFuses: grantFileProtocolExtraPrivileges stays at the default (file:// ES modules)', () => {
  assert.equal('grantFileProtocolExtraPrivileges' in vf.parseFuseConfig(BUILDER_YML), false);
});

test('electronFuses: every key exists in electron-builder\'s scheme and in the V1 fuse wire', (t) => {
  const keys = Object.keys(vf.parseFuseConfig(BUILDER_YML));
  for (const k of keys) assert.ok(k in vf.FUSE_V1_INDEX, `${k} is not a V1 fuse`);
  const schemePath = path.join(root, 'node_modules', 'app-builder-lib', 'scheme.json');
  if (!fs.existsSync(schemePath)) return t.skip('app-builder-lib not installed');
  const scheme = JSON.parse(fs.readFileSync(schemePath, 'utf8'));
  const props = scheme.definitions.FuseOptionsV1.properties;
  for (const k of keys) assert.ok(k in props, `${k} is not in scheme.json FuseOptionsV1`);
  for (const k of Object.keys(vf.FUSE_V1_INDEX)) assert.ok(k in props, `FUSE_V1_INDEX.${k} unknown to electron-builder`);
});

test('electron-builder.yml: ASAR packaging stays on and integrity data is not disabled', () => {
  assert.match(BUILDER_YML, /^asar: true\s*$/m);
  assert.doesNotMatch(BUILDER_YML, /^\s*disableAsarIntegrity:\s*true/m);
  // koffi's native binary must stay outside the archive (dlopen cannot read app.asar).
  assert.match(BUILDER_YML, /^\s+- node_modules\/koffi\/\*\*\s*$/m);
  assert.match(BUILDER_YML, /^\s+- node_modules\/@koromix\/\*\*\s*$/m);
});

test('electron-builder.yml: the macOS entitlements are still applied', () => {
  assert.match(BUILDER_YML, /^\s+entitlements: build\/entitlements\.mac\.plist\s*$/m);
  assert.match(BUILDER_YML, /^\s+entitlementsInherit: build\/entitlements\.mac\.plist\s*$/m);
});

/**
 * `key: value` pairs of a second-level YAML mapping (e.g. mac → extendInfo), dependency-free:
 * comment and blank lines are skipped, the block ends at the first line indented at or above `sub`.
 */
function yamlSubMapping(yml, top, sub) {
  const lines = yml.split(/\r?\n/);
  const skip = (l) => /^\s*(#.*)?$/.test(l);
  const indent = (l) => /^ */.exec(l)[0].length;
  let i = lines.findIndex((l) => new RegExp(`^${top}:\\s*(#.*)?$`).test(l));
  assert.ok(i >= 0, `no top-level ${top}:`);
  let subIndent = -1;
  for (i += 1; i < lines.length; i++) {
    const l = lines[i];
    if (skip(l)) continue;
    if (indent(l) === 0) break;
    if (new RegExp(`^\\s+${sub}:\\s*(#.*)?$`).test(l)) { subIndent = indent(l); break; }
  }
  assert.ok(subIndent > 0, `no ${top}.${sub}:`);
  const out = {};
  for (i += 1; i < lines.length; i++) {
    const l = lines[i];
    if (skip(l)) continue;
    if (indent(l) <= subIndent) break;
    const m = /^\s+([A-Za-z0-9_]+):\s+(.*)$/.exec(l);
    assert.ok(m, `unexpected line in ${top}.${sub}: ${l}`);
    assert.ok(!(m[1] in out), `duplicate ${top}.${sub}.${m[1]}`);
    out[m[1]] = m[2];
  }
  return out;
}

const DOWNLOADS_USAGE = 'Tunnelview saves files that people you connect with send you in Downloads/Tunnelview.';

test('electron-builder.yml: mac Info.plist explains the Downloads-folder consent (default receive folder)', () => {
  const info = yamlSubMapping(BUILDER_YML, 'mac', 'extendInfo');
  assert.equal(info.NSDownloadsFolderUsageDescription, DOWNLOADS_USAGE);
  // The other privacy strings stay too.
  for (const k of ['NSAudioCaptureUsageDescription', 'NSLocalNetworkUsageDescription']) assert.ok(info[k], `${k} missing`);
  for (const [k, v] of Object.entries(info)) {
    assert.match(k, /^NS[A-Za-z]+UsageDescription$/, `${k} is not a privacy usage-string key`);
    // Plain one-line scalars: a ': ' or ' #' would change how YAML reads them, quotes would be kept.
    assert.ok(v.length > 20 && !/:\s|\s#|^["'&*!|>%@`{[]/.test(v), `${k} must be a plain one-line sentence`);
  }
});

test('electron-builder.yml: parsed with js-yaml (as electron-builder does), the plist strings are intact', (t) => {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return t.skip('js-yaml not installed'); }
  const cfg = yaml.load(BUILDER_YML);
  assert.equal(cfg.mac.extendInfo.NSDownloadsFolderUsageDescription, DOWNLOADS_USAGE);
  for (const v of Object.values(cfg.mac.extendInfo)) assert.equal(typeof v, 'string');
  assert.deepEqual(cfg.electronFuses, vf.parseFuseConfig(BUILDER_YML));
});

test('package.json: the app version and the lockfile root agree (installer names, /info, hello)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const lockPath = path.join(root, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return;
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('docs: ARCHITECTURE §4 lists exactly the protocol DENY reasons and the current protocol version', () => {
  const P = require('../src/shared/protocol');
  const doc = read('docs/ARCHITECTURE.md');
  const row = /^\| `denied` \| H→V \| `reason: ([^`]*)`/m.exec(doc);
  assert.ok(row, 'no `denied` row in the §4 message table');
  const listed = [...row[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, Object.values(P.DENY).sort());
  assert.match(doc, new RegExp(`\`PROTOCOL_VERSION\` is \\*\\*${P.PROTOCOL_VERSION}\\*\\*`));
  assert.ok(doc.includes(`AUTH.CONTEXT = '${P.AUTH.CONTEXT}'`), 'AUTH.CONTEXT differs from the docs');
});

test('docs: ARCHITECTURE §4 states the pairing constants as protocol.js has them', () => {
  const P = require('../src/shared/protocol');
  const s4 = docSection(read('docs/ARCHITECTURE.md'), 4);
  assert.ok(s4.includes(`IDENT.CONTEXT = '${P.IDENT.CONTEXT}'`), 'IDENT.CONTEXT differs from the docs');
  assert.ok(s4.includes(`PAIR.CONTEXT = '${P.PAIR.CONTEXT}'`), 'PAIR.CONTEXT differs from the docs');
  // protocol.js has the header in lower case (how Node presents incoming header names).
  const header = /^ {2}\| `(X-Tunnelview-Client-Nonce)` \|/m.exec(s4);
  assert.ok(header && header[1].toLowerCase() === P.CLIENT_NONCE_HEADER, 'client-nonce header row');
  assert.ok(s4.includes(`(\`PROTOCOL.INFO_FEATURES\`) is \`[${P.INFO_FEATURES.map((f) => `'${f}'`).join(', ')}]\``), 'INFO_FEATURES differs from the docs');
  assert.ok(s4.includes(`\`${P.PAIR.LINK_PREFIX}<base64url(`), 'link prefix');
  assert.ok(s4.includes(`**${P.PAIR.TTL_MS / 60000} min** (\`PAIR.TTL_MS\`)`), 'PAIR.TTL_MS differs from the docs');
  assert.match(s4, new RegExp(`\\*\\*${P.PAIR.MAX_FAILURES}\\*\\*\\s+\\(\`PAIR\\.MAX_FAILURES\`\\)`), 'PAIR.MAX_FAILURES differs from the docs');
});

/** The text of the `## <n>. …` section of ARCHITECTURE.md (up to the next `## ` heading). */
function docSection(doc, n) {
  const start = doc.search(new RegExp(`^## ${n}\\. `, 'm'));
  assert.ok(start >= 0, `no §${n} in ARCHITECTURE.md`);
  const rest = doc.slice(start + 3);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** rtc.js (renderer ES module) loaded in Node: it reads the protocol constants from a global. */
function loadRtc() {
  globalThis.TunnelviewProtocol = require('../src/shared/protocol');
  return import('../src/renderer/shared/rtc.js');
}

/** Value of `const NAME = <number expression>;` in a source file (e.g. 5000, 60e3, 15 * 60e3). */
function srcNumber(src, name) {
  const m = new RegExp(`(?:^|\\n)\\s*const ${name} = ([0-9e.\\s*+-]+);`).exec(src);
  assert.ok(m, `no numeric const ${name}`);
  const v = Function(`"use strict"; return (${m[1]});`)();
  assert.ok(Number.isFinite(v), `${name} is not a number`);
  return v;
}

/** A section's text with all whitespace runs collapsed to one space (phrases may wrap). */
const flat = (text) => text.replace(/\s+/g, ' ');

test('docs: ARCHITECTURE §1.5 states the selected-pair path rule rtc.js implements (redacted remote allowed)', async () => {
  const doc = readText('docs/ARCHITECTURE.md');
  const s1 = docSection(doc, 1);
  // The strict reading that tore down healthy sessions on Chromium's placeholder must not return.
  assert.doesNotMatch(s1, /if a remote address is present and\s+not a Tailscale IP, the session is torn down/);
  assert.ok(s1.includes('`redacted-ip.invalid`'), '§1.5 must name the redacted peer-reflexive placeholder');
  assert.match(s1, /\*\*local end\*\*[^]*Tailscale IP literal/);
  const s10 = docSection(doc, 10);
  for (const fn of ['pairIsTailnet', 'describePair', 'verifyTailnetPath']) {
    assert.match(s10, new RegExp(`export (async )?function ${fn}\\(`), `§10 rtc.js block lacks ${fn}`);
    assert.match(read('src/renderer/shared/rtc.js'), new RegExp(`^export (async )?function ${fn}\\(`, 'm'));
  }
  // The documented examples behave as documented.
  const { pairIsTailnet, describePair } = await loadRtc();
  const pair = (local, remote) => ({ local: { address: local }, remote: { address: remote } });
  for (const remote of ['redacted-ip.invalid', '', 'abcd-1234.local', '100.100.1.2', 'fd7a:115c:a1e0::2']) {
    assert.equal(pairIsTailnet(pair('100.64.0.1', remote)), true, `remote ${remote}`);
  }
  for (const remote of ['100.64.0.01', 'fd7a::115c::1']) {
    assert.ok(s1.includes(`\`${remote}\``), `§1.5 example ${remote}`);
    assert.equal(pairIsTailnet(pair('100.64.0.1', remote)), false, `remote ${remote}`);
  }
  assert.equal(pairIsTailnet(pair('100.64.0.1', '192.168.1.20')), false);
  for (const local of [undefined, 'abc.local', '192.168.1.5']) {
    assert.equal(pairIsTailnet(pair(local, '100.64.0.2')), false, `local ${local}`);
  }
  // describePair local / remote: IP literals (brackets stripped) or null, never a host name.
  assert.equal(describePair(pair('[fd7a:115c:a1e0::1]', 'redacted-ip.invalid')).local, 'fd7a:115c:a1e0::1');
  assert.equal(describePair(pair('100.64.0.1', 'redacted-ip.invalid')).remote, null);
});

test('docs: ARCHITECTURE §9 speedScaleFor rule and examples match rtc.js', async () => {
  const s9 = docSection(readText('docs/ARCHITECTURE.md'), 9);
  const rtc = read('src/renderer/shared/rtc.js');
  assert.equal(srcNumber(rtc, 'SPEED_ASPECT_TOLERANCE'), 0.002);
  assert.match(s9, /\*\*0\.2 %\*\*/);
  const targets = /const SPEED_TARGETS = \[([^\]]*)\]/.exec(rtc);
  assert.ok(targets, 'no SPEED_TARGETS in rtc.js');
  assert.ok(s9.includes(targets[1].split(',').map((t) => t.trim()).join(' / ')), 'SPEED_TARGETS differ from §9');
  const { speedScaleFor } = await loadRtc();
  const examples = [...s9.matchAll(/(\d{3,4})×(\d{3,4}) → (\d{3,4})×(\d{3,4})/g)];
  assert.ok(examples.length >= 5, 'no examples found in §9');
  for (const [text, w, h, ew, eh] of examples) {
    const sc = speedScaleFor(Number(w), Number(h));
    // Rounding and truncation give the same even size.
    for (const f of [Math.floor, Math.round]) assert.equal(`${f(w / sc)}×${f(h / sc)}`, `${ew}×${eh}`, text);
  }
  assert.equal(speedScaleFor(2561, 1440), speedScaleFor(2560, 1440), 'an odd side is floored to even');
});

test('docs: ARCHITECTURE §4 TCP / connection limits use the host-server.js values', () => {
  const s4 = flat(docSection(readText('docs/ARCHITECTURE.md'), 4));
  const hs = read('src/main/host-server.js');
  const n = (name) => srcNumber(hs, name);
  const opt = (name) => {
    const m = new RegExp(`\\b${name}: ([0-9e.]+)`).exec(hs);
    assert.ok(m, `no http server option ${name}`);
    return Number(m[1]);
  };
  assert.equal(opt('headersTimeout'), opt('requestTimeout'), '§4 documents one value for both');
  const want = [
    'MAX_PREUPGRADE_PER_IP', 'PREUPGRADE_IDLE_MS', 'MAX_TCP_CONNECTIONS',
    `**${n('MAX_PREUPGRADE_PER_IP')} sockets per source IP**`,
    `idle for **${n('PREUPGRADE_IDLE_MS') / 1000} s**`,
    `**${opt('requestTimeout') / 1000} s**, checked every **${opt('connectionsCheckingInterval') / 1000} s**`,
    `\`maxConnections\` **${n('MAX_TCP_CONNECTIONS')}**`,
    `at most ${n('MAX_CONNECTIONS')} live connections in total and ${n('MAX_CONNECTIONS_PER_IP')} per source IP`,
    `at most **${n('MAX_PREACTIVE_PER_NODE')} unanswered**`,
    `when all ${n('MAX_CONNECTIONS')} are taken`,
    'oldest connection still in `hello` or `auth`',
  ];
  for (const w of want) assert.ok(s4.includes(w), `§4 lacks: ${w}`);
  assert.match(hs, /const EVICTABLE_STATES = new Set\(\['hello', 'auth'\]\)/);
  const rate = /const UPGRADE_RATE = \{ max: (\d+), windowMs: 60e3 \}/.exec(hs);
  assert.ok(rate && s4.includes(`${rate[1]} WebSocket upgrades`), 'upgrade rate limit differs from §4');
});

test('docs: ARCHITECTURE §7 viewer-client closed reasons match viewer-client.js and the viewer texts', () => {
  const s7 = docSection(readText('docs/ARCHITECTURE.md'), 7);
  const m = /reasons\n`(unreachable\|[^`]*)`/.exec(s7);
  assert.ok(m, 'no closed-reason list in §7 viewer-client');
  const listed = m[1].split('|');
  const vc = read('src/main/viewer-client.js');
  const emitted = new Set([
    ...[...vc.matchAll(/this\._(?:fail|finish)\('([a-z-]+)'/g)].map((x) => x[1]),
    ...[...vc.matchAll(/return \['([a-z-]+)'/g)].map((x) => x[1]),
  ]);
  assert.ok(emitted.has('not-tailnet-route') && emitted.has('rate-limited'), 'reason scan found too little');
  // 'local' (the viewer closed it itself) is named next to the list.
  for (const r of emitted) {
    assert.ok(listed.includes(r) || (r === 'local' && s7.includes('(and `local` when')), `viewer-client emits '${r}', §7 does not list it`);
  }
  assert.equal(require('../src/main/viewer-client').mapHttpStatus(429)[0], 'rate-limited');
  // Every listed reason (denied:<reason> aside) has its own text in the viewer.
  const reasons = read('src/renderer/viewer/reasons.js');
  for (const r of listed) {
    if (r !== 'denied:<reason>') assert.ok(reasons.includes(`case '${r}':`), `reasons.js has no case '${r}'`);
  }
  assert.ok(s7.includes('**`proofSent: boolean`**'), '§7 does not document proofSent');
  assert.match(vc, /proofSent: this\._proofSent/);
});

test('docs: ARCHITECTURE §7 files.js names the macOS probe file and the 10 s time box', () => {
  const s7 = docSection(readText('docs/ARCHITECTURE.md'), 7);
  const files = read('src/main/files.js');
  const probe = /const PROBE_PREFIX = '([^']+)';/.exec(files);
  assert.ok(probe, 'no PROBE_PREFIX in files.js');
  assert.ok(s7.includes(`\`${probe[1]}<pid>\``), `§7 does not name ${probe[1]}<pid>`);
  assert.equal(srcNumber(files, 'PREP_TIMEOUT_MS'), 10000);
  assert.ok(flat(s7).includes('preparation or the `.part` creation did not answer within 10 s'));
});

test('docs: ARCHITECTURE §8 lists exactly the settings.js DEFAULTS keys', () => {
  const { DEFAULTS } = require('../src/main/settings');
  const block = /```js\n\{\n([^]*?)\n\}\n```/.exec(docSection(readText('docs/ARCHITECTURE.md'), 8));
  assert.ok(block, 'no settings block in §8');
  const listed = [...block[1].matchAll(/^ {2}([A-Za-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), Object.keys(DEFAULTS).sort());
});

test('docs: README Troubleshooting quotes both Windows Firewall warnings that point to it', () => {
  const main = read('src/main/index.js');
  const readme = readText('README.md');
  const troubleshooting = readme.slice(readme.indexOf('## Troubleshooting'));
  for (const name of ['FIREWALL_WARNING', 'FIREWALL_BLOCK_ALL_WARNING']) {
    const m = new RegExp(`const ${name} = '((?:[^'\\\\]|\\\\.)*)';`).exec(main);
    assert.ok(m, `${name} not found in src/main/index.js`);
    const text = m[1].replace(/\\(.)/g, '$1');
    if (!/See README › Troubleshooting\.$/.test(text)) continue; // no longer points here
    const lead = text.split(/, so /)[0];
    assert.ok(troubleshooting.includes(lead), `README Troubleshooting does not quote: ${lead}`);
  }
  assert.match(troubleshooting, /Set-NetFirewallProfile -Profile Private -AllowInboundRules True/);
});

test('parseFuseConfig: comments/blank lines, stops at the next top-level key, rejects junk', () => {
  const yml = 'a: 1\nelectronFuses:  # hardening\n  # note\n\n  runAsNode: false   # x\n  onlyLoadAppFromAsar: true\npublish: null\n  runAsNode: true\n';
  assert.deepEqual(vf.parseFuseConfig(yml), { runAsNode: false, onlyLoadAppFromAsar: true });
  assert.throws(() => vf.parseFuseConfig('publish: null\n'), /no top-level electronFuses/);
  assert.throws(() => vf.parseFuseConfig('electronFuses:\n  runAsNode: no\n'), /unsupported/);
  assert.throws(() => vf.parseFuseConfig('electronFuses:\n  runAsNode: false\n  runAsNode: true\n'), /duplicate/);
});

// ---------------------------------------------------------------------------------------------
// scripts/verify-fuses.js — fuse wire + ASAR integrity readers
// ---------------------------------------------------------------------------------------------

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
function fakeBinary(states, { copies = 1 } = {}) {
  const wire = Buffer.concat([Buffer.from(SENTINEL, 'latin1'), Buffer.from([1, states.length]), Buffer.from(states, 'latin1')]);
  const parts = [crypto.randomBytes(64)];
  for (let i = 0; i < copies; i++) parts.push(wire, crypto.randomBytes(32));
  return Buffer.concat(parts);
}

test('readFuseWires/compareFuses: matching wire passes, flipped or missing fuses are reported', () => {
  const expected = vf.parseFuseConfig(BUILDER_YML);
  const good = vf.readFuseWires(fakeBinary('01001101'));
  assert.equal(good.length, 1);
  assert.equal(good[0].version, 1);
  assert.deepEqual(vf.compareFuses(expected, good[0]), []);

  const stock = vf.readFuseWires(fakeBinary('10110001'))[0]; // Electron's defaults
  const problems = vf.compareFuses(expected, stock);
  assert.equal(problems.length, 6);
  assert.ok(problems.some((p) => /^runAsNode: expected disabled, binary has enabled$/.test(p)));

  const short = vf.readFuseWires(fakeBinary('0100'))[0];
  assert.ok(vf.compareFuses(expected, short).some((p) => /onlyLoadAppFromAsar: not present/.test(p)));
  assert.deepEqual(vf.compareFuses({ bogus: true }, good[0]), ['unknown fuse "bogus"']);
});

test('readFuseWires: universal binaries carry two wires, both are checked', () => {
  const wires = vf.readFuseWires(fakeBinary('01001101', { copies: 2 }));
  assert.equal(wires.length, 2);
  assert.deepEqual(vf.readFuseWires(crypto.randomBytes(256).fill(0x20)), []);
});

/** Minimal asar: [u32 4][u32 headerPickleSize][u32 payload][i32 len][json, 4-byte padded] + data. */
function fakeAsar(headerJson) {
  const str = Buffer.from(headerJson, 'utf8');
  const padded = Buffer.alloc(Math.ceil(str.length / 4) * 4);
  str.copy(padded);
  const headerPickle = Buffer.alloc(8 + padded.length);
  headerPickle.writeUInt32LE(4 + padded.length, 0);
  headerPickle.writeInt32LE(str.length, 4);
  padded.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, Buffer.from('file data')]);
}

test('asarHeaderHash: SHA-256 of the JSON header string (what Electron validates)', () => {
  const json = '{"files":{"package.json":{"size":9,"offset":"0","integrity":{"algorithm":"SHA256"}}}}';
  const want = crypto.createHash('sha256').update(json).digest('hex');
  assert.equal(vf.asarHeaderHash(fakeAsar(json)), want);
  assert.throws(() => vf.asarHeaderHash(Buffer.alloc(8)), /too short/);
  const bad = fakeAsar(json);
  bad.writeInt32LE(1 << 30, 12);
  assert.throws(() => vf.asarHeaderHash(bad), /corrupt/);
});

test('findWinIntegrity: locates the INTEGRITY/ELECTRONASAR JSON inside an exe image', () => {
  const hash = 'a'.repeat(64);
  const json = JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: hash }]);
  const exe = Buffer.concat([Buffer.from('MZ junk [{"file": not json ] more'), Buffer.from(json, 'utf8'), crypto.randomBytes(16)]);
  assert.deepEqual(vf.findWinIntegrity(exe), [{ file: 'resources/app.asar', algorithm: 'SHA256', hash }]);
  assert.equal(vf.findWinIntegrity(Buffer.from('MZ nothing here')), null);
});

test('findMacIntegrity: reads ElectronAsarIntegrity from an XML Info.plist', () => {
  const hash = 'b'.repeat(64);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>CFBundleName</key>
    <string>Tunnelview</string>
    <key>ElectronAsarIntegrity</key>
    <dict>
      <key>Resources/app.asar</key>
      <dict>
        <key>algorithm</key>
        <string>SHA256</string>
        <key>hash</key>
        <string>${hash}</string>
      </dict>
    </dict>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
  </dict>
</plist>`;
  assert.deepEqual(vf.findMacIntegrity(plist), [{ file: 'Resources/app.asar', algorithm: 'SHA256', hash }]);
  assert.equal(vf.findMacIntegrity('<plist><dict></dict></plist>'), null);
});

test('appLayout: fuse binary and asar locations per platform', () => {
  const mac = vf.appLayout(path.join('dist', 'mac-arm64', 'Tunnelview.app'));
  assert.equal(mac.platform, 'mac');
  assert.match(mac.fuseBinary.split(path.sep).join('/'), /Tunnelview\.app\/Contents\/Frameworks\/Electron Framework\.framework\/Electron Framework$/);
  assert.equal(mac.asarKey, 'Resources/app.asar');
  const win = vf.appLayout(path.join('dist', 'win-unpacked', 'Tunnelview.exe'));
  assert.equal(win.platform, 'win');
  assert.match(win.asar.split(path.sep).join('/'), /win-unpacked\/resources\/app\.asar$/);
});

// ---------------------------------------------------------------------------------------------
// build/installer.nsh — Windows Firewall rules and uninstall cleanup
// ---------------------------------------------------------------------------------------------

const define = (name) => {
  const m = new RegExp(`!define ${name} "([^"]*)"`).exec(NSH);
  assert.ok(m, `missing !define ${name}`);
  return m[1];
};
const macro = (name) => {
  const m = new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(NSH);
  assert.ok(m, `missing macro ${name}`);
  return m[1];
};
const addRules = () => [...macro('customInstall').matchAll(/advfirewall firewall add rule ([^']*)'/g)].map((m) => m[1]);
const ruleFor = (defineName) => {
  const r = addRules().find((a) => a.startsWith(`name="\${${defineName}}"`));
  assert.ok(r, `no add rule for ${defineName}`);
  return r;
};

test('installer: the TCP signaling rule covers any port, only for Tunnelview.exe and tailnet ranges', () => {
  assert.equal(define('TUNNELVIEW_FW_RULE_TCP'), 'Tunnelview (Tailscale only) - TCP signaling');
  const tcp = ruleFor('TUNNELVIEW_FW_RULE_TCP');
  assert.match(tcp, /\bdir=in action=allow\b/);
  assert.match(tcp, /\bprotocol=TCP\b/);
  assert.doesNotMatch(tcp, /localport=/);
  assert.match(tcp, /program="\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/);
  assert.match(tcp, /remoteip=\$\{TUNNELVIEW_FW_REMOTE\}/);
});

test('installer: every rule is program- and Tailscale-scoped; the UDP allow rule is unchanged', () => {
  assert.equal(define('TUNNELVIEW_FW_REMOTE'), '100.64.0.0/10,fd7a:115c:a1e0::/48');
  const rules = addRules();
  assert.equal(rules.length, 3);
  for (const r of rules) {
    assert.match(r, /program="\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/);
    assert.match(r, /remoteip=\$\{TUNNELVIEW_FW_REMOTE\}/);
    assert.match(r, /\bprofile=any\b/);
  }
  const udp = ruleFor('TUNNELVIEW_FW_RULE_UDP');
  assert.match(udp, /\bdir=in action=allow\b.*\bprotocol=UDP localport=47801-47899\b/);
});

test('installer: outbound UDP toward the tailnet is blocked on wireless adapters only', () => {
  assert.equal(define('TUNNELVIEW_FW_RULE_WIFI_BLOCK'), 'Tunnelview - no tailnet UDP via Wi-Fi');
  const block = ruleFor('TUNNELVIEW_FW_RULE_WIFI_BLOCK');
  assert.match(block, /\bdir=out action=block enable=yes profile=any\b/);
  assert.match(block, /\bprotocol=UDP localport=47801-47899\b/);
  assert.match(block, /\binterfacetype=wireless\b/);
  assert.doesNotMatch(NSH.replace(/^\s*;.*$/gm, ''), /interfacetype=ras/);
});

test('installer: every rule name is deleted on install and uninstall', () => {
  const del = macro('_tunnelviewDeleteFirewallRules');
  for (const name of ['TUNNELVIEW_FW_RULE_TCP', 'TUNNELVIEW_FW_RULE_UDP', 'TUNNELVIEW_FW_RULE_WIFI_BLOCK']) {
    assert.ok(del.includes(`delete rule name="\${${name}}"`), `${name} not deleted`);
  }
  assert.match(macro('customInstall'), /!insertmacro _tunnelviewDeleteFirewallRules/);
  assert.match(macro('customUnInstall'), /!insertmacro _tunnelviewDeleteFirewallRules/);
});

test('installer: a real uninstall (not an upgrade) removes the login item and its StartupApproved entry', () => {
  const un = macro('customUnInstall');
  const guarded = /\$\{ifNot\} \$\{isUpdated\}([\s\S]*?)\$\{endIf\}/.exec(un);
  assert.ok(guarded, 'cleanup must be guarded by ${ifNot} ${isUpdated}');
  assert.match(guarded[1], /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{TUNNELVIEW_RUN_VALUE\}"/);
  assert.match(guarded[1], /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "\$\{TUNNELVIEW_RUN_VALUE\}"/);
});

test('installer: the Run value name is the AppUserModelId Electron uses for setLoginItemSettings', () => {
  const runValue = define('TUNNELVIEW_RUN_VALUE');
  assert.equal(runValue, /^appId: (\S+)\s*$/m.exec(BUILDER_YML)[1]);
  const main = read('src/main/index.js');
  const aumid = /setAppUserModelId\(\s*['"]([^'"]+)['"]\s*\)/.exec(main);
  if (aumid) assert.equal(aumid[1], runValue);
  // A custom `name:` would change the registry value name the uninstaller must delete.
  for (const call of main.matchAll(/setLoginItemSettings\(\s*\{([^}]*)\}/g)) {
    assert.doesNotMatch(call[1], /\bname\s*:/);
  }
});

// ---------------------------------------------------------------------------------------------
// .github/workflows/build.yml — the signed update manifest (job update-manifest) and the release
// ---------------------------------------------------------------------------------------------

const WORKFLOW = readText('.github/workflows/build.yml');
const TAG_GATE = "startsWith(github.ref, 'refs/tags/v')";

/** Each job of the workflow as text: { id → the lines under `  <id>:` up to the next job }. */
function workflowJobs(yml) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'no jobs: in build.yml');
  const jobs = {};
  let id = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break; // the next top-level key
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) { id = m[1]; jobs[id] = []; continue; }
    if (id) jobs[id].push(l);
  }
  for (const k of Object.keys(jobs)) jobs[k] = jobs[k].join('\n');
  return jobs;
}

/** A job-level `key: value` (4-space indent), or null. */
function jobKey(job, key) {
  const m = new RegExp(`^ {4}${key}:[ \\t]*(.*)$`, 'm').exec(job);
  return m ? m[1].trim() : null;
}

/** The job's job-level `needs:` as a sorted list (flow `[a, b]` or a single name). */
function jobNeeds(job) {
  const v = jobKey(job, 'needs');
  if (!v) return [];
  const list = /^\[(.*)\]$/.exec(v);
  return (list ? list[1].split(',') : [v]).map((s) => s.trim()).filter(Boolean).sort();
}

/** The lines of a block-mapping key at `indent` (e.g. permissions:), as {k: v}. */
function jobMapping(job, key, indent = 4) {
  const lines = job.split('\n');
  const i = lines.findIndex((l) => l === `${' '.repeat(indent)}${key}:`);
  assert.ok(i >= 0, `no ${key}: block`);
  const out = {};
  for (const l of lines.slice(i + 1)) {
    if (/^\s*(#.*)?$/.test(l)) continue;
    const m = new RegExp(`^ {${indent + 2}}([A-Za-z0-9_-]+):\\s*(.*)$`).exec(l);
    if (!m) break;
    out[m[1]] = m[2];
  }
  return out;
}

/** The text without YAML comments (whole-line ones and ` # …` after a value). */
const withoutComments = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');

const JOBS = workflowJobs(WORKFLOW);

test('build.yml: update-manifest signs only for v* tags, in environment release, after both builds', () => {
  const job = JOBS['update-manifest'];
  assert.ok(job, 'no update-manifest job');
  assert.equal(jobKey(job, 'if'), TAG_GATE);
  assert.equal(jobKey(job, 'environment'), 'release');
  assert.deepEqual(jobNeeds(job), ['macos', 'windows']);
  assert.deepEqual(jobMapping(job, 'permissions'), { contents: 'read' });
  // The workflow default stays read-only too: only the release job may write.
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read\n/m);
});

test('build.yml: update-manifest runs no npm install or project dependency', () => {
  const code = withoutComments(JOBS['update-manifest']);
  assert.doesNotMatch(code, /\b(npm|npx|yarn|pnpm|corepack)\b/);
  assert.doesNotMatch(code, /node_modules/);
  assert.doesNotMatch(code, /^\s+cache(-dependency-path)?:/m, 'setup-node must not restore a cache');
  assert.match(code, /^\s+node-version: 22$/m);
  assert.match(code, /^\s+node scripts\/sign-update\.js "\$@"$/m);
  // The checkout token is not left in .git/config for the steps that follow.
  assert.match(code, /- uses: actions\/checkout@[0-9a-f]{40}\n\s+with:\n\s+persist-credentials: false\n/);
});

test('build.yml: every action in update-manifest is pinned to a full commit SHA, its tag as the comment', () => {
  const job = JOBS['update-manifest'];
  const uses = [...job.matchAll(/^\s+(?:- )?uses: (.*)$/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 4, 'too few actions found');
  const pinned = {};
  for (const u of uses) {
    const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+(?:\.\d+){0,2})$/.exec(u);
    assert.ok(m, `not pinned to a 40-hex commit SHA with a # vN comment: ${u}`);
    pinned[m[1]] = { sha: m[2], tag: m[3] };
  }
  assert.deepEqual(Object.keys(pinned).sort(), ['actions/checkout', 'actions/download-artifact', 'actions/setup-node', 'actions/upload-artifact']);
  // The comment names the same tag the other jobs use for that action (one version per action).
  for (const [action, { tag }] of Object.entries(pinned)) {
    for (const m of WORKFLOW.matchAll(new RegExp(`uses: ${action.replace('/', '\\/')}@(v[\\d.]+)\\s*$`, 'gm'))) {
      assert.equal(m[1], tag, `${action}: pinned as ${tag}, used elsewhere as ${m[1]}`);
    }
  }
});

test('build.yml: the signing key reaches the sign step only; --pub is vars.UPDATE_PUBLIC_KEY; version from the tag', () => {
  const job = JOBS['update-manifest'];
  assert.equal(WORKFLOW.split('secrets.UPDATE_SIGNING_KEY').length - 1, 1, 'UPDATE_SIGNING_KEY must appear once in build.yml');
  assert.deepEqual([...job.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]), ['UPDATE_SIGNING_KEY']);
  // Step-level env (10 spaces), not job- or workflow-level.
  assert.match(job, /^ {10}UPDATE_SIGNING_KEY: \$\{\{ secrets\.UPDATE_SIGNING_KEY \}\}$/m);
  assert.match(job, /^ {10}UPDATE_PUBLIC_KEY: \$\{\{ vars\.UPDATE_PUBLIC_KEY \}\}$/m);
  assert.equal(jobKey(job, 'env'), null, 'no job-level env');
  const code = withoutComments(job);
  assert.match(code, /--pub "\$UPDATE_PUBLIC_KEY"/);
  assert.match(code, /version="\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(code, /--version "\$version" --dir assets/);
  assert.match(code, /--notes-file "\$notes"/);
  // The existing tag / package.json check stays in both builds (and the signing job repeats it).
  for (const id of ['windows', 'macos', 'update-manifest']) {
    assert.ok(JOBS[id].includes('- name: Release tag matches package.json version'), `${id} lost the tag/version check`);
  }
});

test('build.yml: release tags must be exactly vX.Y.Z (a pre-release tag would sign a manifest no updater accepts)', () => {
  const { validVersion } = require('../src/main/update-manifest');
  for (const id of ['windows', 'macos', 'update-manifest']) {
    const job = JOBS[id];
    const at = job.indexOf('- name: Release tag matches package.json version');
    assert.ok(at >= 0, `${id} lost the tag/version check`);
    const end = job.indexOf('\n\n', at);
    const step = job.slice(at, end < 0 ? undefined : end);
    const re = /^ +re='([^']+)'$/m.exec(step);
    assert.ok(re, `${id}: no tag pattern`);
    assert.match(step, /\[\[ "\$GITHUB_REF_NAME" =~ \$re \]\] \|\| \{ echo "::error::[^"]*"; exit 1; \}/, `${id}: the pattern must stop the job`);
    assert.ok(step.indexOf('=~ $re') < step.indexOf('want='), `${id}: the pattern is checked first`);
    // POSIX ERE; for this pattern JavaScript reads it the same way.
    const tag = new RegExp(re[1]);
    for (const ok of ['v0.4.0', 'v1.0.0', 'v10.20.30']) {
      assert.ok(tag.test(ok), `${id} refuses ${ok}`);
      assert.ok(validVersion(ok.slice(1)), `${ok} is not a manifest version`);
    }
    for (const bad of ['v0.4.0-beta.1', 'v0.4.0-rc1', 'v1.2.3+build', 'v01.2.3', 'v1.02.3', 'v1.2', 'v1.2.3.4', '0.4.0', 'vx.y.z']) {
      assert.equal(tag.test(bad), false, `${id} accepts ${bad}`);
    }
  }
});

test('build.yml: the manifest is uploaded, and release needs update-manifest and checks it before publishing', () => {
  const { MANIFEST_NAME } = require('../src/main/update-manifest');
  const job = JOBS['update-manifest'];
  assert.match(job, new RegExp(`^\\s+path: assets/${MANIFEST_NAME.replace('.', '\\.')}\\n\\s+if-no-files-found: error$`, 'm'));
  const rel = JOBS.release;
  assert.ok(rel, 'no release job');
  assert.equal(jobKey(rel, 'if'), TAG_GATE);
  assert.deepEqual(jobNeeds(rel), ['macos', 'update-manifest', 'windows']);
  const check = rel.indexOf(`test -s artifacts/${MANIFEST_NAME}`);
  assert.ok(check >= 0, 'release does not check that the manifest is there');
  assert.ok(rel.indexOf('sha256sum --check') > check, 'release does not check the assets against the manifest');
  assert.ok(rel.indexOf('gh release') > rel.indexOf('sha256sum --check'), 'the checks must run before publishing');
  // The signing job is the only one with an environment (the release job holds no secret).
  for (const [id, j] of Object.entries(JOBS)) {
    if (id !== 'update-manifest') assert.equal(jobKey(j, 'environment'), null, `${id} has an environment`);
  }
});

test('build.yml: the macos job checks each update zip the way updater.js installs it, before the upload (MACFLOW-3)', () => {
  const u = require('../src/main/updater');
  const m = require('../src/main/update-manifest');
  const job = JOBS.macos;
  const at = job.indexOf('- name: Verify the update zips the way the updater installs them');
  assert.ok(at >= 0, 'no zip check in the macos job');
  assert.ok(at > job.indexOf('- name: Build dmg + zip'), 'after the build');
  assert.ok(at < job.indexOf('actions/upload-artifact'), 'before the upload (update-manifest and release need this job)');
  const step = withoutComments(job.slice(at, job.indexOf('\n\n', at)));
  // The same names sign-update.js hashes, for both Mac platform keys.
  assert.equal(m.assetName('darwin-arm64', '9.9.9'), 'Tunnelview-9.9.9-mac-arm64.zip');
  assert.equal(m.assetName('darwin-x64', '9.9.9'), 'Tunnelview-9.9.9-mac-x64.zip');
  assert.ok(step.includes('zip="dist/Tunnelview-${want}-mac-${a}.zip"'));
  assert.ok(step.includes('for pair in arm64:arm64 x64:x86_64; do'));
  for (const w of [
    'ditto -x -k --noqtn "$zip" "$tmp"',
    '[ "$(ls -A "$tmp")" = "Tunnelview.app" ]',
    `plutil -extract CFBundleIdentifier raw -o - "$plist")" = "${u.APP_ID}" ]`,
    'plutil -extract CFBundleShortVersionString raw -o - "$plist")" = "$want" ]',
    'plutil -extract CFBundleExecutable raw -o - "$plist")" = "Tunnelview" ]',
    'lipo -archs "$app/Contents/MacOS/Tunnelview"',
    'codesign --verify --deep --strict --verbose=2 "$app"',
  ]) assert.ok(step.includes(w), `zip check lacks: ${w}`);
  // The updater runs the same tools with the same arguments.
  const src = read('src/main/updater.js');
  assert.ok(src.includes("['-x', '-k', '--noqtn', d.file, xdir]"));
  assert.ok(src.includes("['--verify', '--deep', '--strict', '--verbose=2', app]"));
});

test('build.yml: parsed with js-yaml, update-manifest and release have the same shape', (t) => {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return t.skip('js-yaml not installed'); }
  const wf = yaml.load(WORKFLOW);
  const job = wf.jobs['update-manifest'];
  assert.equal(job.if, TAG_GATE);
  assert.equal(job.environment, 'release');
  assert.deepEqual([...job.needs].sort(), ['macos', 'windows']);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.env, undefined);
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    if (step.run) assert.doesNotMatch(step.run, /\b(npm|npx|yarn|pnpm)\b/);
    if (step.uses && step.uses.startsWith('actions/setup-node@')) assert.equal(step.with.cache, undefined);
    if (step.uses && step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
    const env = step.env || {};
    if (!step.run || !step.run.includes('scripts/sign-update.js')) assert.equal('UPDATE_SIGNING_KEY' in env, false);
  }
  assert.ok(job.steps.some((s) => s.env && s.env.UPDATE_SIGNING_KEY === '${{ secrets.UPDATE_SIGNING_KEY }}'));
  assert.ok(wf.jobs.release.needs.includes('update-manifest'));
  assert.equal(wf.jobs.release.if, TAG_GATE);
});

// ---------------------------------------------------------------------------------------------
// docs ↔ updater: ARCHITECTURE / README state what updater.js, update-manifest.js and
// update-keys.js do
// ---------------------------------------------------------------------------------------------

/** Backticked host names in a text (`github.com`), not file names such as `update-keys.js`. */
const docHosts = (text) => new Set([...text.matchAll(/`([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io))`/g)].map((m) => m[1]));

/** The `- **<label>**` bullet of a section, up to the next bullet at the same indent. */
function docBullet(section, label) {
  const start = section.indexOf(`- **${label}**`);
  assert.ok(start >= 0, `no bullet **${label}**`);
  const rest = section.slice(start + 2);
  const end = rest.search(/\n- /);
  return end < 0 ? rest : rest.slice(0, end);
}

test('docs: ARCHITECTURE states the manifest URL, the asset URL and the redirect hosts as updater.js has them', () => {
  const u = require('../src/main/updater');
  const doc = readText('docs/ARCHITECTURE.md');
  const s1 = docSection(doc, 1);
  const item10 = s1.slice(s1.search(/^10\. \*\*/m));
  assert.ok(item10.startsWith('10. **The updater is the single path outside the tailnet**'), '§1 has no item 10 for the updater');
  const s7 = docSection(doc, 7);
  for (const [name, text] of [['§1.10', item10], ['§7', s7]]) {
    assert.ok(text.includes(u.MANIFEST_URL), `${name} does not state MANIFEST_URL`);
  }
  assert.deepEqual([...docHosts(item10)].sort(), [...u.ALLOWED_HOSTS].sort(), '§1.10 hosts');
  const redirects = docBullet(s7, 'Redirects:');
  assert.deepEqual([...docHosts(redirects)].sort(), [...u.ALLOWED_HOSTS].sort(), '§7 redirect allow-list');
  assert.ok(flat(redirects).includes(`at most ${u.MAX_REDIRECTS} (\`MAX_REDIRECTS\`)`), 'MAX_REDIRECTS');
  // No other GitHub content host is named anywhere.
  for (const m of doc.matchAll(/[a-z0-9.-]+\.githubusercontent\.com/g)) assert.ok(u.ALLOWED_HOSTS.includes(m[0]), `${m[0]} is not allowed by updater.js`);
  // The allow-list itself: https only, those hosts only, no port, no user info.
  assert.ok(u.allowedUrl('https://objects.githubusercontent.com/x'));
  for (const bad of ['http://github.com/x', 'https://github.com:8443/x', 'https://a@github.com/x', 'https://evil.example/x', 'https://github.com.evil.example/x']) {
    assert.equal(u.allowedUrl(bad), null, bad);
  }
  const asset = u.assetUrl('win32-x64', '9.9.9', 'Tunnelview-Setup-9.9.9-x64.exe');
  assert.ok(s7.includes(asset.replace('v9.9.9/Tunnelview-Setup-9.9.9-x64.exe', 'v<version>/<name>')), 'asset URL pattern');
  assert.ok(docSection(doc, 6).includes(u.RELEASES_URL), '§6 update:open-releases URL');
});

test('docs: ARCHITECTURE names every embedded update key and its kid as update-keys.js has them', () => {
  const { KEYS } = require('../src/main/update-keys');
  const m = require('../src/main/update-manifest');
  const s7 = docSection(readText('docs/ARCHITECTURE.md'), 7);
  assert.ok(KEYS.length >= 1);
  for (const k of KEYS) {
    assert.equal(m.keyId(m.decodeB64url(k.publicKey, 32)), k.kid, `kid of ${k.publicKey}`);
    assert.ok(s7.includes(`\`${k.publicKey}\``), `§7 does not name the key ${k.publicKey}`);
    assert.ok(flat(s7).includes(`\`${k.publicKey}\` (raw, base64url without padding), kid \`${k.kid}\``), `§7 does not name kid ${k.kid} with its key`);
  }
  // The documented derivation command gives the documented kid.
  const cmd = /`node -e "([^"]+)" <publicKey>`/.exec(s7);
  assert.ok(cmd, 'no kid derivation command in §7');
  const derive = Function('process', 'require', 'console', cmd[1]);
  for (const k of KEYS) {
    let out = '';
    derive({ argv: ['node', k.publicKey] }, require, { log: (s) => { out = s; } });
    assert.equal(out, k.kid);
  }
});

test('docs: ARCHITECTURE updater numbers, asset names, codes and helper outcomes match the code', () => {
  const u = require('../src/main/updater');
  const m = require('../src/main/update-manifest');
  const src = read('src/main/updater.js');
  const doc = readText('docs/ARCHITECTURE.md');
  const s7 = flat(docSection(doc, 7));
  const s1 = flat(docSection(doc, 1));
  const h = (ms) => ms / 3600000;
  const want = [
    `At most **${m.MAX_MANIFEST_BYTES / 1024} KiB**`,
    `**${srcNumber(src, 'CHECK_DEADLINE_MS') / 1000} s** for the whole check`,
    `${srcNumber(src, 'SOCKET_IDLE_MS') / 1000} s socket idle timeout`,
    `the first check comes ${u.FIRST_CHECK_DELAY_MS / 1000} s after start, then one every ${h(u.CHECK_INTERVAL_MS)} h`,
    `A restart within ${h(u.CHECK_INTERVAL_MS)} h of it waits, and a value more than ${h(u.CHECK_INTERVAL_MS)} h in the future`,
    `It is tried again after ${h(u.RETRY_AFTER_FAILURE_MS)} h`,
    `moves by ${srcNumber(src, 'BUSY_RETRY_MS') / 60000} min`,
    `\`size\` is an integer from 1 to ${m.MAX_ASSET_BYTES / 1048576} MiB`,
    `at most ${m.MAX_NOTES_LENGTH} UTF-16 code units`,
    `for about ${(srcNumber(src, 'LOCK_RETRIES') * srcNumber(src, 'LOCK_RETRY_MS')) / 1000} s`,
    '/S --updated --force-run',
    `\`${u.APP_ID}\``,
  ];
  for (const w of want) assert.ok(s7.includes(w), `§7 updater lacks: ${w}`);
  assert.ok(s1.includes(`first check comes ${u.FIRST_CHECK_DELAY_MS / 1000} s after start, and none within ${h(u.CHECK_INTERVAL_MS)} h`), '§1.10 schedule');
  assert.match(src, /\[staged, '\/S', '--updated', '--force-run'\]/);
  // The helper's wait: <n> polls of <s> seconds.
  const polls = /-ge (\d+) \]/.exec(u.MAC_SWAP_SCRIPT);
  const nap = /\/bin\/sleep ([\d.]+)\n/.exec(u.MAC_SWAP_SCRIPT);
  assert.ok(polls && nap, 'helper wait loop');
  assert.ok(s7.includes(`at most ${Math.round(Number(polls[1]) * Number(nap[1]))} s, else \`timeout\``), 'helper wait');
  // Asset names, one table row per platform key.
  for (const key of m.PLATFORM_KEYS) {
    const row = `| \`${key}\` | \`${m.assetName(key, '9.9.9').replace('9.9.9', '<v>')}\` |`;
    assert.ok(s7.includes(row), `§7 lacks the asset row ${row}`);
  }
  // The error-code table lists exactly the codes updater.js has messages for.
  const raw7 = docSection(doc, 7);
  const heading = raw7.indexOf('**Error codes**');
  assert.ok(heading >= 0, 'no error-code table in §7');
  const table = raw7.slice(raw7.indexOf('\n| Group |', heading) + 1);
  const rows = table.slice(0, table.search(/\n\n/)).split('\n').filter((l) => /^\| [a-zA-Z]/.test(l) && !l.startsWith('| Group'));
  assert.ok(rows.length >= 5, 'error-code table rows');
  const listed = rows.flatMap((r) => [...r.split('|')[2].matchAll(/`([A-Z_]+)`/g)].map((x) => x[1]));
  assert.deepEqual([...listed].sort(), Object.keys(u.MESSAGES).sort());
  // Every outcome word the macOS helper can write.
  const words = new Set([...u.MAC_SWAP_SCRIPT.matchAll(/\bsay ([a-z-]+)/g)].map((x) => x[1]));
  assert.ok(words.size >= 7);
  const at = raw7.indexOf("- `install-result` holds the macOS helper's outcome:");
  assert.ok(at >= 0, 'no install-result bullet in §7');
  const outcome = raw7.slice(at + 2, at + 2 + raw7.slice(at + 2).search(/\n- /));
  const documented = [...outcome.matchAll(/`([a-z-]+)`/g)].map((x) => x[1]).filter((w) => w !== 'install-result');
  assert.deepEqual([...documented].sort(), [...words].sort(), '§7 helper outcomes');
  // pending.json keys, as written by both installs.
  const keys = new Set(['v']);
  for (const call of src.matchAll(/_writePending\(\{([^}]*)\}\)/g)) {
    for (const part of call[1].split(',')) keys.add(part.split(':')[0].trim());
  }
  for (const s of [raw7, docSection(doc, 8)]) {
    const doc8 = /`pending\.json` = `\{([^}]*)\}`|`pending\.json` \(`\{([^}]*)\}`\)/.exec(s);
    assert.ok(doc8, 'no pending.json shape');
    const documented = new Set((doc8[1] || doc8[2]).split(/[,|]/).map((p) => p.split(':')[0].trim()));
    assert.deepEqual([...documented].sort(), [...keys].sort(), 'pending.json keys');
  }
});

test('docs: the updater sends exactly the headers ARCHITECTURE documents (fake transport, no network)', async () => {
  const { createUpdater, MANIFEST_URL } = require('../src/main/updater');
  const seen = [];
  const updater = createUpdater({
    appVersion: '1.2.3',
    isPackaged: false,
    platform: 'win32',
    arch: 'x64',
    userData: 'C:\\tunnelview-docs-test',
    settings: { get: () => ({ autoUpdateCheck: false, lastUpdateCheckAt: null }), update: () => {} },
    transport: {
      get: async (url, opts) => {
        seen.push({ url, headers: opts.headers });
        return { statusCode: 404, headers: {}, destroy() {} };
      },
    },
    log: { log() {}, warn() {}, error() {} },
  });
  const state = await updater.check();
  updater.dispose();
  assert.equal(state.error && state.error.code, 'NO_MANIFEST');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, MANIFEST_URL);
  assert.deepEqual(seen[0].headers, { 'User-Agent': 'Tunnelview-Updater/1.2.3', Accept: 'application/octet-stream' });
  const doc = readText('docs/ARCHITECTURE.md');
  for (const n of [1, 7]) {
    const s = flat(docSection(doc, n));
    for (const [k, v] of Object.entries(seen[0].headers)) {
      const line = `\`${k}: ${v.replace('1.2.3', '<version>')}\``;
      assert.ok(s.includes(line), `§${n} does not state the header ${line}`);
    }
  }
  assert.ok(readText('README.md').includes('`Tunnelview-Updater/<version>`'), 'README names the user agent');
});

test('docs: ARCHITECTURE §6 lists every update:* channel ipc.js handles, with its preload function', () => {
  const s6 = docSection(readText('docs/ARCHITECTURE.md'), 6);
  const channels = [...read('src/main/ipc.js').matchAll(/handle\('(update:[a-z-]+)'/g)].map((x) => x[1]);
  assert.ok(channels.length >= 7, 'update:* handlers not found in ipc.js');
  const preload = read('src/preload/main.js');
  for (const ch of channels) {
    const fn = new RegExp(`(\\w+): \\([^)]*\\) => ipcRenderer\\.invoke\\('${ch}'`).exec(preload);
    assert.ok(fn, `preload/main.js has no function for ${ch}`);
    assert.ok(s6.includes(`| \`${ch}\` | \`${fn[1]}(`), `§6 lacks the row ${ch} / ${fn[1]}()`);
  }
  assert.match(preload, /onUpdateState: \(cb\) => on\('update:state', cb\)/);
  assert.ok(s6.includes('| `update:state` (main → renderer) | `onUpdateState(cb)` |'), '§6 lacks update:state');
  // The locked keys of settings:update are the ones ipc.js locks.
  const locked = /const LOCKED_SETTING_KEYS = \[([^\]]*)\]/.exec(read('src/main/ipc.js'));
  assert.ok(locked, 'no LOCKED_SETTING_KEYS');
  const row = s6.split('\n').find((l) => l.startsWith('| `settings:update` |'));
  assert.ok(row, 'no settings:update row');
  for (const k of [...locked[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1])) assert.ok(row.includes(`\`${k}\``), `settings:update row lacks ${k}`);
});

test('docs: ARCHITECTURE §2 names every main-process module and every script', () => {
  const s2 = docSection(readText('docs/ARCHITECTURE.md'), 2);
  for (const f of fs.readdirSync(path.join(root, 'src', 'main')).filter((n) => n.endsWith('.js'))) {
    assert.match(s2, new RegExp(`^ {2}${f.replace('.', '\\.')}\\s`, 'm'), `§2 does not list src/main/${f}`);
  }
  for (const f of fs.readdirSync(path.join(root, 'scripts'))) {
    assert.ok(s2.includes(`scripts/${f}`), `§2 does not list scripts/${f}`);
  }
});

test('docs: README Updating replaces "does not update itself" and describes the signed, opt-out check', () => {
  const readme = readText('README.md');
  assert.doesNotMatch(readme, /Tunnelview does not update itself/);
  const start = readme.indexOf('\n## Updating\n');
  assert.ok(start >= 0, 'no ## Updating section');
  const rest = readme.slice(start + 1);
  const section = rest.slice(0, rest.slice(3).search(/\n## /) + 3);
  assert.ok(readme.includes('- [Updating](#updating)'), 'Contents lacks Updating');
  for (const w of ['tunnelview-update.json', 'Ed25519', 'only connection outside your tailnet', 'UAC', 'Screen Recording and Accessibility', '0.2.x', 'Obtainium']) {
    assert.ok(section.includes(w), `README Updating lacks: ${w}`);
  }
  // The Android signing certificate, in both spellings.
  const colon = /^((?:[0-9A-F]{2}:){31}[0-9A-F]{2})$/m.exec(section);
  assert.ok(colon, 'no colon-separated SHA-256 certificate fingerprint');
  assert.ok(section.includes(`\`${colon[1].replace(/:/g, '').toLowerCase()}\``), 'the apksigner spelling differs');
});

test('docs: README states what the updater and the phone pairing really do (DOCS-1 to DOCS-8, DOCS-11)', () => {
  const u = require('../src/main/updater');
  const readme = readText('README.md');
  const sectionOf = (heading) => {
    const start = readme.indexOf(`\n${heading}\n`);
    assert.ok(start >= 0, `no ${heading}`);
    const rest = readme.slice(start + 1);
    const level = heading.split(' ')[0];
    const end = rest.slice(heading.length).search(new RegExp(`\\n#{2,${level.length}} `));
    return flat(end < 0 ? rest : rest.slice(0, end + heading.length));
  };
  const updating = sectionOf('## Updating');
  const trouble = sectionOf('## Troubleshooting');
  const ports = sectionOf('## Ports and firewalls');
  const row = (lead) => {
    const line = readme.split('\n').find((l) => l.startsWith(`| ${lead}`));
    assert.ok(line, `no Troubleshooting row ${lead}`);
    return line;
  };
  // DOCS-1: pairing a phone, the ID, Reset identity, the locked list, the project layout.
  const pair = sectionOf('### Pair a phone');
  for (const w of ['**Pair a phone**', '2 minutes', 'Pair only if both match', 'Three wrong attempts', 'does **not** let anyone in', '**Reset identity…**']) {
    assert.ok(pair.includes(w), `Pair a phone lacks: ${w}`);
  }
  assert.ok(flat(readme).includes('**Reset identity…** and **Pair a phone** are refused too'), 'locked list');
  const layout = sectionOf('## Project layout');
  for (const f of ['identity.js', 'pairing.js', 'qr.js', 'make-mobile-fixtures.js']) assert.ok(layout.includes(f), `Project layout lacks ${f}`);
  // DOCS-2: every host the check and the download reach, on TCP 443.
  for (const host of u.ALLOWED_HOSTS) {
    assert.ok(updating.includes(`\`${host}\``), `Updating lacks ${host}`);
    assert.ok(row('Checking for updates fails').includes(`\`${host}\``), `Troubleshooting lacks ${host}`);
    assert.ok(ports.includes(`\`${host}\``), `Ports and firewalls lacks ${host}`);
  }
  assert.ok(updating.includes('TCP 443') && ports.includes('TCP 443'));
  // DOCS-3: GitHub sees the public IP, not only the user agent.
  assert.doesNotMatch(flat(readme), /only identifying detail/);
  assert.ok(updating.includes('shows GitHub your public IP address'));
  // DOCS-4: on by default, first check about a minute after start, the opt-out before the first start.
  assert.ok(updating.includes('**on by default**') && updating.includes('about a minute after Tunnelview starts'));
  assert.ok(updating.includes('`"autoUpdateCheck": false`'));
  assert.equal(u.FIRST_CHECK_DELAY_MS, 60 * 1000);
  // DOCS-5: a session refuses the install; nothing installs by itself later.
  assert.doesNotMatch(flat(readme), /Installing waits while/);
  assert.ok(updating.includes('You cannot install while someone is connected') && updating.includes('it does not install by itself'));
  // DOCS-6: busy vs updating.
  assert.match(row('*… is updating*'), /administrator \(UAC\) prompt/);
  assert.ok(read('src/renderer/viewer/reasons.js').includes("case 'host-updating':"));
  // DOCS-7: the step that brings Restart and install back after App Management.
  assert.ok(row('Mac: *macOS did not let Tunnelview replace itself*').includes('click **Check now**'));
  assert.ok(updating.includes('then click **Check now** in Settings › Updates'));
  // DOCS-8: a standard Mac account uses ~/Applications.
  assert.ok(updating.includes('On a standard account, use the Applications folder in your home folder (`~/Applications`)'));
  // DOCS-11: where the identity files are, restore + Retry before Reset identity.
  const id = row('Settings › Security: *This computer can\'t prove its identity');
  for (const w of ['`%LOCALAPPDATA%\\Tunnelview`', '`~/Library/Application Support/Tunnelview`', '`identity.json.bak`', '**Retry**', 'Do not restart Tunnelview while both files are missing']) {
    assert.ok(id.includes(w), `identity row lacks: ${w}`);
  }
  assert.match(read('src/main/index.js'), /return path\.join\(base, 'Tunnelview'\);/, 'index.js keeps the identity in LOCALAPPDATA\\Tunnelview');
  assert.ok(trouble.length > 0);
});

test('docs: README and ARCHITECTURE name the update buttons the Updates page shows (DECISIONS U6)', () => {
  const ui = read('src/renderer/main/updates.js');
  const labels = ['Download and install', 'Restart and install'];
  assert.match(ui, /label: busy \? 'Downloading…' : 'Download and install'/);
  assert.ok(ui.includes(`label: '${labels[1]}'`), `updates.js has no '${labels[1]}' button`);
  assert.doesNotMatch(ui, /Install and restart/);
  const readme = readText('README.md');
  const start = readme.indexOf('\n## Updating\n');
  const rest = readme.slice(start + 1);
  const section = flat(rest.slice(0, rest.slice(3).search(/\n## /) + 3));
  const click = section.slice(section.indexOf('**Only on your click.**'));
  assert.ok(click.indexOf(`**${labels[0]}**`) >= 0 && click.indexOf(`**${labels[0]}**`) < click.indexOf(`**${labels[1]}**`), 'README: download first, then restart');
  const s6 = flat(docSection(readText('docs/ARCHITECTURE.md'), 6));
  assert.ok(s6.includes(`the UI offers **${labels[1]}**`), '§6 ready');
  for (const doc of [readText('README.md'), readText('docs/ARCHITECTURE.md')]) assert.doesNotMatch(flat(doc), /Install and restart/);
});
