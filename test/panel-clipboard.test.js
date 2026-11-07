'use strict';
/*
 * Chunked clipboard text on the control channel (host side): validate.js helpers and HostSession
 * sending / reassembling {t:'clipboard', kind:'text', text, part?:{id, seq, last}}.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.TunnelviewProtocol = require('../src/shared/protocol');
const C = globalThis.TunnelviewProtocol.CONTROL;

const loadV = () => import('../src/renderer/panel/validate.js');
const loadS = () => import('../src/renderer/panel/host-session.js');
const utf8Len = (s) => Buffer.byteLength(s, 'utf8');

test('sanitizeClipboard: plain and part messages', async () => {
  const { sanitizeClipboard } = await loadV();
  assert.deepEqual(sanitizeClipboard({ t: 'clipboard', kind: 'text', text: 'hi', extra: 1 }), { t: 'clipboard', kind: 'text', text: 'hi' });
  assert.equal(sanitizeClipboard({ t: 'clipboard', kind: 'text', text: '' }), null);
  assert.equal(sanitizeClipboard({ t: 'clipboard', kind: 'image', text: 'x' }), null);
  assert.equal(sanitizeClipboard({ t: 'clipboard', kind: 'text', text: 'x'.repeat(C.MAX_CLIPBOARD_TEXT + 1) }), null);
  const ok = { t: 'clipboard', kind: 'text', text: 'abc', part: { id: 'Abc_-9', seq: 3, last: false, x: 1 } };
  assert.deepEqual(sanitizeClipboard(ok), { t: 'clipboard', kind: 'text', text: 'abc', part: { id: 'Abc_-9', seq: 3, last: false } });
  const bad = [
    { id: '', seq: 0, last: true }, { id: 'a'.repeat(33), seq: 0, last: true }, { id: 'a b', seq: 0, last: true },
    { id: 'a', seq: -1, last: true }, { id: 'a', seq: 16, last: true }, { id: 'a', seq: 1.5, last: true },
    { id: 'a', seq: 0, last: 'yes' }, { id: 'a', seq: 0 }, [], 'part',
  ];
  for (const part of bad) assert.equal(sanitizeClipboard({ t: 'clipboard', kind: 'text', text: 'x', part }), null, JSON.stringify(part));
  assert.equal(sanitizeClipboard({ t: 'clipboard', kind: 'text', text: 'x'.repeat(40_001), part: { id: 'a', seq: 0, last: true } }), null);
});

test('splitClipboardText never splits a surrogate pair', async () => {
  const { splitClipboardText } = await loadV();
  const emoji = '😀'; // 2 UTF-16 units
  const text = `a${emoji.repeat(10)}`; // 21 units
  const parts = splitClipboardText(text, 4);
  assert.equal(parts.join(''), text);
  for (const p of parts) {
    assert.ok(p.length <= 4);
    assert.ok(!/[\ud800-\udbff]$/.test(p), 'no dangling high surrogate');
    assert.ok(!/^[\udc00-\udfff]/.test(p), 'no leading low surrogate');
  }
  assert.deepEqual(splitClipboardText('', 4), []);
  assert.deepEqual(splitClipboardText('abc', 40_000), ['abc']);
});

test('ClipboardAssembler: in-order parts, new id / gaps / idle / size discard the partial', async () => {
  const { ClipboardAssembler } = await loadV();
  let clock = 0;
  const asm = new ClipboardAssembler({ maxChars: 10, idleMs: 10_000, now: () => clock });
  const m = (id, seq, last, text) => ({ text, part: { id, seq, last } });
  assert.equal(asm.push(m('a', 0, false, 'he')), null);
  assert.equal(asm.push(m('a', 1, false, 'll')), null);
  assert.equal(asm.push(m('a', 2, true, 'o')), 'hello');
  // Out of order → discarded.
  assert.equal(asm.push(m('b', 0, false, 'x')), null);
  assert.equal(asm.push(m('b', 2, true, 'z')), null);
  assert.equal(asm.push(m('b', 1, true, 'y')), null, 'partial was dropped');
  // A new id discards the old partial.
  asm.push(m('c', 0, false, 'old'));
  assert.equal(asm.push(m('d', 1, true, 'x')), null);
  assert.equal(asm.push(m('c', 1, true, 'x')), null, 'c was discarded by d');
  // seq 0 of a new id restarts.
  asm.push(m('e', 0, false, 'aa'));
  asm.push(m('f', 0, false, 'bb'));
  assert.equal(asm.push(m('f', 1, true, 'cc')), 'bbcc');
  // Idle > 10 s → discarded.
  asm.push(m('g', 0, false, 'aa'));
  clock += 10_001;
  assert.equal(asm.push(m('g', 1, true, 'bb')), null);
  // Total above maxChars → discarded.
  asm.push(m('h', 0, false, '123456'));
  assert.equal(asm.push(m('h', 1, true, '78901')), null);
});

/* ---------------------------------------------------------------- HostSession wiring */

class FakeDC extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.sent = [];
    this.onmessage = null;
  }

  send(d) { this.sent.push(d); }

  close() { this.readyState = 'closed'; }

  deliver(obj) {
    const e = new Event('message');
    e.data = JSON.stringify(obj);
    this.dispatchEvent(e);
  }
}

