'use strict';
/* node --test test/tailscale.test.js — pure Node; fixtures are anonymized real CLI output shapes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ts = require('../src/main/tailscale');
const { Tailscale, parseStatus, parseWhois, isTailscaleIp, normalizeIp, cliCandidates, cliEnv, spawnRunner, defaultRunner, statusFromRun, parseTargetString } = ts;

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const STATUS = fixture('tailscale-status.json');
const WHOIS_PEER = fixture('tailscale-whois-peer.json');
const WHOIS_SELF = fixture('tailscale-whois-self.json');
const WHOIS_TAGGED = fixture('tailscale-whois-tagged.json');

/** Fake CLI runner: maps args → {error, stdout, stderr} and counts calls. */
function fakeCli(handlers) {
  const calls = [];
  const run = async (cli, args) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    for (const [pattern, fn] of handlers) {
      if (typeof pattern === 'string' ? key === pattern : pattern.test(key)) return fn(args);
    }
    return { error: Object.assign(new Error('exit status 1'), { code: 1 }), stdout: '', stderr: 'unknown command' };
  };
  return { run, calls };
}

function ok(json) {
  return () => ({ error: null, stdout: JSON.stringify(json), stderr: '' });
}

function makeTs(handlers) {
  const cli = fakeCli(handlers);
  const t = new Tailscale({ locate: async () => '/fake/tailscale', run: cli.run });
  return { t, calls: cli.calls };
}

const whoisHandlers = [
  ['status --json', ok(STATUS)],
  ['whois --json 100.90.5.6', ok(WHOIS_PEER)],
  ['whois --json fd7a:115c:a1e0::5:6', ok(WHOIS_PEER)],
  ['whois --json 100.101.102.103', ok(WHOIS_SELF)],
  ['whois --json 100.70.7.8', ok(WHOIS_TAGGED)],
  [/^whois --json /, () => ({ error: Object.assign(new Error('exit status 1'), { code: 1 }), stdout: '', stderr: 'peer not found\n' })],
];

/* ------------------------------------------------------------------ isTailscaleIp / normalizeIp */

test('isTailscaleIp: IPv4 range boundaries (100.64.0.0/10)', () => {
  assert.equal(isTailscaleIp('100.63.255.255'), false);
  assert.equal(isTailscaleIp('100.64.0.0'), true);
  assert.equal(isTailscaleIp('100.100.100.100'), true);
  assert.equal(isTailscaleIp('100.127.255.255'), true);
  assert.equal(isTailscaleIp('100.128.0.0'), false);
  assert.equal(isTailscaleIp('10.0.0.1'), false);
  assert.equal(isTailscaleIp('192.168.1.1'), false);
  assert.equal(isTailscaleIp('0.0.0.0'), false);
  assert.equal(isTailscaleIp('255.255.255.255'), false);
});

test('isTailscaleIp: IPv6 range (fd7a:115c:a1e0::/48) incl. compressed/expanded forms', () => {
  assert.equal(isTailscaleIp('fd7a:115c:a1e0::1'), true);
  assert.equal(isTailscaleIp('FD7A:115C:A1E0::1'), true);
  assert.equal(isTailscaleIp('fd7a:115c:a1e0:0:0:0:0:1'), true);
  assert.equal(isTailscaleIp('fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff'), true);
  assert.equal(isTailscaleIp('fd7a:115c:a1e0::'), true);
  assert.equal(isTailscaleIp('fd7a:115c:a1e1::1'), false);
  assert.equal(isTailscaleIp('fd7a:115c::1'), false); // fd7a:115c:0000:… — third hextet is 0
  assert.equal(isTailscaleIp('fd7a:115c:a1e:0::1'), false); // a1e ≠ a1e0
  assert.equal(isTailscaleIp('::1'), false);
  assert.equal(isTailscaleIp('fe80::1'), false);
});

