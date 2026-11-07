'use strict';
/*
 * src/renderer/shared/transfer.js — binary frames carry a lane byte so a clipboard image does not
 * wait behind a running file transfer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.TunnelviewProtocol = require('../src/shared/protocol');
const F = globalThis.TunnelviewProtocol.FILE;
const LANE_FILE = Number.isInteger(F.LANE_FILE) ? F.LANE_FILE : 0;
const LANE_CLIP = Number.isInteger(F.LANE_CLIPBOARD) ? F.LANE_CLIPBOARD : 1;
const MiB = 1024 * 1024;

const load = () => import('../src/renderer/shared/transfer.js');
const tick = () => new Promise((r) => setImmediate(r));

/**
 * In-order delivery limited to `rate` bytes per event-loop turn (a link, not a memcpy), with a
 * bufferedAmount that drains as messages are delivered.
 */
class Chan extends EventTarget {
  constructor(rate = 256 * 1024) {
    super();
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'blob';
    this.onmessage = null;
    this.peer = null;
    this.rate = rate;
    this.queue = [];
    this.scheduled = false;
    this.ctl = [];
    this.frameLog = []; // [lane, length] of every binary frame
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    let payload;
    let size;
    if (typeof data === 'string') {
      payload = data;
      size = data.length;
      this.ctl.push(JSON.parse(data));
    } else {
      const v = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      payload = v.slice().buffer;
      size = payload.byteLength;
      this.frameLog.push([v[0], v.byteLength]);
    }
    this.bufferedAmount += size;
    this.queue.push({ payload, size });
    this._schedule();
  }

  _schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this._deliver());
  }

  _deliver() {
    this.scheduled = false;
    let budget = this.rate;
    while (this.queue.length && budget > 0) {
      const m = this.queue.shift();
      budget -= m.size;
      const before = this.bufferedAmount;
      this.bufferedAmount -= m.size;
      if (this.peer.readyState === 'open' && typeof this.peer.onmessage === 'function') this.peer.onmessage({ data: m.payload });
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event('bufferedamountlow'));
      }
    }
    if (this.queue.length) this._schedule();
  }

  close() {}
}

function pair() {
  const a = new Chan();
  const b = new Chan();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function pattern(size, seed) {
  const b = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

function pngBytes(size) {
  const b = pattern(size, 99);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
}

function fileSink() {
  const s = {
    written: [],
    done: [],
    begin: async () => ({ ok: true }),
    chunk: (id, data) => { s.written.push(data); return Promise.resolve({ ok: true }); },
    end: async (id) => { s.done.push(id); return { ok: true }; },
    abort: () => {},
  };
  return s;
}

test('a clipboard image overtakes a running 10 MiB file; both arrive byte-identical', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const sink = fileSink();
  const images = [];
  const finished = [];
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, sink, {
    canReceive: () => true,
    onClipboardImage: (png) => images.push(png),
  });
  receiver.addEventListener('update', (e) => {
    if (e.detail.state === 'done' && !finished.includes(e.detail.id)) finished.push(e.detail.id);
  });
  const file = pattern(10 * MiB, 1);
  const fileId = sender.sendFile(new Blob([file]));
  // Wait until the file is really streaming, then copy an image.
  for (let i = 0; i < 400 && sender.transfers.get(fileId).bytes < MiB; i++) await tick();
  assert.equal(sender.transfers.get(fileId).state, 'sending');
  const png = pngBytes(2.5 * MiB + 17); // several 1 MiB read blocks, ~40 frames
  const imgId = sender.sendClipboardImage(png);

  for (let i = 0; i < 5000 && finished.length < 2; i++) await tick();
  assert.deepEqual(finished, [imgId, fileId], 'image finished first');
  for (let i = 0; i < 50 && sender.transfers.get(fileId).state !== 'done'; i++) await tick(); // file-done in flight
  assert.equal(sender.transfers.get(imgId).state, 'done');
  assert.equal(sender.transfers.get(fileId).state, 'done');
  assert.equal(images.length, 1);
  assert.equal(Buffer.compare(Buffer.from(images[0]), Buffer.from(png)), 0, 'image byte-identical');
  const got = Buffer.concat(sink.written.map((u) => Buffer.from(u)));
  assert.equal(Buffer.compare(got, Buffer.from(file)), 0, 'file byte-identical');

  // Every frame: lane byte + ≤ 64 KiB, right lane per purpose; the lanes interleave.
  assert.ok(a.frameLog.every(([, len]) => len >= 2 && len <= F.CHUNK_SIZE + 1));
  const lanes = a.frameLog.map(([l]) => l);
  assert.equal(lanes.filter((l) => l === LANE_CLIP).length, Math.ceil(png.length / F.CHUNK_SIZE));
  assert.equal(lanes.filter((l) => l === LANE_FILE).length, Math.ceil(file.length / F.CHUNK_SIZE));
  const firstClip = lanes.indexOf(LANE_CLIP);
  const lastClip = lanes.lastIndexOf(LANE_CLIP);
  assert.ok(lanes.slice(firstClip, lastClip).includes(LANE_FILE), 'file chunks continue while the image streams');
  sender.close();
  receiver.close();
});

