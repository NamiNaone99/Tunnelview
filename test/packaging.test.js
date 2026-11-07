'use strict';
/* node --test test/packaging.test.js — electron-builder.yml fuses, scripts/verify-fuses.js helpers
 * and the Windows installer hooks (build/installer.nsh). Pure Node: reads files, builds nothing. */
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
