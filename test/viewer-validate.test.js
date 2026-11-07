'use strict';
/* Unit tests for src/renderer/viewer/validate.js and reasons.js (ES modules, pure). */
const test = require('node:test');
const assert = require('node:assert/strict');

// Renderer modules read window.TunnelviewProtocol (= globalThis in the page).
globalThis.TunnelviewProtocol = require('../src/shared/protocol');
const P = globalThis.TunnelviewProtocol;

const loadV = () => import('../src/renderer/viewer/validate.js');
const loadR = () => import('../src/renderer/viewer/reasons.js');
const loadRtc = () => import('../src/renderer/shared/rtc.js');

const OFFER_SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:0',
  'a=candidate:1 1 udp 2122260223 100.101.102.103 47810 typ host generation 0',
  'a=candidate:2 1 udp 2122194687 192.168.1.20 47811 typ host generation 0',
  'a=candidate:3 1 udp 2122129151 fd7a:115c:a1e0::1234 47812 typ host generation 0',
  'a=candidate:4 1 udp 2122063615 3f2a1c4e-aaaa-bbbb-cccc-0123456789ab.local 47813 typ host generation 0',
  'a=candidate:5 1 udp 1686052607 203.0.113.9 47814 typ srflx raddr 0.0.0.0 rport 0',
  'a=end-of-candidates',
  '',
].join('\r\n');

