'use strict';
/* src/renderer/panel/validate.js — input sanitizer (kd lock state) and end-of-session texts (view.js). */
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.TunnelviewProtocol = require('../src/shared/protocol');

const loadV = () => import('../src/renderer/panel/validate.js');
const loadView = () => import('../src/renderer/panel/view.js');

test('kd: locks {caps, num?} is copied when caps is a boolean', async () => {
  const { sanitizeInput } = await loadV();
  assert.deepEqual(sanitizeInput({ t: 'kd', code: 'KeyA', key: 'a', rep: false, locks: { caps: true, num: false } }),
    { t: 'kd', code: 'KeyA', key: 'a', rep: false, locks: { caps: true, num: false } });
  assert.deepEqual(sanitizeInput({ t: 'kd', code: 'KeyA', key: 'A', rep: true, locks: { caps: false } }),
    { t: 'kd', code: 'KeyA', key: 'A', rep: true, locks: { caps: false } });
  // num only when it is a boolean; extra fields dropped; result is a new object.
  const src = { caps: true, num: 'yes', scroll: true };
  const out = sanitizeInput({ t: 'kd', code: 'KeyB', key: 'b', locks: src });
  assert.deepEqual(out.locks, { caps: true });
  assert.notEqual(out.locks, src);
});

test('kd: malformed locks are omitted, the key event is still accepted', async () => {
  const { sanitizeInput } = await loadV();
  const base = { t: 'kd', code: 'KeyA', key: 'a', rep: false };
  for (const locks of [undefined, null, true, 'caps', 1, [], [true], {}, { caps: 'true' }, { caps: 1 }, { num: true }]) {
    assert.deepEqual(sanitizeInput({ ...base, locks }), base, JSON.stringify(locks));
  }
});

test('ku never carries locks; other input types unchanged', async () => {
  const { sanitizeInput } = await loadV();
  assert.deepEqual(sanitizeInput({ t: 'ku', code: 'KeyA', key: 'a', locks: { caps: true } }), { t: 'ku', code: 'KeyA', key: 'a' });
  assert.equal(sanitizeInput({ t: 'kd', code: 'Key A', locks: { caps: true } }), null);
  assert.deepEqual(sanitizeInput({ t: 'mm', x: 2, y: -1 }), { t: 'mm', x: 1, y: 0 });
});

test('end texts: viewer-reported reasons get their own message, own reasons keep theirs', async () => {
  const { endText } = await loadView();
  assert.equal(endText('non-tailnet-path', 'Ann', true), "Ann's viewer stopped the session: the video path left your Tailscale network.");
  assert.equal(endText('non-tailnet-path', 'Ann', false), 'Stopped: the connection was not on your Tailscale network.');
  assert.equal(endText('media-timeout', 'Ann', true), 'The video never reached Ann. Check that Tailscale ACLs allow UDP 47801–47899.');
  assert.equal(endText('media-failed', 'Ann', true), "Ann couldn't open the video connection.");
  assert.equal(endText('media-failed', 'Ann', false), 'Streaming failed.');
  assert.equal(endText('capture-blocked', 'Ann', false), 'macOS is waiting for someone at this Mac to allow screen recording.');
  assert.equal(endText('viewer-ended', 'Ann', true), 'Ann disconnected.');
  assert.equal(endText('host-ended', 'Ann', true), 'You ended the session.');
  assert.equal(endText('whatever', 'Ann', true), 'Session ended.');
});