test('isTailscaleIp: mapped v4, brackets, zone ids and junk', () => {
  assert.equal(isTailscaleIp('::ffff:100.100.1.1'), true);
  assert.equal(isTailscaleIp('::FFFF:100.64.0.1'), true);
  assert.equal(isTailscaleIp('::ffff:6464:0101'), true); // 100.100.1.1 in hex notation
  assert.equal(isTailscaleIp('::ffff:10.0.0.1'), false);
  assert.equal(isTailscaleIp('[fd7a:115c:a1e0::1]'), true);
  assert.equal(isTailscaleIp('fd7a:115c:a1e0::1%utun3'), true);
  assert.equal(isTailscaleIp('[fd7a:115c:a1e0::1%14]'), true);
  assert.equal(isTailscaleIp(' 100.64.0.1 '), true);
  for (const bad of ['', null, undefined, 42, {}, '100.64.0', '100.64.0.1.2', '100.064.0.1', '100.64.0.256',
    '100.64.0.1/32', 'fd7a:115c:a1e0::1::2', 'fd7a:115c:a1e0:::1', 'fd7a:115c:a1e0:1:2:3:4:5:6',
    'fd7a:115c:a1e0::g', 'host.example', '100.64.0.1:47800', '::ffff:100.64.0']) {
    assert.equal(isTailscaleIp(bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

test('normalizeIp: strips ::ffff:, zone ids, brackets; canonical IPv6', () => {
  assert.equal(normalizeIp('::ffff:100.64.1.2'), '100.64.1.2');
  assert.equal(normalizeIp('[fd7a:115c:a1e0::1]'), 'fd7a:115c:a1e0::1');
  assert.equal(normalizeIp('fd7a:115c:a1e0:0:0:0:0:1%eth0'), 'fd7a:115c:a1e0::1');
  assert.equal(normalizeIp('FD7A:115C:A1E0:0000:0000:1234:5678:0001'), 'fd7a:115c:a1e0::1234:5678:1');
  assert.equal(normalizeIp('fd7a:0:0:1:0:0:0:1'), 'fd7a:0:0:1::1'); // longest run compressed
  assert.equal(normalizeIp('1:0:0:2:0:0:3:4'), '1::2:0:0:3:4'); // tie → first run
  assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('Host.Example.'), 'host.example.');
  assert.equal(normalizeIp(null), '');
});

/* ------------------------------------------------------------------ parseStatus */

test('parseStatus maps self, peers, users, tags, sharee and OS names', () => {
  const st = parseStatus(STATUS);
  assert.equal(st.state, 'running');
  assert.equal(st.message, '');
  assert.equal(st.magicDnsSuffix, 'example-tailnet.ts.net');
  assert.deepEqual(st.self, {
    id: '1000000000000001',
    stableId: 'nSELF000001CNTRL',
    hostname: 'DESK-WIN',
    dnsName: 'desk-win.example-tailnet.ts.net',
    shortName: 'desk-win',
    os: 'windows',
    ips: ['100.101.102.103', 'fd7a:115c:a1e0::aaaa:bbbb'],
    user: { login: 'alice@example.com', displayName: 'Alice Example' },
    tags: [],
    direct: true, // self: always "direct" (its own Relay = home DERP is not a path)
    relay: '',
  });
  assert.equal(st.peers.length, 9);
  // online first, then hostname
  const onlineFlags = st.peers.map((p) => p.online);
  assert.deepEqual(onlineFlags, [...onlineFlags].sort((a, b) => Number(b) - Number(a)));

  const mac = st.peers.find((p) => p.stableId === 'nSTUDIOMAC1CNTRL');
  assert.equal(mac.os, 'macos');
  assert.equal(mac.hostname, 'studio');
  assert.equal(mac.shortName, 'studio-1');
  assert.equal(mac.dnsName, 'studio-1.example-tailnet.ts.net');
  assert.equal(mac.online, false);
  assert.equal(mac.lastSeen, '2026-10-30T12:00:00.100Z');
  assert.equal(mac.isSelf, false);
  assert.deepEqual(mac.user, { login: 'alice@example.com', displayName: 'Alice Example' });

  const online = st.peers.find((p) => p.stableId === 'nBUILDBOX1CNTRL');
  assert.equal(online.online, true);
  assert.equal(online.lastSeen, null); // zero time → null

  const tagged = st.peers.find((p) => p.stableId === 'nCIRUNNER1CNTRL');
  assert.deepEqual(tagged.tags, ['tag:ci', 'tag:server']);
  assert.equal(tagged.user.login, 'tagged-devices');

  const sharee = st.peers.find((p) => p.stableId === 'nSHAREE001CNTRL');
  assert.equal(sharee.sharee, true);
  assert.equal(sharee.os, 'other');
  assert.equal(sharee.dnsName, '');
  assert.equal(sharee.shortName, 'device-of-shared-to-user');
  assert.equal(sharee.user.login, 'carol@example.com');

  const ipad = st.peers.find((p) => p.stableId === 'nIPAD00001CNTRL');
  assert.equal(ipad.os, 'ios');
  assert.equal(ipad.expired, true);
  assert.equal(ipad.shortName, 'ipad-1');
});

test('parseStatus: direct vs DERP-relayed path (CurAddr / Relay)', () => {
  const st = parseStatus(STATUS);
  const by = (id) => st.peers.find((p) => p.stableId === id);
  // CurAddr set → direct; Relay is the DERP region it would otherwise use
  assert.deepEqual([by('nBUILDBOX1CNTRL').direct, by('nBUILDBOX1CNTRL').relay], [true, 'fra']);
  // CurAddr '' → relayed via DERP
  assert.deepEqual([by('nMACMINI01CNTRL').direct, by('nMACMINI01CNTRL').relay], [false, 'nyc']);
  assert.deepEqual([by('nSTUDIOMAC1CNTRL').direct, by('nSTUDIOMAC1CNTRL').relay], [false, 'ams']);
  // fields absent → not direct, no relay
  assert.deepEqual([by('nLABLINUX1CNTRL').direct, by('nLABLINUX1CNTRL').relay], [false, '']);
  for (const p of st.peers) {
    assert.equal(typeof p.direct, 'boolean');
    assert.match(p.relay, /^[a-z0-9-]{0,16}$/);
  }

  // sanitizing: relay codes outside [a-z0-9-]{0,16} → ''; whitespace-only CurAddr is not direct
  const json = structuredClone(STATUS);
  const lab = Object.values(json.Peer).find((n) => n.ID === 'nLABLINUX1CNTRL');
  lab.Relay = '<b>x</b>';
  lab.CurAddr = '   ';
  const mac = Object.values(json.Peer).find((n) => n.ID === 'nMACMINI01CNTRL');
  mac.Relay = 'a'.repeat(17);
  mac.CurAddr = 42;
  const ipad = Object.values(json.Peer).find((n) => n.ID === 'nIPAD00001CNTRL');
  ipad.Relay = 'SFO';
  const st2 = parseStatus(json);
  const by2 = (id) => st2.peers.find((p) => p.stableId === id);
  assert.deepEqual([by2('nLABLINUX1CNTRL').direct, by2('nLABLINUX1CNTRL').relay], [false, '']);
  assert.deepEqual([by2('nMACMINI01CNTRL').direct, by2('nMACMINI01CNTRL').relay], [false, '']);
  assert.equal(by2('nIPAD00001CNTRL').relay, '');
});

test('parseStatus: backend states and malformed input', () => {
  assert.equal(parseStatus({ BackendState: 'Stopped' }).state, 'stopped');
  assert.equal(parseStatus({ BackendState: 'NeedsLogin' }).state, 'needs-login');
  assert.equal(parseStatus({ BackendState: 'NeedsMachineAuth' }).state, 'needs-login');
  assert.equal(parseStatus({ BackendState: 'Starting' }).state, 'stopped');
  assert.equal(parseStatus({ BackendState: 'NoState' }).state, 'stopped');
  assert.equal(parseStatus({ BackendState: 'Weird' }).state, 'error');
  assert.equal(parseStatus(null).state, 'error');
  assert.equal(parseStatus('x').state, 'error');
  // not running → no peers even if the JSON carries stale ones
  assert.deepEqual(parseStatus({ ...STATUS, BackendState: 'Stopped' }).peers, []);
});

test('parseStatus strips control and bidi characters from peer-chosen names', () => {
  const json = structuredClone(STATUS);
  const peer = Object.values(json.Peer)[0];
  peer.HostName = 'evil\u202Etxt.exe\u0007';
  json.User['1001'].DisplayName = 'Al\u2066ice\n';
  const st = parseStatus(json);
  const p = st.peers.find((x) => x.stableId === peer.ID);
  assert.equal(p.hostname, 'eviltxt.exe');
  assert.equal(p.user.displayName, 'Alice');
});

/* ------------------------------------------------------------------ parseWhois */

test('parseWhois: peer, self (no OS) and tagged node', () => {
  const peer = parseWhois(WHOIS_PEER);
  assert.deepEqual(peer, {
    node: {
      id: '1000000000000005',
      stableId: 'nMACMINI01CNTRL',
      name: 'bobs-mac-mini.example-tailnet.ts.net',
      hostname: 'Bobs-Mac-mini',
      os: 'macos',
      ips: ['100.90.5.6', 'fd7a:115c:a1e0::5:6'], // the advertised subnet route is NOT an own address
      tags: [],
    },
    user: { id: '1002', login: 'bob@example.com', displayName: 'Bob Example' },
    isSelf: false,
  });
  const self = parseWhois(WHOIS_SELF);
  assert.equal(self.node.os, 'other');
  assert.equal(self.node.hostname, 'DESK-WIN');
  const tagged = parseWhois(WHOIS_TAGGED);
  assert.deepEqual(tagged.node.tags, ['tag:ci', 'tag:server']);
  assert.equal(tagged.user.login, 'tagged-devices');
  assert.equal(parseWhois({}), null);
  assert.equal(parseWhois({ Node: { ID: 1 } }), null); // no StableID
  assert.equal(parseWhois(null), null);
});

test('parseWhois: node.name is only the control-plane MagicDNS name, never the self-reported hostname', () => {
  const json = structuredClone(WHOIS_PEER);
  delete json.Node.Name;
  json.Node.ComputedName = 'office-pc'; // without a MagicDNS name this is Hostinfo.Hostname
  json.Node.Hostinfo.Hostname = 'office-pc';
  const w = parseWhois(json);
  assert.equal(w.node.name, '');
  assert.equal(w.node.hostname, 'office-pc'); // still available for display
});

/* ------------------------------------------------------------------ status() */

test('status(): running, coalesced concurrent calls, cached in .last', async () => {
  const { t, calls } = makeTs([['status --json', ok(STATUS)]]);
  const [a, b] = await Promise.all([t.status(), t.status()]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.equal(a.state, 'running');
  assert.equal(t.last, a);
  assert.equal(t.cliPath, '/fake/tailscale');
});

test('status(): not installed / daemon down / timeout / garbage — never throws', async () => {
  const missing = new Tailscale({ locate: async () => null, run: async () => { throw new Error('must not run'); } });
  assert.equal((await missing.status()).state, 'not-installed');

  const enoent = new Tailscale({ locate: async () => '/gone', run: async () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }) });
  assert.equal((await enoent.status()).state, 'not-installed');
  assert.equal(enoent.cliPath, null);

  const down = statusFromRun({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: '', stderr: 'failed to connect to local Tailscale service; is Tailscale running?\n' });
  assert.equal(down.state, 'stopped');
  assert.match(down.message, /not running/i);

  const timeout = statusFromRun({ error: Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }), stdout: '', stderr: '' });
  assert.equal(timeout.state, 'error');
  assert.match(timeout.message, /in time/);

  const garbage = statusFromRun({ error: null, stdout: 'not json', stderr: '' });
  assert.equal(garbage.state, 'error');

  const bom = statusFromRun({ error: null, stdout: `\ufeff${JSON.stringify(STATUS)}`, stderr: '' });
  assert.equal(bom.state, 'running');

  const throwing = new Tailscale({ locate: async () => '/x', run: async () => { throw new Error('boom'); } });
  const st = await throwing.status();
  assert.equal(st.state, 'error');
});

test('cliCandidates: platform locations + absolute PATH entries only', () => {
  const win = cliCandidates('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', PATH: 'C:\\Tools;.;relative\\dir;"C:\\Quoted Dir"' });
  assert.equal(win[0], 'C:\\Program Files\\Tailscale\\tailscale.exe');
  assert.ok(win.includes('C:\\Program Files (x86)\\Tailscale\\tailscale.exe'));
  assert.ok(win.includes('C:\\Tools\\tailscale.exe'));
  assert.ok(win.includes('C:\\Quoted Dir\\tailscale.exe'));
  assert.ok(!win.some((p) => p.startsWith('.') || p.startsWith('relative')));

  const mac = cliCandidates('darwin', { PATH: '/usr/bin:/bin', HOME: '/Users/test' });
  // the app executables first: /usr/local/bin/tailscale is often only a shell wrapper around them
  assert.deepEqual(mac.slice(0, 4), [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/Users/test/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ]);
  assert.ok(mac.includes('/usr/bin/tailscale'));
});