test('validateSignal: offers only, sizes, ICE shapes', async () => {
  const { validateSignal } = await loadV();
  assert.deepEqual(validateSignal({ t: 'sdp', description: { type: 'offer', sdp: OFFER_SDP } }),
    { t: 'sdp', description: { type: 'offer', sdp: OFFER_SDP } });
  assert.equal(validateSignal({ t: 'sdp', description: { type: 'answer', sdp: OFFER_SDP } }), null);
  assert.equal(validateSignal({ t: 'sdp', description: { type: 'offer', sdp: 'x' } }), null);
  assert.equal(validateSignal({ t: 'sdp', description: { type: 'offer', sdp: `v=0${'a'.repeat(1024 * 1024)}` } }), null);
  assert.equal(validateSignal({ t: 'sdp' }), null);
  assert.deepEqual(validateSignal({ t: 'ice', candidate: null }), { t: 'ice', candidate: null });
  assert.deepEqual(validateSignal({ t: 'ice' }), { t: 'ice', candidate: null });
  const c = { candidate: 'candidate:1 1 udp 1 100.64.0.1 47801 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd', extra: 'x' };
  assert.deepEqual(validateSignal({ t: 'ice', candidate: c }),
    { t: 'ice', candidate: { candidate: c.candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' } });
  assert.equal(validateSignal({ t: 'ice', candidate: { candidate: c.candidate } }), null); // no mid / mline
  assert.deepEqual(validateSignal({ t: 'ice', candidate: { candidate: '' } }).candidate.candidate, '');
  assert.equal(validateSignal({ t: 'ice', candidate: { candidate: 5 } }), null);
  assert.equal(validateSignal({ t: 'ice', candidate: { ...c, sdpMLineIndex: -1 } }), null);
  assert.equal(validateSignal({ t: 'ice', candidate: { ...c, sdpMid: 7 } }), null);
  assert.equal(validateSignal({ t: 'ice', candidate: { ...c, candidate: 'x'.repeat(5000) } }), null);
  assert.equal(validateSignal({ t: 'bye' }), null);
  assert.equal(validateSignal(null), null);
  assert.equal(validateSignal([]), null);
});

test('sanitizeSdp + rtc.isAllowedCandidate keep only Tailscale candidates', async () => {
  const { sanitizeSdp } = await loadV();
  const { isAllowedCandidate } = await loadRtc();
  const out = sanitizeSdp(OFFER_SDP, isAllowedCandidate);
  assert.match(out, /100\.101\.102\.103/);
  assert.match(out, /fd7a:115c:a1e0::1234/);
  assert.doesNotMatch(out, /192\.168\.1\.20/);
  assert.doesNotMatch(out, /\.local/);
  assert.doesNotMatch(out, /203\.0\.113\.9/);
  assert.match(out, /a=end-of-candidates/);
  assert.ok(out.endsWith('\r\n'), 'trailing CRLF preserved');
  assert.ok(!/[^\r]\n/.test(out), 'CRLF line endings');
  // a throwing predicate drops the line instead of crashing
  assert.doesNotMatch(sanitizeSdp(OFFER_SDP, () => { throw new Error('x'); }), /a=candidate/);
  assert.equal(sanitizeSdp(null, isAllowedCandidate), '');
});

test('validateControl: displays', async () => {
  const { validateControl } = await loadV();
  const msg = validateControl({
    t: 'displays',
    current: '2',
    displays: [
      { id: '1', name: 'Built-in', primary: true, width: 2880, height: 1800, scaleFactor: 2 },
      { id: 2, name: 'Dell‮evil', primary: false, width: 1920.4, height: 1080, scaleFactor: 99 },
      { id: '1', name: 'dup' },
      { id: 'x'.repeat(200), name: 'too long id' },
      { id: {}, name: 'bad' },
      'junk',
    ],
  });
  assert.equal(msg.t, 'displays');
  assert.equal(msg.displays.length, 2);
  assert.deepEqual(msg.displays[0], { id: '1', name: 'Built-in', primary: true, width: 2880, height: 1800, scaleFactor: 2 });
  assert.deepEqual(msg.displays[1], { id: '2', name: 'Dellevil', primary: false, width: 1920, height: 1080, scaleFactor: 1 });
  assert.equal(msg.current, '2');
  assert.equal(validateControl({ t: 'displays', displays: [{ id: '1' }], current: '9' }).current, null);
  assert.equal(validateControl({ t: 'displays', displays: [{ id: 'a' }] }).displays[0].name, 'Display 1');
  assert.equal(validateControl({ t: 'displays', displays: 'nope' }), null);
  const many = validateControl({ t: 'displays', displays: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) });
  assert.equal(many.displays.length, 32);
});

test('validateControl: clipboard, chat, host-state, unknown', async () => {
  const { validateControl } = await loadV();
  assert.deepEqual(validateControl({ t: 'clipboard', kind: 'text', text: 'hi\u0000there' }), { t: 'clipboard', kind: 'text', text: 'hi\u0000there' });
  assert.equal(validateControl({ t: 'clipboard', kind: 'image', text: 'x' }), null);
  assert.equal(validateControl({ t: 'clipboard', kind: 'text', text: 'x'.repeat(P.CONTROL.MAX_CLIPBOARD_TEXT + 1) }), null);

  const chat = validateControl({ t: 'chat', text: '  hello\r\nworld‮!\u0007  ', ts: 123 });
  assert.deepEqual(chat, { t: 'chat', text: 'hello\nworld!', ts: 123 });
  assert.equal(validateControl({ t: 'chat', text: '   ' }), null);
  assert.equal(validateControl({ t: 'chat', text: 'x'.repeat(P.CONTROL.MAX_CHAT + 1) }), null);
  assert.equal(validateControl({ t: 'chat', text: 'ok', ts: 'soon' }).ts, null);

  assert.deepEqual(validateControl({ t: 'host-state', audio: false, controlAllowed: true }), { t: 'host-state', audio: false, controlAllowed: true });
  assert.deepEqual(validateControl({ t: 'host-state', audio: 'yes' }), { t: 'host-state' });
  // inputBlocked: null | 'secure-desktop' | 'elevated-window'; anything else is dropped (field absent).
  assert.equal(validateControl({ t: 'host-state', inputBlocked: 'secure-desktop' }).inputBlocked, 'secure-desktop');
  assert.equal(validateControl({ t: 'host-state', inputBlocked: 'elevated-window' }).inputBlocked, 'elevated-window');
  assert.deepEqual(validateControl({ t: 'host-state', inputBlocked: null }), { t: 'host-state', inputBlocked: null });
  for (const bad of ['uac', '', true, 1, {}, undefined]) {
    assert.equal('inputBlocked' in validateControl({ t: 'host-state', inputBlocked: bad }), false, String(bad));
  }

  assert.equal(validateControl({ t: 'select-display', id: '1' }), null); // V→H only
  assert.equal(validateControl({ t: 'quality', preset: 'speed' }), null);
  assert.equal(validateControl({ t: 'whatever' }), null);
  assert.equal(validateControl(null), null);
});

test('normalizeStatus / normalizePermissions / normalizeInit', async () => {
  const { normalizeStatus, normalizePermissions, normalizeInit } = await loadV();
  assert.equal(normalizeStatus({ phase: 'streaming' }), null);
  assert.equal(normalizeStatus(null), null);
  const hello = normalizeStatus({ phase: 'hello', host: { hostname: 'mac‮book', os: 'macos', user: { login: 'a@b', displayName: 'A' }, passwordSet: 1, acceptMode: 'weird' } });
  assert.deepEqual(hello.host, { hostname: 'macbook', os: 'macos', user: { login: 'a@b', displayName: 'A' }, passwordSet: false, acceptMode: 'ask' });
  assert.equal(normalizeStatus({ phase: 'auth-required', remaining: 2 }).remaining, 2);
  assert.equal(normalizeStatus({ phase: 'auth-required', remaining: -1 }).remaining, undefined);
  assert.equal(normalizeStatus({ phase: 'auth-required', remaining: 1.5 }).remaining, undefined);
  const acc = normalizeStatus({ phase: 'accepted', sessionId: 's1', permissions: { control: true, files: 'yes' } });
  assert.deepEqual(acc.permissions, { control: true, clipboard: false, files: false, audio: false });
  assert.equal(normalizeStatus({ phase: 'closed', reason: 'denied:busy', message: 'x' }).reason, 'denied:busy');
  assert.equal(normalizeStatus({ phase: 'closed', reason: '<script>' }).reason, 'network');
  assert.equal(normalizeStatus({ phase: 'closed' }).reason, 'network');
  assert.equal(normalizeStatus({ phase: 'closed', reason: 'Host-Ended' }).reason, 'host-ended');
  // hostReason: the host's own bye reason, sanitized like `reason`; only for 'closed'.
  const ended = normalizeStatus({ phase: 'closed', reason: 'host-ended', hostReason: 'capture-failed', message: 'm' });
  assert.equal(ended.hostReason, 'capture-failed');
  assert.equal(normalizeStatus({ phase: 'closed', reason: 'host-ended', hostReason: 'Host-Stopped' }).hostReason, 'host-stopped');
  assert.equal('hostReason' in normalizeStatus({ phase: 'closed', reason: 'host-ended' }), false);
  assert.equal('hostReason' in normalizeStatus({ phase: 'closed', reason: 'host-ended', hostReason: '<b>x' }), false);
  assert.equal('hostReason' in normalizeStatus({ phase: 'closed', reason: 'host-ended', hostReason: 42 }), false);
  assert.equal('hostReason' in normalizeStatus({ phase: 'closed', reason: 'host-ended', hostReason: '' }), false);
  assert.equal('hostReason' in normalizeStatus({ phase: 'hello', hostReason: 'capture-failed' }), false);

  assert.deepEqual(normalizePermissions(undefined), { control: false, clipboard: false, files: false, audio: false });
  assert.deepEqual(normalizePermissions({ control: true, clipboard: true, files: true, audio: true, x: true }),
    { control: true, clipboard: true, files: true, audio: true });

  const def = normalizeInit(null);
  assert.equal(def.localOs, 'windows');
  assert.equal(def.viewOnly, false);
  assert.deepEqual(def.settings, { quality: 'balanced', codec: 'auto', clipboardSync: true, swapCmdCtrl: 'auto' });
  assert.equal(def.target.port, P.DEFAULT_PORT);
  const init = normalizeInit({
    target: { ip: '100.64.0.5', port: 47800, hostname: 'desk', os: 'windows', user: { login: '', displayName: '' } },
    localOs: 'macos', viewOnly: true, settings: { quality: 'speed', codec: 'vp9', clipboardSync: false, swapCmdCtrl: 'on' },
  });
  assert.equal(init.target.user, null);
  assert.equal(init.localOs, 'macos');
  assert.equal(init.viewOnly, true);
  assert.deepEqual(init.settings, { quality: 'speed', codec: 'vp9', clipboardSync: false, swapCmdCtrl: 'on' });
});

test('cleanLabel strips spoofing characters and caps length', async () => {
  const { cleanLabel, cleanMultiline } = await loadV();
  assert.equal(cleanLabel('evil‮gpj.exe'), 'evilgpj.exe');
  assert.equal(cleanLabel('a​b\u0000c⁦d'), 'abcd');
  assert.equal(cleanLabel('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
  assert.equal(cleanLabel('😀'.repeat(20), 5), `${'😀'.repeat(4)}…`);
  assert.equal(cleanLabel(null), '');
  assert.equal(cleanMultiline('a\r\nb\tc\u0001', 100), 'a\nb\tc');
});

test('describeClose covers every contract reason with specific text', async () => {
  const { describeClose } = await loadR();
  const ctx = { host: 'office-pc', user: 'Nong', hadVideo: true };
  const generic = describeClose('something-new', ctx);
  assert.equal(generic.title, 'Session ended');
  const genericDenied = describeClose('denied:something-new', ctx);
  assert.equal(genericDenied.title, 'Request denied');
  const reasons = [
    'unreachable', 'not-tunnelview', 'timeout', 'protocol', 'host-ended', 'network', 'non-tailnet-path', 'not-tailnet',
    'media-failed', 'media-timeout', 'reconnect-failed', 'init-failed', 'local', 'viewer-closed',
    ...Object.values(P.DENY).map((d) => `denied:${d}`),
    'denied:try-later', 'denied:suspended', // net's new DENY.TRY_LATER / DENY.SUSPENDED, even before protocol.js has them
    'rate-limited', 'not-tailnet-route', // viewer-client: HTTP 429; local address not a Tailscale IP
  ];
  for (const r of reasons) {
    const d = describeClose(r, ctx);
    assert.ok(d.title && d.message, r);
    assert.ok(['danger', 'warn', 'info'].includes(d.tone), r);
    assert.ok(typeof d.icon === 'string' && d.icon, r);
    if (r !== 'host-ended' && r !== 'local' && r !== 'viewer-closed') {
      assert.notEqual(`${d.title}|${d.message}`, `${generic.title}|${generic.message}`, `${r} must not fall back to the generic text`);
      assert.notEqual(`${d.title}|${d.message}`, `${genericDenied.title}|${genericDenied.message}`, `${r} must not fall back to the generic denial text`);
    }
  }
  assert.match(describeClose('denied:rejected', ctx).message, /Nong/);
  assert.match(describeClose('denied:busy', ctx).title, /office-pc/);
  assert.equal(describeClose('denied:new-reason', ctx).title, 'Request denied');
  assert.notEqual(describeClose('network', { ...ctx, hadVideo: false }).message, describeClose('network', ctx).message);
  assert.ok(describeClose(undefined, {}).message.includes('the remote device'));
});

test('host reasons: effectiveCloseReason + describeClose for every HOST_REASONS entry', async () => {
  const { describeClose, effectiveCloseReason, HOST_REASONS } = await loadR();
  const ctx = { host: 'studio-mac', user: 'Nong', hadVideo: true };
  const expected = [
    'capture-failed', 'capture-ended', 'capture-blocked', 'connection-lost', 'connection-failed', 'connection-timeout',
    'negotiation-failed', 'media-failed', 'setup-failed', 'non-tailnet-path', 'host-stopped', 'host-ended',
  ];
  assert.deepEqual([...HOST_REASONS].sort(), [...expected].sort());

  // Only a 'host-ended' close is refined, and only with a known host reason.
  assert.equal(effectiveCloseReason('host-ended', 'capture-failed'), 'capture-failed');
  assert.equal(effectiveCloseReason('host-ended', 'non-tailnet-path'), 'non-tailnet-path');
  assert.equal(effectiveCloseReason('host-ended', 'viewer-closed'), 'host-ended');
  assert.equal(effectiveCloseReason('host-ended', 'something-new'), 'host-ended');
  assert.equal(effectiveCloseReason('host-ended', undefined), 'host-ended');
  assert.equal(effectiveCloseReason('network', 'capture-failed'), 'network');
  assert.equal(effectiveCloseReason('denied:busy', 'host-stopped'), 'denied:busy');

  const ended = describeClose('host-ended', ctx);
  assert.equal(ended.message, 'studio-mac ended the session.');
  for (const r of HOST_REASONS) {
    const d = describeClose(r, ctx);
    assert.ok(d.title && d.message && d.icon, r);
    assert.ok(['danger', 'warn', 'info'].includes(d.tone), r);
    if (r !== 'host-ended') assert.notEqual(d.message, ended.message, `${r} must not say "${ended.message}"`);
  }
  for (const r of ['capture-failed', 'capture-ended']) {
    const d = describeClose(r, ctx);
    assert.equal(d.title, 'Screen sharing failed');
    assert.match(d.message, /studio-mac couldn't share its screen/);
    assert.match(d.message, /Privacy & Security › Screen Recording/);
  }
  assert.match(describeClose('capture-blocked', ctx).message, /studio-mac is waiting for someone at that Mac to allow screen recording/);
  assert.equal(describeClose('host-stopped', ctx).message, 'Tailscale stopped or incoming connections were turned off on studio-mac.');
  assert.deepEqual(describeClose('connection-lost', { ...ctx, hadVideo: false }), describeClose('network', { ...ctx, hadVideo: true }));
  const mediaFailed = describeClose('media-failed', ctx);
  assert.match(mediaFailed.message, /UDP 47801–47899/);
  for (const r of ['connection-failed', 'connection-timeout', 'negotiation-failed', 'setup-failed']) {
    assert.deepEqual(describeClose(r, ctx), mediaFailed, r);
  }
  assert.equal(describeClose('non-tailnet-path', ctx).title, 'Stopped to protect your session');
});

test('denial texts: password-required without a password, auth-timeout, not-allowed', async () => {
  const { describeClose } = await loadR();
  const ctx = { host: 'office-pc', user: '' };
  const noPw = describeClose('denied:password-required', { ...ctx, passwordSet: false });
  assert.match(noPw.message, /no password has been set there yet/);
  assert.match(noPw.message, /'Ask every time'/);
  assert.doesNotMatch(noPw.message, /enter it when asked/);
  for (const passwordSet of [true, undefined]) {
    assert.match(describeClose('denied:password-required', { ...ctx, passwordSet }).message, /enter it when asked/);
  }
  const authTimeout = describeClose('denied:auth-timeout', ctx);
  assert.equal(authTimeout.title, 'Password prompt timed out');
  assert.equal(authTimeout.message, "The password wasn't entered in time. Reconnect to try again.");
  assert.doesNotMatch(authTimeout.message, /Nobody accepted/);
  assert.match(describeClose('denied:not-allowed', ctx).message, /isn't on its list. Ask its owner to add you under Who can connect/);
});

test('denial texts: try-later (prompt back-off), suspended (host-wide), locked (device or account)', async () => {
  const { describeClose } = await loadR();
  const ctx = { host: 'office-pc', user: 'Nong' };
  if (P.DENY.TRY_LATER !== undefined) assert.equal(P.DENY.TRY_LATER, 'try-later');
  if (P.DENY.SUSPENDED !== undefined) assert.equal(P.DENY.SUSPENDED, 'suspended');

  // The wait comes from main's status message (viewer-client DENY_TEXT + retryText) and is said
  // once, in the message itself; no detail line repeating the same sentence.
  const later = describeClose('denied:try-later', { ...ctx, message: 'The remote device recently declined or did not answer a request from this device. Try again in 29 seconds.' });
  assert.deepEqual(later, {
    tone: 'warn', icon: 'clock', title: 'Try again later',
    message: "office-pc isn't taking new requests from this device right now: a recent request was declined or not answered there, or this device asked several times in a few minutes. Try again in 29 seconds.",
    detail: '',
  });
  assert.equal(later.message.split('Try again in 29 seconds.').length - 1, 1, 'the wait is stated exactly once');
  assert.match(later.message, /asked several times/, 'the prompt rate limit (withdrawn requests) is covered too');
  assert.doesNotMatch(later.message, /Nong|declined your request/, 'nobody is blamed for declining');
  for (const [msg, wait] of [
    ['… Try again in 1 second.', 'Try again in 1 second.'],
    ['… Try again in about 10 minutes.', 'Try again in about 10 minutes.'],
    ['', 'Try again in a few minutes.'], // no wait known (e.g. message cut off)
  ]) {
    const d = describeClose('denied:try-later', { ...ctx, message: msg });
    assert.ok(d.message.endsWith(` ${wait}`), `${msg} → ${d.message}`);
    assert.equal(d.detail, '');
  }
  assert.ok(describeClose('denied:try-later', undefined).message.endsWith('Try again in a few minutes.'));

  const suspended = describeClose('denied:suspended', ctx);
  assert.deepEqual(suspended, {
    tone: 'warn', icon: 'lock', title: 'Passwords paused on office-pc',
    message: 'office-pc has stopped accepting passwords for up to 15 minutes after many failed attempts from several devices. Trusted devices, and requests the person there accepts, still work.',
  });
  assert.doesNotMatch(suspended.message, /from this device/, 'a host-wide pause does not blame this device');

  const locked = describeClose('denied:locked', {
    ...ctx, message: 'Too many failed password attempts from this device or your Tailscale account. Try again in 15 minutes.',
  });
  assert.deepEqual(locked, {
    tone: 'danger', icon: 'lock', title: 'Temporarily locked',
    message: 'Too many failed password attempts from this device or your Tailscale account (tagged devices share one limit). Try again in 15 minutes.',
    detail: '',
  });
  assert.equal(describeClose('denied:locked', ctx).message, locked.message, 'without a message: 15 minutes');
  assert.equal(describeClose('denied:locked', ctx).detail, '');
  assert.notEqual(describeClose('denied:rejected', ctx).title, later.title);

  // Every other reason has no `detail` of its own: main's status message stays the detail line.
  for (const r of ['denied:rejected', 'denied:busy', 'denied:suspended', 'not-tailnet', 'not-tailnet-route', 'unreachable', 'network']) {
    assert.ok(!('detail' in describeClose(r, { ...ctx, message: 'x' })), r);
  }
});

test('retrySentence: the wait from main\'s denial message', async () => {
  const { retrySentence } = await loadR();
  assert.equal(retrySentence('The remote device recently declined … Try again in 29 seconds.'), 'Try again in 29 seconds.');
  assert.equal(retrySentence('… Try again in about 3 minutes.'), 'Try again in about 3 minutes.');
  assert.equal(retrySentence('Too many connection attempts from this device. Try again in a minute.'), 'Try again in a minute.');
  assert.equal(retrySentence('No wait here.'), '');
  assert.equal(retrySentence(undefined), '');
  assert.equal(retrySentence({ toString: () => 'Try again in 1 second.' }), '', 'strings only');
});

test('new closed reasons: rate-limited (HTTP 429) and not-tailnet-route (local address not on Tailscale)', async () => {
  const { describeClose } = await loadR();
  const ctx = { host: 'studio', user: 'Nong', message: 'Too many connection attempts from this device. Try again in a minute.' };
  const rl = describeClose('rate-limited', ctx);
  assert.deepEqual(rl, {
    tone: 'warn', icon: 'clock', title: 'Too many attempts',
    message: 'This device tried to connect to studio too often. Wait a minute and try again.', detail: '',
  });
  assert.notEqual(rl.title, describeClose('denied:locked', ctx).title, 'not a password lock');
  assert.doesNotMatch(rl.message, /password/);

  const route = describeClose('not-tailnet-route', { ...ctx, message: 'The connection did not go through Tailscale (local address 192.168.1.5), so Tunnelview stopped before sending anything.' });
  assert.equal(route.title, "Connection didn't go through Tailscale");
  assert.equal(route.tone, 'danger');
  assert.equal(route.icon, 'shield');
  assert.match(route.message, /^Your computer routed the connection to studio outside Tailscale/);
  assert.match(route.message, /100\.64\.0\.0\/10/);
  assert.notEqual(route.title, describeClose('not-tailnet', ctx).title, 'the host IS a tailnet device');
  assert.ok(!('detail' in route), 'the status message (with the local address) stays the detail line');
  for (const d of [rl, route]) {
    assert.notEqual(d.title, 'Session ended');
    assert.notEqual(d.title, 'Request denied');
  }
});

test('ask mode: a wrong password that turned into a request for approval keeps "attempts left" on the waiting card', async () => {
  const { admissionState, waitingView, waitingPasswordNote } = await import('../src/renderer/viewer/overlay.js');
  const { normalizeStatus } = await loadV();
  const base = { host: 'studio', ip: '100.64.0.2', port: 47800, os: 'macos', user: 'Nong' };
  const step = (prev, raw) => ({ ...prev, ...admissionState(prev, normalizeStatus(raw)) });

  // "Connect with password", wrong, host in ask mode: auth-failed (remaining 2) then pending.
  let st = { phase: 'connecting', remaining: undefined, passwordMode: false };
  for (const raw of [{ phase: 'connecting' }, { phase: 'hello' }, { phase: 'auth-required', remaining: 2 }, { phase: 'waiting', remaining: 2 }]) {
    st = step(st, raw);
  }
  assert.deepEqual(st, { phase: 'waiting', remaining: 2, passwordMode: false });
  const view = waitingView(base, { passwordMode: st.passwordMode, passwordSet: true, remaining: st.remaining });
  assert.equal(view.kind, 'waiting');
  assert.equal(view.remaining, 2);
  assert.equal(view.passwordSet, true);
  assert.equal(view.host, 'studio');
  assert.equal(waitingPasswordNote(view.remaining), 'The password was incorrect (2 attempts left), so the request is waiting for approval instead.');

  // "Use password instead": the form gets the count as well ("Incorrect password. 2 attempts left.").
  st = { ...st, passwordMode: true };
  st = step(st, { phase: 'waiting' }); // a repeated status without the count keeps it
  assert.deepEqual(st, { phase: 'waiting', remaining: 2, passwordMode: true });
  const form = waitingView(base, { passwordMode: st.passwordMode, passwordSet: true, remaining: st.remaining });
  assert.equal(form.kind, 'password');
  assert.equal(form.fromWaiting, true);
  assert.equal(form.remaining, 2);

  // Wrong again from that form: auth-required (1 left) leaves "Use password instead".
  st = step(st, { phase: 'auth-required', remaining: 1 });
  assert.deepEqual(st, { phase: 'auth-required', remaining: 1, passwordMode: false });

  // No password tried: the plain waiting card, no count anywhere.
  const plain = step({ phase: 'hello', remaining: undefined, passwordMode: false }, { phase: 'waiting' });
  assert.equal(plain.remaining, undefined);
  const plainView = waitingView(base, { passwordMode: false, passwordSet: true, remaining: plain.remaining });
  assert.ok(!('remaining' in plainView));
  assert.ok(!('remaining' in waitingView(base, { passwordMode: true, passwordSet: true, remaining: undefined })));
  assert.equal(waitingPasswordNote(undefined), '');

  // A new connection (Reconnect) starts without it.
  assert.deepEqual(admissionState({ remaining: 2, passwordMode: true }, { phase: 'connecting' }), { phase: 'connecting', remaining: undefined, passwordMode: false });
  assert.deepEqual(admissionState({ remaining: 2, passwordMode: true }, { phase: 'hello' }), { phase: 'hello', remaining: undefined, passwordMode: false });

  assert.equal(waitingPasswordNote(1), 'The password was incorrect (1 attempt left), so the request is waiting for approval instead.');
  assert.equal(waitingPasswordNote(0), 'The password was incorrect, so the request is waiting for approval instead.');
  assert.equal(waitingPasswordNote(-1), '');
  assert.equal(waitingPasswordNote(1.5), '');
});

test('controlBlockReason: no control while recovering or while the video is stalled', async () => {
  const { controlBlockReason } = await loadR();
  const ok = { control: true, controlAllowed: true, unstable: false, videoStalled: false, inputOpen: true, host: 'office-pc' };
  assert.equal(controlBlockReason(ok), '');
  assert.equal(controlBlockReason({ ...ok, controlAllowed: undefined }), '', 'host-state not received yet');
  assert.equal(controlBlockReason({ ...ok, unstable: true }), 'the connection is recovering');
  assert.equal(controlBlockReason({ ...ok, videoStalled: true }), 'the video is stalled');
  assert.equal(controlBlockReason({ ...ok, control: false, unstable: true }), 'the host turned remote control off');
  assert.equal(controlBlockReason({ ...ok, controlAllowed: false, unstable: true }), "input isn't available on office-pc");
  assert.equal(controlBlockReason({ ...ok, unstable: true, videoStalled: true }), 'the connection is recovering');
  assert.equal(controlBlockReason({ ...ok, inputOpen: false }), 'the input channel is not ready');
  assert.equal(controlBlockReason({ ...ok, unstable: true, inputOpen: false }), 'the connection is recovering',
    'the channel stays open during an ICE outage anyway');
  // Recovery ('connected' clears unstable / frames decoded again) gives control back by itself.
  assert.equal(controlBlockReason({ ...ok, unstable: false, videoStalled: false }), '');
});

test('decoder stall watchdog: inboundVideoSample + DecoderStallDetector', async () => {
  const { inboundVideoSample, DecoderStallDetector, DECODER_STALL_MS } = await import('../src/renderer/viewer/stats.js');
  assert.equal(DECODER_STALL_MS, 1000);
  const report = new Map([
    ['IT01V', { id: 'IT01V', type: 'inbound-rtp', kind: 'video', bytesReceived: 10, framesReceived: 5, framesDecoded: 4 }],
    ['IT02V', {
      id: 'IT02V', type: 'inbound-rtp', kind: 'video', bytesReceived: 9000, framesReceived: 220, framesDecoded: 18,
      keyFramesDecoded: 1, pliCount: 11, freezeCount: 1, totalDecodeTime: 0.075, decoderImplementation: 'ExternalDecoder (D3D11VideoDecoder)',
    }],
    ['IT03A', { id: 'IT03A', type: 'inbound-rtp', kind: 'audio', bytesReceived: 99999 }],
  ]);
  assert.deepEqual(inboundVideoSample(report), {
    id: 'IT02V', framesReceived: 220, framesDecoded: 18, keyFramesDecoded: 1, pliCount: 11, freezeCount: 1,
    totalDecodeTime: 0.075, decoder: 'ExternalDecoder (D3D11VideoDecoder)',
  });
  // What Chromium actually gives the viewer page (runtime run d): no decoderImplementation.
  const real = inboundVideoSample(new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', framesReceived: 9, framesDecoded: 9, totalDecodeTime: 0.04 }]]));
  assert.equal(real.decoder, null);
  assert.equal(real.totalDecodeTime, 0.04);
  assert.equal(inboundVideoSample(new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', decoderImplementation: '' }]])).decoder, null);
  assert.equal(inboundVideoSample(new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', totalDecodeTime: -1 }]])).totalDecodeTime, null);
  assert.equal(inboundVideoSample(new Map()), null);
  assert.equal(inboundVideoSample(null), null);
  assert.equal(inboundVideoSample(new Map([['x', { id: 'x', type: 'inbound-rtp', mediaType: 'video', framesReceived: -1, framesDecoded: 'a' }]])).framesDecoded, null);

  // Runtime r8: framesDecoded stuck at 18 for 4.3 s while framesReceived rose 20 → 220 (250 ms samples).
  const d = new DecoderStallDetector();
  const smp = (t, fr, fd, pli) => ({ id: 'IT02V', framesReceived: fr, framesDecoded: fd, keyFramesDecoded: 1, pliCount: pli, freezeCount: 0, decoder: 'HW' });
  const events = [];
  let t = 0;
  for (let fd = 1; fd <= 18; fd++, t += 50) assert.equal(d.update(smp(t, fd + 1, fd, 0), t), null, 'healthy');
  let fr = 20;
  let pli = 0;
  const stuckFrom = t;
  for (; t <= stuckFrom + 4300; t += 250, fr += 12, pli = Math.min(11, pli + 1)) {
    const ev = d.update(smp(t, fr, 18, pli), t);
    if (ev) events.push({ ...ev, at: t - stuckFrom });
  }
  assert.equal(events.length, 1, 'one stall event');
  assert.equal(events[0].type, 'stalled');
  assert.ok(events[0].at >= 1000 && events[0].at <= 1250, `detected about 1 s into the stall (${events[0].at} ms)`);
  assert.equal(events[0].decoder, 'HW');
  assert.ok(events[0].framesReceivedDelta >= 3);
  assert.equal(d.stalled, true);
  const rec = d.update(smp(t, fr + 1, 19, 11), t);
  assert.equal(rec.type, 'recovered', 'framesDecoded advanced again');
  assert.ok(rec.durationMs >= 4300, `stall duration (${rec.durationMs})`);
  assert.equal(rec.pliDelta, 11);
  assert.equal(d.stalled, false);
  assert.equal(d.update(smp(t + 250, fr + 2, 20, 11), t + 250), null);

  // No false stall: static screen (no frames arriving), one dropped frame, slow frame rate, before the first frame.
  const quiet = new DecoderStallDetector();
  for (let i = 0; i <= 40; i++) assert.equal(quiet.update(smp(i * 250, 100 + (i > 4 ? 1 : 0), 99, 0), i * 250), null);
  const slow = new DecoderStallDetector();
  for (let i = 0; i <= 20; i++) assert.equal(slow.update(smp(i * 1000, 50 + i, 50 + i, 0), i * 1000), null);
  const first = new DecoderStallDetector();
  for (let i = 0; i <= 20; i++) assert.equal(first.update(smp(i * 250, i * 10, 0, i), i * 250), null, 'framesDecoded 0: still starting');

  // A replaced stream (new id / counters reset) ends a stall and starts over.
  const r = new DecoderStallDetector();
  r.update(smp(0, 10, 10, 0), 0);
  assert.equal(r.update(smp(1500, 40, 10, 0), 1500).type, 'stalled');
  assert.equal(r.update({ ...smp(1750, 2, 1, 0), id: 'NEW' }, 1750).type, 'recovered');
  assert.equal(r.stalled, false);
  assert.equal(r.update(null, 2000), null);
  assert.equal(r.update({ ...smp(2000, null, 1, 0), framesReceived: null }, 2000), null);
});

/**
 * Frames at `fps` arriving at each time in `arrivals`, each decoded `lagMs` later (Infinity = never);
 * the detector is sampled every `stepMs` from `phase` to `until`. → [{type, at}]
 */
function driveDetector(DecoderStallDetector, { arrivals, lagMs, phase = 0, stepMs = 500, until }) {
  const d = new DecoderStallDetector();
  const events = [];
  for (let now = phase; now <= until; now += stepMs) {
    const fr = arrivals.filter((a) => a <= now).length;
    const fd = arrivals.filter((a) => a + lagMs <= now).length;
    const ev = d.update({ id: 'v', framesReceived: fr, framesDecoded: fd, keyFramesDecoded: 1, pliCount: 0, freezeCount: 0, decoder: null }, now);
    if (ev) events.push({ ...ev, at: now });
  }
  return events;
}

const frameTimes = (from, to, fps = 60) => {
  const out = [];
  for (let t = from; t < to; t += 1000 / fps) out.push(t);
  return out;
};

test('decoder stall watchdog: frames resuming after a pause are not a stall (only frames arriving undecoded count)', async () => {
  const { DecoderStallDetector } = await import('../src/renderer/viewer/stats.js');
  // 1 s of video, 3 s with constant counters (static screen on Fast / ICE outage), then 60 fps
  // again with decoding 80 ms (… up to 950 ms, e.g. waiting for a keyframe) behind receipt; sampled
  // every 500 ms at many phases. Before the fix 2 % (45 ms), 9 % (80 ms) and 17 % (120 ms) of these
  // resumes were flagged as a stall (control off + release-all for ~0.5 s).
  let rnd = 12345;
  const random = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  const phases = [...Array.from({ length: 100 }, (_, i) => i * 5), ...Array.from({ length: 100 }, () => random() * 500)];
  for (const lagMs of [45, 80, 120, 300, 700, 950]) {
    for (const phase of phases) {
      for (const resumeAt of [4000, 4000 + random() * 500]) {
        const arrivals = [...frameTimes(0, 1000), ...frameTimes(resumeAt, resumeAt + 3000)];
        const events = driveDetector(DecoderStallDetector, { arrivals, lagMs, phase, until: resumeAt + 3000 });
        assert.deepEqual(events, [], `lag ${lagMs} ms, phase ${phase.toFixed(1)}, resume ${resumeAt.toFixed(1)}`);
      }
    }
  }

  // A decoder that really stops after such a pause is still caught: within 1–1.5 s of frames arriving undecoded.
  for (const phase of [0, 100, 250, 499]) {
    const arrivals = [...frameTimes(0, 1000), ...frameTimes(4000, 8000)];
    const resumed = 4000;
    const decodedUntil = 1000; // nothing after the pause is ever decoded
    const d = new DecoderStallDetector();
    let stalledAt = null;
    for (let now = phase; now <= 8000; now += 500) {
      const fr = arrivals.filter((a) => a <= now).length;
      const fd = arrivals.filter((a) => a < decodedUntil && a + 20 <= now).length;
      const ev = d.update({ id: 'v', framesReceived: fr, framesDecoded: fd, keyFramesDecoded: 1, pliCount: 0, freezeCount: 0, decoder: null }, now);
      if (ev && ev.type === 'stalled' && stalledAt === null) stalledAt = now;
    }
    assert.ok(stalledAt !== null, `phase ${phase}: stall detected`);
    assert.ok(stalledAt - resumed >= 1000 && stalledAt - resumed <= 1500, `phase ${phase}: detected ${stalledAt - resumed} ms after frames resumed`);
  }

  // Runtime r8 pattern (framesDecoded stuck, ~20 frames per 500 ms sample): flagged exactly 1000 ms
  // after the last decoded frame, then recovered as soon as a frame is decoded.
  const d = new DecoderStallDetector();
  const smp = (fr, fd) => ({ id: 'v', framesReceived: fr, framesDecoded: fd, keyFramesDecoded: 1, pliCount: fr, freezeCount: 0, decoder: null });
  assert.equal(d.update(smp(20, 18), 0), null);
  assert.equal(d.update(smp(40, 18), 500), null);
  const st = d.update(smp(60, 18), 1000);
  assert.equal(st.type, 'stalled');
  assert.equal(st.sinceMs, 1000);
  assert.equal(st.framesReceivedDelta, 40);
  assert.equal(d.update(smp(80, 18), 1500), null, 'reported once');
  const rec = d.update(smp(100, 19), 2000);
  assert.equal(rec.type, 'recovered');
  assert.equal(rec.durationMs, 2000);
  assert.equal(d.stalled, false);

  // A pause DURING a stall does not end it (only decoded frames do).
  const p = new DecoderStallDetector();
  p.update(smp(20, 18), 0);
  p.update(smp(40, 18), 500);
  assert.equal(p.update(smp(60, 18), 1000).type, 'stalled');
  for (let t = 1500; t <= 4000; t += 500) assert.equal(p.update(smp(60, 18), t), null);
  assert.equal(p.stalled, true);
  assert.equal(p.update(smp(61, 19), 4500).type, 'recovered');
});

test('decode time per frame and the stall log details (decoderImplementation is not exposed to the viewer)', async () => {
  const { decodeMsPerFrame, decoderLogInfo } = await import('../src/renderer/viewer/stats.js');
  const a = { id: 'v', framesDecoded: 100, totalDecodeTime: 0.5 };
  assert.equal(decodeMsPerFrame(a, { id: 'v', framesDecoded: 130, totalDecodeTime: 0.626 }).toFixed(1), '4.2');
  assert.equal(decodeMsPerFrame(a, { id: 'v', framesDecoded: 100, totalDecodeTime: 0.5 }), null, 'no frame decoded in between');
  assert.equal(decodeMsPerFrame(a, { id: 'w', framesDecoded: 130, totalDecodeTime: 0.6 }), null, 'stream replaced');
  assert.equal(decodeMsPerFrame(a, { id: 'v', framesDecoded: 130, totalDecodeTime: null }), null, 'not reported');
  assert.equal(decodeMsPerFrame(a, { id: 'v', framesDecoded: 90, totalDecodeTime: 0.6 }), null, 'counters went backwards');
  assert.equal(decodeMsPerFrame(null, a), null);

  const sample = { id: 'v', framesReceived: 60, framesDecoded: 18, keyFramesDecoded: 2, pliCount: 4, freezeCount: 3, totalDecodeTime: 1, decoder: null };
  const stalled = { type: 'stalled', sinceMs: 1000, framesDecoded: 18, framesReceivedDelta: 40, keyFramesDecoded: 2, pliDelta: 4, decoder: null };
  assert.deepEqual(decoderLogInfo(stalled, sample, 4.2345), {
    framesDecoded: 18, keyFramesDecoded: 2, freezeCount: 3, pliDelta: 4, decodeMsPerFrame: 4.2,
  }, 'no decoder: null when Chromium does not tell');
  assert.ok(!('decodeMsPerFrame' in decoderLogInfo(stalled, sample, null)));
  const known = decoderLogInfo({ type: 'recovered', durationMs: 900, framesDecoded: 19, pliDelta: 1, decoder: 'ExternalDecoder' }, { ...sample, decoder: 'ExternalDecoder' }, 3);
  assert.equal(known.decoder, 'ExternalDecoder');
  assert.equal(known.decodeMsPerFrame, 3);
});

test('watchInboundVideo polls getStats without overlap and stops (closed pc or stop())', async () => {
  const { watchInboundVideo } = await import('../src/renderer/viewer/stats.js');
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const pc = {
    signalingState: 'stable', connectionState: 'connected',
    async getStats() {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', bytesReceived: 1, framesReceived: calls, framesDecoded: calls }]]);
    },
  };
  const got = [];
  const stop = watchInboundVideo(pc, (s) => got.push(s), 100);
  await new Promise((r) => setTimeout(r, 420));
  assert.ok(got.length >= 2, `samples delivered (${got.length})`);
  assert.equal(maxInFlight, 1, 'polls never overlap');
  assert.equal(got[0].framesDecoded, 1);
  stop();
  const n = calls;
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(calls <= n + 1, 'stopped');

  const closed = { signalingState: 'closed', connectionState: 'closed', getStats: async () => { throw new Error('never'); } };
  const none = [];
  watchInboundVideo(closed, (s) => none.push(s), 100);
  await new Promise((r) => setTimeout(r, 180));
  assert.deepEqual(none, []);
});

test('clipboard parts: validation of the optional `part`', async () => {
  const { validateControl, validateClipboardPart } = await loadV();
  const part = { id: 'Ab_9-xyz', seq: 3, last: false };
  assert.deepEqual(validateControl({ t: 'clipboard', kind: 'text', text: 'abc', part }), { t: 'clipboard', kind: 'text', text: 'abc', part });
  assert.deepEqual(validateClipboardPart({ ...part, extra: 1 }), part);
  const bad = [
    null, 'x', [], { ...part, id: '' }, { ...part, id: 'a'.repeat(33) }, { ...part, id: 'a b' }, { ...part, id: 'é' }, { ...part, id: 5 },
    { ...part, seq: -1 }, { ...part, seq: 16 }, { ...part, seq: 1.5 }, { ...part, seq: '1' }, { ...part, last: 'true' }, { id: 'a', seq: 0 },
  ];
  for (const p of bad) {
    assert.equal(validateClipboardPart(p), null, JSON.stringify(p));
    assert.equal(validateControl({ t: 'clipboard', kind: 'text', text: 'abc', part: p }), null, JSON.stringify(p));
  }
  assert.equal(validateClipboardPart({ ...part, seq: 15 }).seq, 15);
  assert.equal(validateClipboardPart({ ...part, id: 'a'.repeat(32) }).id, 'a'.repeat(32));
  // a part carries non-empty text of at most CLIPBOARD_CHUNK_CHARS (40000) UTF-16 units
  assert.equal(validateControl({ t: 'clipboard', kind: 'text', text: '', part }), null);
  assert.equal(validateControl({ t: 'clipboard', kind: 'text', text: 'x'.repeat(40001), part }), null);
  assert.ok(validateControl({ t: 'clipboard', kind: 'text', text: 'x'.repeat(40000), part }));
  // without `part` the old single-message rules are unchanged
  assert.ok(validateControl({ t: 'clipboard', kind: 'text', text: 'x'.repeat(100000) }));
});

test('clipboardMessages: one message when it fits, ≤40000-unit parts otherwise', async () => {
  const { clipboardMessages, validateControl, newClipboardPartId } = await loadV();
  const { MAX_MESSAGE_BYTES } = await loadRtc();
  const bytes = (m) => Buffer.byteLength(JSON.stringify(m), 'utf8');

  assert.deepEqual(clipboardMessages('hello'), [{ t: 'clipboard', kind: 'text', text: 'hello' }]);
  assert.deepEqual(clipboardMessages(''), []);
  assert.deepEqual(clipboardMessages('x'.repeat(200001)), []);
  assert.equal(clipboardMessages('x'.repeat(200000)).length, 1, '200k ASCII fits in one 240 KB message');

  for (const id of [newClipboardPartId(), newClipboardPartId()]) assert.match(id, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(newClipboardPartId(), newClipboardPartId());

  // 90k Thai characters (3 UTF-8 bytes each) = 270 KB of JSON: must be split.
  const thai = 'สวัสดีครับ'.repeat(9000);
  const msgs = clipboardMessages(thai, { id: 'fixed-id' });
  assert.ok(msgs.length > 1 && msgs.length <= 16);
  assert.equal(msgs.map((m) => m.text).join(''), thai);
  msgs.forEach((m, i) => {
    assert.deepEqual(m.part, { id: 'fixed-id', seq: i, last: i === msgs.length - 1 });
    assert.ok(m.text.length > 0 && m.text.length <= 40000);
    assert.ok(bytes(m) <= MAX_MESSAGE_BYTES, 'each part fits in one data-channel message');
    assert.deepEqual(validateControl(JSON.parse(JSON.stringify(m))), m, 'the receiver accepts every part');
  });

  // Never splits a surrogate pair (emoji = 2 UTF-16 units); 199 998 units of emoji.
  const emoji = '😀'.repeat(99999);
  const parts = clipboardMessages(emoji);
  assert.equal(parts.map((m) => m.text).join(''), emoji);
  for (const m of parts) {
    assert.ok(!/^[\udc00-\udfff]/.test(m.text) && !/[\ud800-\udbff]$/.test(m.text), 'no lone surrogate at a part boundary');
    assert.ok(m.text.length <= 40000);
  }
  assert.equal(new Set(parts.map((m) => m.part.id)).size, 1, 'one id per text');

  // Worst case JSON escaping (control chars → \u00XX, 6 bytes each) still fits per part.
  const ctl = '\u0001'.repeat(200000);
  for (const m of clipboardMessages(ctl)) assert.ok(bytes(m) <= MAX_MESSAGE_BYTES);
});

test('ClipboardAssembler: strict order per id, resets, idle timeout, size cap', async () => {
  const { ClipboardAssembler, clipboardMessages } = await loadV();
  let now = 0;
  const asm = new ClipboardAssembler({ now: () => now });
  const text = 'ภาษาไทย'.repeat(20000); // 140 000 units, 420 KB UTF-8 → parts
  const msgs = clipboardMessages(text, { id: 'a1' });
  assert.ok(msgs.length >= 4);
  for (let i = 0; i < msgs.length - 1; i++) assert.equal(asm.push(msgs[i]), null);
  assert.equal(asm.push(msgs[msgs.length - 1]), text);

  // a gap discards the partial text; the rest of that text is ignored until a new seq 0
  assert.equal(asm.push(msgs[0]), null);
  assert.equal(asm.push(msgs[2]), null);
  assert.equal(asm.push(msgs[3]), null);
  for (let i = 0; i < msgs.length - 1; i++) asm.push(msgs[i]);
  assert.equal(asm.push(msgs[msgs.length - 1]), text, 'a fresh run from seq 0 still works');

  // a new id discards the old partial
  const other = clipboardMessages('ข'.repeat(90000), { id: 'b2' });
  asm.push(msgs[0]);
  asm.push(msgs[1]);
  let out = null;
  for (const m of other) out = asm.push(m);
  assert.equal(out, 'ข'.repeat(90000));
  assert.equal(asm.push(msgs[2]), null, 'the interrupted text never completes');

  // starting mid-way is ignored
  assert.equal(asm.push({ text: 'x', part: { id: 'zz', seq: 1, last: true } }), null);

  // more than 10 s between parts discards
  asm.push(msgs[0]);
  now += 10001;
  for (let i = 1; i < msgs.length - 1; i++) asm.push(msgs[i]);
  assert.equal(asm.push(msgs[msgs.length - 1]), null);
  now = 0;

  // reset() drops a partial
  asm.push(msgs[0]);
  asm.reset();
  assert.equal(asm.push(msgs[1]), null);

  // total above MAX_CLIPBOARD_TEXT (200 000) is refused even if every part is valid
  const big = Array.from({ length: 6 }, (_, seq) => ({ text: 'x'.repeat(40000), part: { id: 'cap', seq, last: seq === 5 } }));
  let res;
  for (const m of big) res = asm.push(m);
  assert.equal(res, null);
});

test('stats route/path formatting and the input-blocked banner text', async () => {
  const { formatRoute, formatPath } = await import('../src/renderer/viewer/stats.js');
  assert.equal(formatRoute({ local: '100.64.0.2', remote: '100.101.1.9', protocol: 'udp' }), 'Tailscale 100.64.0.2 ↔ 100.101.1.9 (udp)');
  assert.equal(formatRoute({ local: 'fd7a:115c:a1e0::1', remote: '100.64.0.9', protocol: 'UDP' }), 'Tailscale [fd7a:115c:a1e0::1] ↔ 100.64.0.9 (udp)');
  assert.equal(formatRoute({ local: null, remote: '100.64.0.9', protocol: null }), 'Tailscale ? ↔ 100.64.0.9');
  assert.equal(formatRoute(null), '—');
  assert.equal(formatRoute({ local: '<img>', remote: null }), '—');
  assert.equal(formatPath({ direct: true, relay: '' }), 'Direct');
  assert.equal(formatPath({ direct: false, relay: 'fra' }), 'Relayed via DERP (fra) — expect higher latency');
  assert.equal(formatPath({ direct: false, relay: '' }), 'Relayed via DERP — expect higher latency');
  assert.equal(formatPath({ direct: null, relay: 'fra' }), '—');
  assert.equal(formatPath(null), '—');

  const { inputBlockedMessage } = await import('../src/renderer/viewer/overlay.js');
  assert.equal(inputBlockedMessage('secure-desktop', 'office-pc'),
    'office-pc is showing a secure screen (administrator prompt or lock screen). The person at office-pc must handle it — remote input can\'t reach it.');
  assert.equal(inputBlockedMessage('elevated-window', 'office-pc'),
    'The window you\'re controlling on office-pc runs as administrator, so Tunnelview can\'t control it. Ask the person there to handle it.');
  assert.equal(inputBlockedMessage(null, 'office-pc'), '');
  assert.equal(inputBlockedMessage('other', 'office-pc'), '');
});
