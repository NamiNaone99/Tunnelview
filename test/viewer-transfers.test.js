'use strict';
/*
 * Unit tests for the per-file consent step in src/renderer/viewer/transfers.js (TransfersDrawer):
 * a host can no longer write files to the viewer's disk without the viewer user's OK.
 * Uses a tiny fake DOM (just what ui.js h()/icon() and the drawer touch); no browser needed.
 * The same fake DOM also checks a few other viewer components' DOM output (stats overlay rows,
 * the overlay's waiting card).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/shared/protocol');

class FakeNode extends EventTarget {
  constructor() {
    super();
    this.parentNode = null;
    this.children = [];
  }

  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === globalThis.document.body;
  }

  remove() {
    if (!this.parentNode) return;
    const sib = this.parentNode.children;
    sib.splice(sib.indexOf(this), 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.nodeType = 3;
    this.data = text;
  }

  get textContent() { return this.data; }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.dataset = {};
    const cls = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
      contains: (c) => cls.has(c),
    };
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.scrollTop = 0;
  }

  set className(v) { for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c); }

  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === 'hidden') this.hidden = true;
    if (k === 'class') this.className = v;
  }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  appendChild(c) { this.append(c); return c; }

  append(...nodes) { for (const n of nodes) this.#insert(n, false); }

  prepend(...nodes) { for (const n of [...nodes].reverse()) this.#insert(n, true); }

  #insert(n, front) {
    const node = typeof n === 'string' ? new FakeText(n) : n;
    node.remove();
    node.parentNode = this;
    if (front) this.children.unshift(node);
    else this.children.push(node);
  }

  replaceChildren(...nodes) {
    for (const c of [...this.children]) c.remove();
    this.append(...nodes);
  }

  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    n.remove();
    p.children.splice(i, 1, n);
    n.parentNode = p;
    this.parentNode = null;
  }

  get childElementCount() { return this.children.filter((c) => c.nodeType === 1).length; }

  get firstElementChild() { return this.children.find((c) => c.nodeType === 1) || null; }

  get textContent() { return this.children.map((c) => c.textContent).join(''); }

  set textContent(v) {
    for (const c of [...this.children]) c.remove();
    if (v !== '' && v !== null && v !== undefined) this.append(String(v));
  }

  click() { this.dispatchEvent(new Event('click')); }

  focus() { globalThis.document.activeElement = this; }

  closest(sel) {
    const m = /^\[([\w-]+)\]$/.exec(sel);
    for (let n = this; n; n = n.parentNode) if (m && n.attrs && n.attrs.has(m[1])) return n;
    return null;
  }

  /** Depth-first descendants matching pred. */
  findAll(pred) {
    const out = [];
    for (const c of this.children) {
      if (c.nodeType !== 1) continue;
      if (pred(c)) out.push(c);
      out.push(...c.findAll(pred));
    }
    return out;
  }
}

globalThis.Node = FakeNode;
globalThis.window = globalThis;
globalThis.TunnelviewProtocol = P;
globalThis.document = {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  createElement: (t) => new FakeElement(t),
  createElementNS: (_ns, t) => new FakeElement(t),
  createTextNode: (s) => new FakeText(s),
  hasFocus: () => true,
};
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const load = () => import('../src/renderer/viewer/transfers.js');

class FakeFileTransfer extends EventTarget {
  constructor() {
    super();
    this.transfers = new Map();
  }

  emit(t) {
    this.transfers.set(t.id, t);
    this.dispatchEvent(Object.assign(new Event('update'), { detail: t }));
  }

  cancel() { return true; }
}

async function setup() {
  const { TransfersDrawer } = await load();
  const host = new FakeElement('div');
  globalThis.document.body.append(host);
  const td = new TransfersDrawer(host, {
    reveal: async () => {}, openFolder: async () => {}, pickFiles() {}, onBadge() {}, onClosed() {},
  });
  const ft = new FakeFileTransfer();
  td.attach(ft);
  const offer = (id, name = 'report.pdf') => ft.emit({ id, name, size: 2048, mime: '', direction: 'in', purpose: P.FILE.PURPOSE_FILE, state: 'offered', bytes: 0 });
  const cards = () => td.consentHost.children;
  const button = (card, label) => card.findAll((el) => el.tagName === 'BUTTON' && el.textContent.trim() === label)[0];
  return { td, ft, offer, cards, button };
}