/* ------------------------------------------------------------------ macOS: CLI mode + run results */

test('cliEnv: macOS forces CLI mode (TAILSCALE_BE_CLI + SHLVL/TERM); other platforms inherit', () => {
  const finder = { HOME: '/Users/a', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }; // what a Finder-launched app gets
  const env = cliEnv('darwin', finder);
  assert.equal(env.TAILSCALE_BE_CLI, '1');
  assert.equal(env.SHLVL, '1');
  assert.equal(env.TERM, 'dumb');
  assert.equal(env.HOME, '/Users/a');
  assert.equal(env.PATH, finder.PATH);
  assert.equal(finder.TAILSCALE_BE_CLI, undefined, 'the input env is not modified');
  const shell = cliEnv('darwin', { SHLVL: '3', TERM: 'xterm-256color' });
  assert.deepEqual([shell.SHLVL, shell.TERM, shell.TAILSCALE_BE_CLI], ['3', 'xterm-256color', '1']);
  assert.equal(cliEnv('win32', finder), undefined);
  assert.equal(cliEnv('linux', finder), undefined);
});

test('statusFromRun: macOS app-mode output, empty output, crashes and oversized output are told apart', () => {
  const gui = statusFromRun({ error: null, stdout: 'The Tailscale GUI failed to start: The operation couldn’t be completed. (Tailscale.CLIError error 3.)\n', stderr: '' });
  assert.equal(gui.state, 'error');
  assert.match(gui.message, /started as the Tailscale app instead of answering/);
  assert.match(gui.message, /CLIError error 3/);

  const empty = statusFromRun({ error: null, stdout: '  \n', stderr: '' });
  assert.equal(empty.state, 'error');
  assert.match(empty.message, /exited without printing a status/);

  const other = statusFromRun({ error: null, stdout: 'hello\nworld', stderr: '' });
  assert.match(other.message, /doesn’t understand: “hello”/);

  // a signal we did not send (Swift fatal error → SIGTRAP) is a crash, not a timeout
  const crash = statusFromRun({ error: Object.assign(new Error('Command failed'), { code: null, killed: false, signal: 'SIGTRAP' }), stdout: '', stderr: 'BundleIdentifiers.swift:49: Fatal error: The current bundleIdentifier is unknown to the registry\n' });
  assert.equal(crash.state, 'error');
  assert.match(crash.message, /stopped unexpectedly \(SIGTRAP\)/);
  assert.match(crash.message, /bundleIdentifier is unknown/);
  assert.doesNotMatch(crash.message, /in time/);

  const big = statusFromRun({ error: Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }), stdout: '{"Backend', stderr: '' });
  assert.match(big.message, /too large/);

  const ourTimeout = statusFromRun({ error: Object.assign(new Error('Command timed out after 5000 ms'), { killed: true, signal: 'SIGKILL' }), stdout: '', stderr: '' });
  assert.match(ourTimeout.message, /in time/);
});