test('two files on the same lane are still sent one at a time, in order', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const sink = fileSink();
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, sink, { canReceive: () => true });
  const f1 = pattern(300 * 1024, 5);
  const f2 = pattern(200 * 1024, 6);
  const id1 = sender.sendFile(new Blob([f1]));
  const id2 = sender.sendFile(new Blob([f2]));
  assert.equal(sender.transfers.get(id2).state, 'queued');
  for (let i = 0; i < 2000 && sink.done.length < 2; i++) await tick();
  assert.deepEqual(sink.done, [id1, id2]);
  const got = Buffer.concat(sink.written.map((u) => Buffer.from(u)));
  assert.equal(Buffer.compare(got, Buffer.concat([Buffer.from(f1), Buffer.from(f2)])), 0);
  sender.close();
  receiver.close();
});

test('receiver drops empty frames and frames for a lane without an accepted transfer', async () => {
  const { FileTransfer } = await load();
  const [, b] = pair();
  const sink = fileSink();
  const receiver = new FileTransfer(b, sink, { canReceive: () => true, onClipboardImage: () => {} });
  const updates = [];
  receiver.addEventListener('update', (e) => updates.push(e.detail));
  b.onmessage({ data: new ArrayBuffer(0) });
  b.onmessage({ data: new Uint8Array([LANE_FILE]).buffer });
  b.onmessage({ data: new Uint8Array([LANE_CLIP, 1, 2, 3]).buffer });
  b.onmessage({ data: new Uint8Array([7, 1, 2, 3]).buffer });
  await tick();
  assert.equal(updates.length, 0);
  assert.equal(sink.written.length, 0);
  // An offer on the file lane does not open the clipboard lane.
  b.onmessage({ data: JSON.stringify({ t: F.OFFER, id: 'f1', name: 'a.bin', size: 3, mime: '', purpose: 'file' }) });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(receiver.transfers.get('f1').state, 'receiving');
  b.onmessage({ data: new Uint8Array([LANE_CLIP, 9, 9, 9]).buffer });
  assert.equal(receiver.transfers.get('f1').bytes, 0);
  b.onmessage({ data: new Uint8Array([LANE_FILE, 1, 2, 3]).buffer });
  assert.equal(receiver.transfers.get('f1').bytes, 3);
  assert.deepEqual(Array.from(sink.written[0]), [1, 2, 3]);
  // A second offer on a busy lane is rejected; the other lane still accepts.
  b.onmessage({ data: JSON.stringify({ t: F.OFFER, id: 'f2', name: 'b.bin', size: 3, mime: '', purpose: 'file' }) });
  b.onmessage({ data: JSON.stringify({ t: F.OFFER, id: 'c1', name: 'clipboard.png', size: 8, mime: 'image/png', purpose: 'clipboard-image' }) });
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(b.ctl.some((m) => m.t === F.REJECT && m.id === 'f2' && m.reason === 'busy'));
  assert.equal(receiver.transfers.get('c1').state, 'receiving');
  receiver.close();
});

test('cancel and peer messages are routed by id to the right lane', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const sink = fileSink();
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, sink, { canReceive: () => true, onClipboardImage: () => {} });
  const fileId = sender.sendFile(new Blob([pattern(8 * MiB, 2)]));
  const imgId = sender.sendClipboardImage(pngBytes(256 * 1024));
  for (let i = 0; i < 50 && sender.transfers.get(fileId).bytes === 0; i++) await tick();
  // Cancelling the file must not touch the image.
  assert.equal(sender.cancel(fileId), true);
  for (let i = 0; i < 400 && sender.transfers.get(imgId).state !== 'done'; i++) await tick();
  assert.equal(sender.transfers.get(fileId).state, 'cancelled');
  assert.equal(sender.transfers.get(imgId).state, 'done');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(receiver.transfers.get(fileId).state, 'cancelled');
  assert.equal(receiver.transfers.get(fileId).reason, 'peer-cancelled');
  assert.equal(receiver.transfers.get(imgId).state, 'done');
  sender.close();
  receiver.close();
});