function makeSession(HostSession) {
  const writes = [];
  const api = {
    endSession() {}, setClipboardSync() {}, releaseAll() {}, input() {}, sendSignal() {},
    writeClipboard: async (item) => { writes.push(item); return { ok: true }; },
    fileBegin: async () => ({ ok: false }), fileChunk() {}, fileEnd: async () => ({ ok: false }), fileAbort() {},
  };
  const s = new HostSession(api, {
    permissions: { control: false, clipboard: true, files: false, audio: false },
    input: { available: true, reason: null },
    settings: { quality: 'balanced', codec: 'auto', clipboardSync: true },
    audioSupported: false, displays: [], initialDisplayId: null, hostOs: 'windows',
  });
  // Only the control channel is exercised here (no RTCPeerConnection).
  s.ch.control = new FakeDC('control');
  s._wireControl();
  s.pathOk = true;
  s._updateClipboardSync();
  return { s, api, writes, ctl: s.ch.control, notices: [] };
}

test('host sends large CJK/Thai clipboard text in parts that each fit a data-channel message', async () => {
  const { HostSession } = await loadS();
  const { s, ctl } = makeSession(HostSession);
  const notices = [];
  s.addEventListener('notice', (e) => notices.push(e.detail));
  assert.equal(s.clipboardSyncActive, true);

  // Small text: one plain message.
  s.onLocalClipboard({ kind: 'text', text: 'hello' });
  assert.deepEqual(JSON.parse(ctl.sent.pop()), { t: 'clipboard', kind: 'text', text: 'hello' });

  const thai = 'กขค'.repeat(30_000); // 90 000 units, ~270 KB UTF-8: over the single-message limit
  s.onLocalClipboard({ kind: 'text', text: thai });
  assert.equal(notices.length, 0);
  const parts = ctl.sent.map((x) => JSON.parse(x));
  assert.equal(parts.length, 3);
  const id = parts[0].part.id;
  assert.match(id, /^[A-Za-z0-9]{16}$/);
  parts.forEach((p, i) => {
    assert.equal(p.t, 'clipboard');
    assert.equal(p.kind, 'text');
    assert.deepEqual(p.part, { id, seq: i, last: i === parts.length - 1 });
    assert.ok(p.text.length <= 40_000);
  });
  assert.equal(parts.map((p) => p.text).join(''), thai);
  for (const raw of ctl.sent) assert.ok(utf8Len(raw) < 262_144);

  // Worst case: 200 000 units that JSON-escape to \uXXXX each still fit per part.
  ctl.sent.length = 0;
  s.onLocalClipboard({ kind: 'text', text: '\u0001'.repeat(C.MAX_CLIPBOARD_TEXT) });
  assert.equal(ctl.sent.length, 5);
  for (const raw of ctl.sent) assert.ok(utf8Len(raw) < 262_144, `${utf8Len(raw)} bytes`);
  assert.equal(notices.length, 0);

  // Over MAX_CLIPBOARD_TEXT is still refused.
  ctl.sent.length = 0;
  s.onLocalClipboard({ kind: 'text', text: 'x'.repeat(C.MAX_CLIPBOARD_TEXT + 1) });
  assert.equal(ctl.sent.length, 0);
  assert.equal(notices.length, 1);
  s.end('test', { fromMain: true });
});

test('host reassembles the viewer\'s parts and writes the clipboard once, with the usual gates', async () => {
  const { HostSession } = await loadS();
  const { s, ctl, writes } = makeSession(HostSession);
  const text = '漢字'.repeat(50_000); // 100 000 units
  const pieces = [text.slice(0, 40_000), text.slice(40_000, 80_000), text.slice(80_000)];
  const send = (id, seq, t, last) => ctl.deliver({ t: 'clipboard', kind: 'text', text: t, part: { id, seq, last } });
  send('abc', 0, pieces[0], false);
  send('abc', 1, pieces[1], false);
  assert.equal(writes.length, 0);
  send('abc', 2, pieces[2], true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].text, text);

  // Permission revoked mid-way → nothing written, partial dropped.
  send('def', 0, 'aa', false);
  s.setPermissions({ control: false, clipboard: false, files: false, audio: false });
  send('def', 1, 'bb', true);
  s.setPermissions({ control: false, clipboard: true, files: false, audio: false });
  send('def', 1, 'bb', true);
  assert.equal(writes.length, 1);

  // Not verified on the tailnet → ignored.
  s.pathOk = false;
  ctl.deliver({ t: 'clipboard', kind: 'text', text: 'plain' });
  assert.equal(writes.length, 1);
  s.pathOk = true;
  ctl.deliver({ t: 'clipboard', kind: 'text', text: 'plain' });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].text, 'plain');
  s.end('test', { fromMain: true });
});

test('rate limiter counts whole messages and first parts only', async () => {
  const { HostSession } = await loadS();
  const { ctl, writes, s } = makeSession(HostSession);
  // A 10-part text uses one token (seq 0), so it completes even after the burst of plain messages.
  for (let i = 0; i < 7; i++) ctl.deliver({ t: 'clipboard', kind: 'text', text: `p${i}` });
  assert.equal(writes.length, 7);
  for (let seq = 0; seq < 10; seq++) ctl.deliver({ t: 'clipboard', kind: 'text', text: 'x', part: { id: 'big', seq, last: seq === 9 } });
  assert.equal(writes.length, 8);
  assert.equal(writes[7].text, 'x'.repeat(10));
  // Burst exhausted: further plain messages and new chunked texts are dropped.
  ctl.deliver({ t: 'clipboard', kind: 'text', text: 'dropped' });
  ctl.deliver({ t: 'clipboard', kind: 'text', text: 'y', part: { id: 'z', seq: 0, last: true } });
  assert.equal(writes.length, 8);
  s.end('test', { fromMain: true });
});