test('spawnRunner: output, exit codes, missing binary, timeout and maxBuffer (execFile-compatible)', async () => {
  const node = process.execPath;
  const ok = await spawnRunner(node, ['-e', 'process.stdout.write(JSON.stringify({BackendState:"Running"}))'], { timeoutMs: 10000 });
  assert.equal(ok.error, null);
  assert.equal(JSON.parse(ok.stdout).BackendState, 'Running');

  const fail = await spawnRunner(node, ['-e', 'process.stderr.write("failed to connect to local Tailscale service; is Tailscale running?\\n"); process.exit(1)'], { timeoutMs: 10000 });
  assert.equal(fail.error.code, 1);
  assert.equal(fail.error.killed, false);
  assert.match(fail.stderr, /is Tailscale running/);
  assert.equal(statusFromRun(fail).state, 'stopped');

  const env = await spawnRunner(node, ['-e', 'process.stdout.write(String(process.env.TAILSCALE_BE_CLI))'], { env: { ...process.env, TAILSCALE_BE_CLI: '1' }, timeoutMs: 10000 });
  assert.equal(env.stdout, '1', 'the env reaches the child');

  const missing = await spawnRunner(path.join(__dirname, 'no-such-tailscale-binary'), ['status', '--json'], { timeoutMs: 10000 });
  assert.equal(missing.error.code, 'ENOENT');

  const t0 = Date.now();
  const hang = await spawnRunner(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });
  assert.equal(hang.error.killed, true);
  assert.ok(Date.now() - t0 < 5000, 'the timeout ends the run');
  assert.equal(statusFromRun(hang).message, 'Tailscale did not respond in time.');

  const big = await spawnRunner(node, ['-e', 'process.stdout.write("x".repeat(200000))'], { timeoutMs: 10000, maxBuffer: 1000 });
  assert.equal(big.error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});

test('defaultRunner on macOS: the real child gets TAILSCALE_BE_CLI=1 (the fix) and the spawnRunner timeout', async () => {
  const node = process.execPath;
  const echo = ['-e', 'process.stdout.write([process.env.TAILSCALE_BE_CLI, process.env.SHLVL ? "shlvl" : "", process.env.TERM ? "term" : ""].join(","))'];
  const mac = await defaultRunner(node, echo, { platform: 'darwin' });
  assert.equal(mac.error, null);
  assert.equal(mac.stdout, '1,shlvl,term');
  const hang = await defaultRunner(node, ['-e', 'setInterval(() => {}, 1000)'], { platform: 'darwin', timeoutMs: 300 });
  assert.equal(hang.error.killed, true);
  assert.equal(hang.error.signal, 'SIGKILL', 'spawnRunner (not execFile, which sends SIGTERM) ran');
  // elsewhere the CLI inherits Tunnelview's environment unchanged
  const saved = process.env.TAILSCALE_BE_CLI;
  delete process.env.TAILSCALE_BE_CLI;
  try {
    for (const platform of ['win32', 'linux']) {
      const r = await defaultRunner(node, ['-e', 'process.stdout.write(String(process.env.TAILSCALE_BE_CLI))'], { platform });
      assert.equal(r.stdout, 'undefined', platform);
    }
  } finally {
    if (saved !== undefined) process.env.TAILSCALE_BE_CLI = saved;
  }
});