test('consent card: sanitized text, Accept (+ accept all), Decline', async () => {
  const { td, offer, cards, button } = await setup();
  offer('t1', 'invoice‮fdp.exe');
  const p1 = td.requestConsent({ id: 't1', name: 'invoice‮fdp.exe', size: 2048, from: 'office​pc', timeoutMs: 5000 });
  assert.equal(cards().length, 1);
  const card = cards()[0];
  const text = card.textContent;
  assert.match(text, /officepc wants to send you invoicefdp\.exe \(2 KB\)/, 'bidi / zero-width characters stripped');
  assert.match(text, /Declined automatically after 5 seconds/);
  const box = card.findAll((el) => el.tagName === 'INPUT')[0];
  assert.equal(box.getAttribute('type'), 'checkbox');
  assert.match(card.textContent, /Accept all files for this session/);
  box.checked = true;
  button(card, 'Accept').click();
  assert.deepEqual(await p1, { accept: true, all: true });
  assert.equal(cards().length, 0, 'card removed once answered');

  offer('t2');
  const p2 = td.requestConsent({ id: 't2', name: 'a.txt', size: 1, from: 'office-pc' });
  button(cards()[0], 'Decline').click();
  assert.deepEqual(await p2, { accept: false, all: false });

  offer('t3');
  const p3 = td.requestConsent({ id: 't3', name: 'b.txt', size: 1, from: 'office-pc' });
  button(cards()[0], 'Accept').click(); // checkbox left unchecked
  assert.deepEqual(await p3, { accept: true, all: false });
  td.detach();
});

test('consent: declined on timeout, on cancel by either side, and when the session ends', async () => {
  const { td, ft, offer, cards } = await setup();
  offer('a');
  const timedOut = await td.requestConsent({ id: 'a', name: 'x.bin', size: 10, from: 'h', timeoutMs: 20 });
  assert.deepEqual(timedOut, { accept: false, all: false });
  assert.equal(cards().length, 0);

  offer('b');
  const pb = td.requestConsent({ id: 'b', name: 'x.bin', size: 10, from: 'h' });
  ft.emit({ ...ft.transfers.get('b'), state: 'cancelled', reason: 'peer-cancelled' });
  assert.deepEqual(await pb, { accept: false, all: false });
  assert.equal(cards().length, 0);

  offer('c');
  const pc = td.requestConsent({ id: 'c', name: 'x.bin', size: 10, from: 'h' });
  td.detach(); // session over
  assert.deepEqual(await pc, { accept: false, all: false });
  assert.equal(cards().length, 0);
});

test('offerAttention: a host file offer never takes the user out of the chat drawer', async () => {
  const { offerAttention } = await load();
  assert.equal(offerAttention({ chatOpen: true, transfersOpen: false }), 'notify', 'chat in use: toast only');
  assert.equal(offerAttention({ chatOpen: false, transfersOpen: false }), 'open-transfers');
  assert.equal(offerAttention({ chatOpen: false, transfersOpen: true }), 'none');
  assert.equal(offerAttention({ chatOpen: true, transfersOpen: true }), 'none');
});

test('drawers: close({restoreFocus:false}) reaches onClosed; focus() parks the keyboard on the local drawer', async () => {
  const { TransfersDrawer } = await load();
  const { ChatDrawer } = await import('../src/renderer/viewer/chat.js');
  const host = new FakeElement('div');
  globalThis.document.body.append(host);
  const closed = { chat: [], transfers: [] };
  const td = new TransfersDrawer(host, {
    reveal: async () => {}, openFolder: async () => {}, pickFiles() {}, onBadge() {},
    onClosed: (o) => closed.transfers.push(o),
  });
  const chat = new ChatDrawer(host, {
    send: () => true, peerName: () => 'Nong', onUnread() {}, notify() {}, onClosed: (o) => closed.chat.push(o),
  });

  const el = td.drawer.el;
  assert.equal(el.getAttribute('tabindex'), '-1', 'focusable container');
  assert.equal(el.getAttribute('data-local-keys'), '', 'keys typed in it stay local');
  td.focus();
  assert.notEqual(globalThis.document.activeElement, el, 'a closed drawer never takes focus');

  // The user is typing in the chat; switching drawers must not hand the keyboard to the remote.
  chat.open();
  chat.input.focus();
  chat.close({ restoreFocus: false });
  td.open();
  td.focus();
  assert.deepEqual(closed.chat, [{ restoreFocus: false }]);
  assert.equal(globalThis.document.activeElement, el, 'focus on the Transfers drawer itself');
  assert.equal(el.closest('[data-local-keys]'), el);
  assert.equal(td.drawer.el.inert, false);
  assert.equal(chat.drawer.el.inert, true);

  td.close();
  td.close(); // already closed: no second callback
  assert.deepEqual(closed.transfers, [{ restoreFocus: true }], 'a plain close gives the keyboard back');
  chat.open();
  chat.toggle();
  assert.deepEqual(closed.chat, [{ restoreFocus: false }, { restoreFocus: true }]);
});