test('spawnRunner kills the whole process group: a binary behind a shell wrapper does not survive (POSIX)', { skip: process.platform === 'win32' }, async () => {
  const pidFile = path.join(require('os').tmpdir(), `tunnelview-ts-grandchild-${process.pid}.pid`);
  try { fs.unlinkSync(pidFile); } catch { /* none */ }
  // like /usr/local/bin/tailscale: a #!/bin/sh wrapper that runs the real binary without exec
  const script = `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${pidFile}"; :`;
  const t0 = Date.now();
  const r = await spawnRunner('/bin/sh', ['-c', script], { timeoutMs: 600 });
  const elapsed = Date.now() - t0;
  assert.equal(r.error.killed, true);
  assert.ok(elapsed < 600 + 700, `ended by the group kill, not the 1 s fallback (${elapsed} ms)`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 200));
  try {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the grandchild is gone');
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    try { fs.unlinkSync(pidFile); } catch { /* none */ }
  }
});

/* ------------------------------------------------------------------ macOS: tunnel gate (tailscale/tailscale#21825) */

const IFACES_NONE = { lo0: [{ address: '127.0.0.1', family: 'IPv4' }, { address: '::1', family: 'IPv6' }], en0: [{ address: '192.168.1.20', family: 'IPv4' }] };
const IFACES_TS = { ...IFACES_NONE, utun4: [{ address: '100.101.102.103', family: 'IPv4' }, { address: 'fd7a:115c:a1e0::aaaa:bbbb', family: 'IPv6' }] };
const IFACES_TS_V4_ONLY = { ...IFACES_NONE, utun4: [{ address: '100.101.102.103', family: 'IPv4' }] };
const IFACES_WARP = { ...IFACES_NONE, utun3: [{ address: '100.96.0.7', family: 'IPv4' }] }; // Cloudflare WARP / NetBird share 100.64.0.0/10

function makeMacTs(handlers, ifaces, { locate = async () => '/Applications/Tailscale.app/Contents/MacOS/Tailscale' } = {}) {
  const cli = fakeCli(handlers);
  const logs = [];
  let current = ifaces;
  const t = new Tailscale({ locate, run: cli.run, tunnelGate: true, interfaces: () => current, log: (m) => logs.push(m) });
  return { t, calls: cli.calls, logs, setIfaces: (v) => { current = v; } };
}

test('tunnel gate: no Tailscale address → "not connected" without ever starting the Tailscale executable', async () => {
  const { t, calls } = makeMacTs(whoisHandlers, IFACES_NONE);
  const st = await t.status();
  assert.equal(st.state, 'stopped');
  assert.match(st.message, /isn’t connected/);
  assert.equal(await t.whois('100.90.5.6'), null);
  assert.deepEqual(calls, [], 'a background poll must never be what starts Tailscale');

  const { t: none, calls: noneCalls } = makeMacTs([], IFACES_NONE, { locate: async () => null });
  assert.equal((await none.status()).state, 'not-installed');
  assert.deepEqual(noneCalls, []);

  // another VPN in the shared 100.64.0.0/10 space does not count as Tailscale
  const { t: warp, calls: warpCalls } = makeMacTs([['status --json', ok(STATUS)]], IFACES_WARP);
  assert.equal((await warp.status()).state, 'stopped');
  assert.deepEqual(warpCalls, []);
});

test('tunnel gate: a Tailscale address → the CLI answers status and whois; it closes again when the tunnel goes', async () => {
  const { t, calls, logs, setIfaces } = makeMacTs(whoisHandlers, IFACES_NONE);
  assert.equal((await t.status()).state, 'stopped');
  setIfaces(IFACES_TS);
  const st = await t.status();
  assert.equal(st.state, 'running');
  assert.equal((await t.whois('100.90.5.6')).user.login, 'bob@example.com');
  assert.deepEqual(calls, ['status --json', 'whois --json 100.90.5.6']);

  // IPv4-only interface: counts once it is one of this node's known addresses
  setIfaces(IFACES_TS_V4_ONLY);
  assert.equal((await t.status()).state, 'running');
  setIfaces(IFACES_NONE);
  assert.equal((await t.status()).state, 'stopped');
  assert.equal(calls.length, 3, 'no CLI run once the address is gone');
  setIfaces(IFACES_TS_V4_ONLY);
  assert.equal((await t.status()).state, 'running', 'known self address, remembered across the stopped poll');
  assert.deepEqual(logs, [
    '[tailscale] no Tailscale address on this Mac: not starting the Tailscale CLI',
    '[tailscale] Tailscale address present: reading status from the Tailscale CLI',
    '[tailscale] no Tailscale address on this Mac: not starting the Tailscale CLI',
    '[tailscale] Tailscale address present: reading status from the Tailscale CLI',
  ], 'logged on change only');

  // a fresh instance knows no self address yet: an IPv4-only 100.x address alone does not open the gate
  const { t: fresh, calls: freshCalls } = makeMacTs([['status --json', ok(STATUS)]], IFACES_TS_V4_ONLY);
  assert.equal((await fresh.status()).state, 'stopped');
  assert.deepEqual(freshCalls, []);
});

test('tunnel gate: a throwing interfaces() fails closed; without the gate (Windows/Linux) interfaces are never read', async () => {
  const cli = fakeCli([['status --json', ok(STATUS)]]);
  const t = new Tailscale({ locate: async () => '/x', run: cli.run, tunnelGate: true, interfaces: () => { throw new Error('boom'); } });
  assert.equal((await t.status()).state, 'stopped');
  assert.deepEqual(cli.calls, []);
  const free = new Tailscale({ locate: async () => '/x', run: cli.run, interfaces: () => assert.fail('not consulted') });
  assert.equal((await free.status()).state, 'running');
});

/* ------------------------------------------------------------------ whois() */

test('whois(): maps identity, caches 60 s, detects self, rejects unknown/non-tailnet IPs', async () => {
  const { t, calls } = makeTs(whoisHandlers);
  const w = await t.whois('::ffff:100.90.5.6');
  assert.equal(w.node.stableId, 'nMACMINI01CNTRL');
  assert.equal(w.user.login, 'bob@example.com');
  assert.equal(w.isSelf, false);
  const before = calls.filter((c) => c.startsWith('whois')).length;
  const again = await t.whois('100.90.5.6');
  assert.deepEqual(again, w);
  assert.equal(calls.filter((c) => c.startsWith('whois')).length, before, 'second lookup served from cache');
  again.node.hostname = 'mutated';
  assert.equal((await t.whois('100.90.5.6')).node.hostname, 'Bobs-Mac-mini', 'cache returns copies');

  const self = await t.whois('100.101.102.103');
  assert.equal(self.isSelf, true);
  assert.equal(self.node.os, 'windows', 'self OS filled from status');

  const tagged = await t.whois('100.70.7.8');
  assert.equal(tagged.user.login, 'tagged-devices');
  assert.equal(tagged.node.os, 'linux');

  assert.equal(await t.whois('100.64.0.1'), null); // CLI: peer not found
  const n = calls.length;
  assert.equal(await t.whois('8.8.8.8'), null); // never reaches the CLI
  assert.equal(await t.whois('not an ip'), null);
  assert.equal(calls.length, n);
});

test('whois(): an address that is not one of the node\'s own addresses is rejected', async () => {
  // e.g. an IP inside a subnet route: whois must not vouch for it
  const { t } = makeTs([['status --json', ok(STATUS)], ['whois --json 100.90.5.7', ok(WHOIS_PEER)]]);
  assert.equal(await t.whois('100.90.5.7'), null);
});

/* ------------------------------------------------------------------ resolveTarget() */

test('resolveTarget: IPs, ports, IPv6 forms', async () => {
  const { t } = makeTs([['status --json', ok(STATUS)]]);
  let r = await t.resolveTarget('100.90.5.6');
  assert.deepEqual([r.ip, r.port, r.portExplicit, r.peer.stableId], ['100.90.5.6', 47800, false, 'nMACMINI01CNTRL']);
  r = await t.resolveTarget('100.90.5.6:50000');
  assert.deepEqual([r.ip, r.port, r.portExplicit], ['100.90.5.6', 50000, true]);
  r = await t.resolveTarget('[fd7a:115c:a1e0::5:6]:47900');
  assert.deepEqual([r.ip, r.port, r.portExplicit, r.peer.stableId], ['fd7a:115c:a1e0::5:6', 47900, true, 'nMACMINI01CNTRL']);
  r = await t.resolveTarget('[fd7a:115c:a1e0::5:6]');
  assert.deepEqual([r.ip, r.port, r.portExplicit], ['fd7a:115c:a1e0::5:6', 47800, false]);
  r = await t.resolveTarget('fd7a:115c:a1e0:0:0:0:5:6');
  assert.deepEqual([r.ip, r.port, r.portExplicit], ['fd7a:115c:a1e0::5:6', 47800, false]);
  r = await t.resolveTarget('::ffff:100.90.5.6');
  assert.equal(r.ip, '100.90.5.6');
  r = await t.resolveTarget('100.101.102.103');
  assert.equal(r.peer.isSelf, true);
});

test('parseTargetString / resolveTarget report whether a port was typed (portExplicit)', async () => {
  assert.deepEqual(parseTargetString('host'), { host: 'host', port: 47800, portExplicit: false });
  assert.deepEqual(parseTargetString('host:48000'), { host: 'host', port: 48000, portExplicit: true });
  assert.deepEqual(parseTargetString('host:47800'), { host: 'host', port: 47800, portExplicit: true }); // explicit default
  assert.deepEqual(parseTargetString('[fd7a:115c:a1e0::5:6]'), { host: 'fd7a:115c:a1e0::5:6', port: 47800, portExplicit: false });
  assert.deepEqual(parseTargetString('[fd7a:115c:a1e0::5:6]:48000'), { host: 'fd7a:115c:a1e0::5:6', port: 48000, portExplicit: true });
  assert.deepEqual(parseTargetString('fd7a:115c:a1e0::5:6'), { host: 'fd7a:115c:a1e0::5:6', port: 47800, portExplicit: false });
  assert.throws(() => parseTargetString('host:0'), { code: 'NOT_FOUND' });

  const { t } = makeTs([['status --json', ok(STATUS)]]);
  const byName = await t.resolveTarget('build-box');
  assert.deepEqual([byName.port, byName.portExplicit], [47800, false]);
  const byNamePort = await t.resolveTarget('build-box:48000');
  assert.deepEqual([byNamePort.port, byNamePort.portExplicit], [48000, true]);
});

test('resolveTarget: names (hostname, short, FQDN, trailing dot, stableId) prefer IPv4', async () => {
  const { t } = makeTs([['status --json', ok(STATUS)]]);
  for (const q of ['Bobs-Mac-mini', 'bobs-mac-mini', 'bobs-mac-mini.example-tailnet.ts.net', 'BOBS-MAC-MINI.example-tailnet.ts.net.', 'nMACMINI01CNTRL']) {
    const r = await t.resolveTarget(q);
    assert.equal(r.peer.stableId, 'nMACMINI01CNTRL', q);
    assert.equal(r.ip, '100.90.5.6', q);
    assert.equal(r.port, 47800);
  }
  const self = await t.resolveTarget('desk-win');
  assert.equal(self.peer.isSelf, true);
  const ipad = await t.resolveTarget('ipad-1');
  assert.equal(ipad.peer.stableId, 'nIPAD00001CNTRL');
  const port = await t.resolveTarget('build-box:47805');
  assert.deepEqual([port.ip, port.port], ['100.73.10.20', 47805]);
});