test('pendingConsents counts offers still waiting; the offered row raises the Transfers badge', async () => {
  const { TransfersDrawer } = await load();
  const host = new FakeElement('div');
  globalThis.document.body.append(host);
  const badges = [];
  const td = new TransfersDrawer(host, {
    reveal: async () => {}, openFolder: async () => {}, pickFiles() {}, onBadge: (n) => badges.push(n), onClosed() {},
  });
  const ft = new FakeFileTransfer();
  td.attach(ft);
  assert.equal(td.pendingConsents, 0);
  ft.emit({ id: 'f1', name: 'a.txt', size: 1, mime: '', direction: 'in', purpose: P.FILE.PURPOSE_FILE, state: 'offered', bytes: 0 });
  assert.equal(badges.at(-1), 1, 'badge shows the waiting offer while the drawer is closed');
  const p = td.requestConsent({ id: 'f1', name: 'a.txt', size: 1, from: 'h', timeoutMs: 5000 });
  assert.equal(td.pendingConsents, 1);
  assert.equal(td.isOpen, false, 'requestConsent itself never opens the drawer');
  td.clearConsents();
  assert.deepEqual(await p, { accept: false, all: false });
  assert.equal(td.pendingConsents, 0);
  td.detach();
});

test('consent card and empty Transfers hint name the configured download folder, not a fixed Downloads/Tunnelview', async () => {
  const { td, offer, cards } = await setup();
  assert.match(td.empty.textContent, /saved to your Tunnelview download folder \(Settings › Files\)\./);
  offer('d1');
  const p = td.requestConsent({ id: 'd1', name: 'a.txt', size: 1, from: 'h', timeoutMs: 5000 });
  const text = cards()[0].textContent;
  assert.match(text, /Accepted files are saved to your Tunnelview download folder \(Settings › Files › Download folder\)\./);
  assert.doesNotMatch(`${text} ${td.empty.textContent}`, /Downloads\/Tunnelview/);
  td.detach();
  assert.deepEqual(await p, { accept: false, all: false });
});

test('stats overlay: Decode time row; the Decoder row only when Chromium names the decoder (never "—")', async () => {
  const { StatsOverlay } = await import('../src/renderer/viewer/stats.js');
  const so = new StatsOverlay(new FakeElement('div'));
  const terms = so.el.findAll((el) => el.tagName === 'DT');
  const term = (label) => terms.find((el) => el.textContent === label);
  assert.ok(term('Decode time') && term('Decoder'));
  const shown = (key, label) => !so.cells[key].hidden && !term(label).hidden;
  assert.equal(shown('decode', 'Decode time'), false, 'unknown until measured');
  assert.equal(shown('decoder', 'Decoder'), false, 'not exposed to the viewer page');

  so.setDecoder(null); // what every sample says in practice
  assert.equal(shown('decoder', 'Decoder'), false);
  so.setDecodeTime(4.2345);
  assert.equal(shown('decode', 'Decode time'), true);
  assert.equal(so.cells.decode.textContent, '4.2 ms/frame');
  so.setDecodeTime(null);
  assert.equal(shown('decode', 'Decode time'), false);
  so.setDecodeTime(12);
  so.setDecoder('ExternalDecoder (D3D11VideoDecoder)');
  assert.equal(shown('decoder', 'Decoder'), true);
  assert.equal(so.cells.decoder.textContent, 'ExternalDecoder (D3D11VideoDecoder)');
  so.setDecoder('');
  assert.equal(shown('decoder', 'Decoder'), false);

  so.reset(); // session over
  assert.equal(shown('decode', 'Decode time'), false);
  assert.equal(shown('decoder', 'Decoder'), false);
});

test('overlay waiting card: a wrong password that became a request for approval says so (text only)', async () => {
  const { Overlay } = await import('../src/renderer/viewer/overlay.js');
  const root = new FakeElement('div');
  root.querySelector = () => null; // no static boot card
  globalThis.document.body.append(root);
  const ov = new Overlay(root, {
    cancel() {}, submitPassword: async () => ({ ok: true }), usePassword() {}, backToWaiting() {}, reconnect() {}, close() {},
  });
  const base = { host: 'studio', ip: '100.64.0.2', port: 47800, os: 'macos', user: 'Nong' };
  const alerts = () => ov.card.findAll((el) => el.getAttribute('role') === 'alert');

  ov.show({ ...base, kind: 'waiting', passwordSet: true });
  assert.equal(alerts().length, 0, 'no password tried: plain waiting card');
  assert.match(ov.card.textContent, /Waiting for Nong to accept on studio…/);

  ov.show({ ...base, kind: 'waiting', passwordSet: true, remaining: 2 });
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].textContent, 'The password was incorrect (2 attempts left), so the request is waiting for approval instead.');
  assert.match(ov.card.textContent, /Use password instead/);

  // "Use password instead" → the form shows the count right away.
  ov.show({ ...base, kind: 'password', fromWaiting: true, remaining: 2 });
  const error = ov.card.findAll((el) => el.getAttribute('role') === 'alert' && el.classList.contains('ov-error'))[0];
  assert.equal(error.textContent, 'Incorrect password. 2 attempts left.');
  assert.match(ov.card.textContent, /Back to waiting for approval/);
  ov.hide();
  await new Promise((r) => setTimeout(r, 260)); // leave / hide timers
});