test('resolveTarget: MagicDNS labels beat self-reported hostnames; never picked by online/OS', async () => {
  const { t } = makeTs([['status --json', ok(STATUS)]]);
  // "studio": android owns the MagicDNS label "studio"; the Mac only *reports* hostname "studio"
  assert.equal((await t.resolveTarget('studio')).peer.stableId, 'nSTUDIOAND1CNTRL');
  assert.equal((await t.resolveTarget('studio-1')).peer.stableId, 'nSTUDIOMAC1CNTRL');
  assert.equal((await t.resolveTarget('studio.example-tailnet.ts.net')).peer.stableId, 'nSTUDIOAND1CNTRL');
  // "lab": linux owns the label; the Windows box (lab-1) reporting hostname "LAB" does not win
  assert.equal((await t.resolveTarget('lab')).peer.stableId, 'nLABLINUX1CNTRL');
  assert.equal((await t.resolveTarget('LAB')).peer.stableId, 'nLABLINUX1CNTRL');

  // online state does not change the answer
  const json = structuredClone(STATUS);
  json.Peer['nodekey:0000000000000000000000000000000000000000000000000000000000000002'].Online = true;
  json.Peer['nodekey:0000000000000000000000000000000000000000000000000000000000000003'].Online = false;
  const { t: t2 } = makeTs([['status --json', ok(json)]]);
  assert.equal((await t2.resolveTarget('studio')).peer.stableId, 'nSTUDIOAND1CNTRL');
  // a unique self-reported hostname (no label match) still resolves
  assert.equal((await t.resolveTarget('localhost')).peer.stableId, 'nIPAD00001CNTRL');
});

/** Synthetic `status --json` for the hostname-squatting scenarios (Go sorts map keys = node keys). */
function squatStatus(nodes) {
  const peers = {};
  for (const n of nodes) peers[n.key] = { ID: n.id, NodeID: n.nodeId, HostName: n.host, DNSName: n.dns, OS: 'windows', TailscaleIPs: [n.ip], Online: n.online, UserID: n.user, Tags: [] };
  return {
    BackendState: 'Running',
    MagicDNSSuffix: 'x.ts.net',
    Self: { ID: 'nSELF', NodeID: 1, HostName: 'laptop', DNSName: 'laptop.x.ts.net.', OS: 'macOS', TailscaleIPs: ['100.70.0.1'], UserID: 1 },
    User: { 1: { ID: 1, LoginName: 'alice@example.com', DisplayName: 'Alice' }, 2: { ID: 2, LoginName: 'mallory@example.com', DisplayName: 'Mallory' } },
    Peer: Object.fromEntries(Object.keys(peers).sort().map((k) => [k, peers[k]])),
  };
}

test('resolveTarget: a squatted OS hostname cannot steer resolution (security-2)', async () => {
  const REAL = { id: 'nREAL', nodeId: 2, host: 'office-pc', dns: 'office-pc.x.ts.net.', ip: '100.70.0.2', user: 1 };
  const EVIL = { id: 'nEVIL', nodeId: 3, host: 'office-pc', dns: 'office-pc-1.x.ts.net.', ip: '100.70.0.66', user: 2 };
  for (const [label, real, evil] of [
    ['real device offline, attacker online', { ...REAL, key: 'nodekey:8888', online: false }, { ...EVIL, key: 'nodekey:ffff', online: true }],
    ['both online, attacker node key sorts first', { ...REAL, key: 'nodekey:8888', online: true }, { ...EVIL, key: 'nodekey:0000', online: true }],
  ]) {
    const { t } = makeTs([['status --json', ok(squatStatus([real, evil]))]]);
    const r = await t.resolveTarget('office-pc');
    assert.equal(r.peer.stableId, 'nREAL', label);
    assert.equal(r.ip, '100.70.0.2', label);
  }

  // two nodes claim the same hostname and neither owns that MagicDNS label → AMBIGUOUS, never a guess
  const A = { id: 'nA', nodeId: 4, host: 'workstation', dns: 'ws-alice.x.ts.net.', ip: '100.70.0.4', user: 1, key: 'nodekey:0001', online: false };
  const B = { id: 'nB', nodeId: 5, host: 'WorkStation', dns: 'ws-mallory.x.ts.net.', ip: '100.70.0.5', user: 2, key: 'nodekey:0002', online: true };
  const { t: amb } = makeTs([['status --json', ok(squatStatus([A, B]))]]);
  await assert.rejects(amb.resolveTarget('workstation'), (e) => {
    assert.equal(e.code, 'AMBIGUOUS');
    // the instruction comes first, so a UI that clips the text still shows it (list order = peer order)
    assert.match(e.message, /^Several devices are called "workstation"\. Type the full MagicDNS name or Tailscale IP instead: /);
    assert.match(e.message, /ws-alice\.x\.ts\.net \(alice@example\.com\)/);
    assert.match(e.message, /ws-mallory\.x\.ts\.net \(mallory@example\.com\)\.?/);
    assert.match(e.message, /\)\.$/);
    return true;
  });
  // the candidates are still reachable by their unique names
  assert.equal((await amb.resolveTarget('ws-mallory')).peer.stableId, 'nB');
  assert.equal((await amb.resolveTarget('ws-alice.x.ts.net')).peer.stableId, 'nA');

  // a unique self-reported hostname resolves (tier 4)
  const C = { id: 'nC', nodeId: 6, host: 'My Laptop', dns: 'my-laptop-7.x.ts.net.', ip: '100.70.0.6', user: 1, key: 'nodekey:0003', online: true };
  const { t: uniq } = makeTs([['status --json', ok(squatStatus([A, C]))]]);
  assert.equal((await uniq.resolveTarget('my laptop')).peer.stableId, 'nC');
  assert.equal((await uniq.resolveTarget('workstation')).peer.stableId, 'nA');

  // the ambiguity message lists at most 3 candidates
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `nM${i}`, nodeId: 10 + i, host: 'kiosk', dns: `kiosk-${i + 1}.x.ts.net.`, ip: `100.70.1.${i + 1}`, user: 1, key: `nodekey:1${i}`, online: true }));
  const { t: lots } = makeTs([['status --json', ok(squatStatus(many))]]);
  await assert.rejects(lots.resolveTarget('kiosk'), (e) => {
    assert.equal(e.code, 'AMBIGUOUS');
    assert.equal((e.message.match(/\.x\.ts\.net \(/g) || []).length, 3);
    assert.match(e.message, /^Several devices are called "kiosk"\. Type the full MagicDNS name or Tailscale IP instead: kiosk-1/);
    assert.match(e.message, / and 4 more\.$/);
    return true;
  });
});

test('resolveTarget: the AMBIGUOUS message stays within 220 chars, guidance first (net2-11)', async () => {
  const long = (i, dns, login) => ({ id: `nL${i}`, nodeId: 30 + i, host: 'studio', dns: `${dns}.`, ip: `100.70.2.${i + 1}`, user: i % 2 ? 2 : 1, key: `nodekey:2${i}`, online: true, login });
  const status = squatStatus([
    long(0, 'studio.tail4b2c1.ts.net'),
    long(1, 'studio.shared-tailnet-name-that-is-rather-long.ts.net'),
    long(2, 'studio.third-tailnet-xyz.ts.net'),
    long(3, `studio.${'x'.repeat(80)}.ts.net`),
  ]);
  status.User[1].LoginName = 'alice.anderson@example-company.example';
  status.User[2].LoginName = 'bob.brown@another-company.example';
  const { t } = makeTs([['status --json', ok(status)]]);
  await assert.rejects(t.resolveTarget('studio'), (e) => {
    assert.equal(e.code, 'AMBIGUOUS');
    assert.ok(e.message.length <= 220, `${e.message.length}: ${e.message}`);
    assert.ok(e.message.startsWith('Several devices are called "studio". Type the full MagicDNS name or Tailscale IP instead'), e.message);
    // every listed candidate (between ': ' and the end) is at most 60 chars
    const list = e.message.split('instead: ')[1].replace(/ and \d+ more\.$|\.$/, '');
    for (const item of list.split(', ')) assert.ok(item.length <= 60, item);
    assert.match(e.message, / and \d+ more\.$/);
    return true;
  });
  // an absurdly long typed name still yields a short message with the guidance
  const { t: t2 } = makeTs([['status --json', ok(squatStatus([long(0, 'a.x.ts.net'), long(1, 'b.x.ts.net')].map((n) => ({ ...n, host: 'y'.repeat(200) }))))]]);
  await assert.rejects(t2.resolveTarget('y'.repeat(200)), (e) => {
    assert.equal(e.code, 'AMBIGUOUS');
    assert.ok(e.message.length <= 220, e.message);
    assert.match(e.message, /Type the full MagicDNS name or Tailscale IP instead/);
    return true;
  });
});

test('resolveTarget: error codes', async () => {
  const { t } = makeTs([['status --json', ok(STATUS)]]);
  await assert.rejects(t.resolveTarget('8.8.8.8'), { code: 'NOT_TAILNET' });
  await assert.rejects(t.resolveTarget('192.168.1.10:47800'), { code: 'NOT_TAILNET' });
  await assert.rejects(t.resolveTarget('100.64.0.1'), { code: 'NOT_TAILNET' }); // in range, not a peer
  await assert.rejects(t.resolveTarget('[fd7a:115c:a1e0::dead]'), { code: 'NOT_TAILNET' });
  await assert.rejects(t.resolveTarget('nope'), { code: 'NOT_FOUND' });
  await assert.rejects(t.resolveTarget('example.com'), { code: 'NOT_FOUND' }); // never system DNS
  await assert.rejects(t.resolveTarget('studio.other-tailnet.ts.net'), { code: 'NOT_FOUND' });
  await assert.rejects(t.resolveTarget('build-box:99999'), { code: 'NOT_FOUND' });
  await assert.rejects(t.resolveTarget('build-box:abc'), { code: 'NOT_FOUND' });
  await assert.rejects(t.resolveTarget(''), { code: 'NOT_FOUND' });
  await assert.rejects(t.resolveTarget(42), { code: 'NOT_FOUND' });

  const { t: down } = makeTs([['status --json', ok({ BackendState: 'Stopped' })]]);
  await assert.rejects(down.resolveTarget('build-box'), { code: 'TS_DOWN' });
  const missing = new Tailscale({ locate: async () => null });
  await assert.rejects(missing.resolveTarget('100.90.5.6'), { code: 'TS_DOWN' });
});

/* ------------------------------------------------------------------ startWatching() */

test('startWatching: emits status every poll and change on state/IP changes', async () => {
  let current = STATUS;
  const { t } = makeTs([['status --json', () => ({ error: null, stdout: JSON.stringify(current), stderr: '' })]]);
  const statuses = [];
  const changes = [];
  t.on('status', (s) => statuses.push(s.state));
  t.on('change', (s) => changes.push(`${s.state}:${s.self ? s.self.ips.join(',') : ''}`));
  const waitFor = async (pred) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(pred(), 'condition not reached');
  };
  t.startWatching(100);
  await waitFor(() => statuses.length >= 2);
  assert.equal(changes.length, 1, 'only the first poll is a change');
  const json = structuredClone(STATUS);
  json.Self.TailscaleIPs = ['100.101.102.104'];
  current = json;
  await waitFor(() => changes.length >= 2);
  current = { BackendState: 'Stopped' };
  await waitFor(() => changes.length >= 3);
  t.stopWatching();
  assert.deepEqual(changes, [
    'running:100.101.102.103,fd7a:115c:a1e0::aaaa:bbbb',
    'running:100.101.102.104',
    'stopped:',
  ]);
  const n = statuses.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(statuses.length, n, 'no polls after stopWatching');
});

test('singleton export carries the class and helpers', () => {
  assert.ok(ts instanceof Tailscale);
  assert.equal(typeof ts.isTailscaleIp, 'function');
  assert.equal(ts.isTailscaleIp('100.64.0.1'), true);
  assert.equal(ts.normalizeIp('::ffff:100.64.0.1'), '100.64.0.1');
  assert.equal(ts.cliPath, null); // constructing has no side effects
});
