'use strict';
/*
 * src/renderer/shared/transfer.js — receiver-side flow control (file-pause / file-resume) and
 * immediate write-error feedback, over a pair of linked fake RTCDataChannels.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.TunnelviewProtocol = require('../src/shared/protocol');
const F = globalThis.TunnelviewProtocol.FILE;
const PAUSE = F.PAUSE || 'file-pause';
const RESUME = F.RESUME || 'file-resume';
const MiB = 1024 * 1024;

const load = () => import('../src/renderer/shared/transfer.js');
const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

/**
 * In-order delivery limited to `rate` bytes per event-loop turn (a link, not a memcpy), with a
 * bufferedAmount that drains as messages are delivered.
 */
class Chan extends EventTarget {
  constructor(name, rate = 512 * 1024) {
    super();
    this.name = name;
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'blob';
    this.onmessage = null;
    this.peer = null;
    this.rate = rate;
    this.queue = [];
    this.scheduled = false;
    this.ctl = []; // JSON messages sent
    this.frames = 0;
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
      this.frames++;
    }
    this.bufferedAmount += size;
    this.queue.push({ payload, size });
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this._deliver());
    }
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
    if (this.queue.length && !this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this._deliver());
    }
  }

  close() {
    for (const c of [this, this.peer]) {
      if (c.readyState === 'closed') continue;
      c.readyState = 'closed';
      c.dispatchEvent(new Event('close'));
    }
  }
}

function pair() {
  const a = new Chan('a');
  const b = new Chan('b');
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function pattern(size, seed = 7) {
  const b = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

/** Sink whose chunk() returns a promise the test settles (manual) or that settles on its own. */
function makeSink({ manual = false, fail = null } = {}) {
  const sink = {
    pending: [],
    written: [],
    inflight: 0,
    maxInflight: 0,
    ended: [],
    aborted: [],
    begin: async () => ({ ok: true }),
    chunk(id, data) {
      if (fail) return Promise.resolve(fail);
      sink.inflight += data.byteLength;
      sink.maxInflight = Math.max(sink.maxInflight, sink.inflight);
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      const entry = {
        n: data.byteLength,
        done: (res = { ok: true }) => {
          sink.inflight -= data.byteLength;
          if (res.ok) sink.written.push(data);
          resolve(res);
        },
      };
      if (manual) sink.pending.push(entry);
      else setImmediate(entry.done);
      return p;
    },
    end: async (id) => { sink.ended.push(id); return { ok: true, path: `/tmp/${id}` }; },
    abort: (id) => { sink.aborted.push(id); },
    release(bytes) {
      let freed = 0;
      while (sink.pending.length && freed < bytes) {
        const e = sink.pending.shift();
        freed += e.n;
        e.done();
      }
    },
  };
  return sink;
}

const outState = (ft, id) => ft.transfers.get(id);

test('receiver pauses the sender at 16 MiB of writes in flight and resumes it at 4 MiB', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const sink = makeSink({ manual: true });
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, sink, { canReceive: () => true });
  const data = pattern(40 * MiB);
  const id = sender.sendFile(new Blob([data], { type: 'application/octet-stream' }));
  const tx = () => outState(sender, id);

  // Let it stream until the receiver asks for a pause.
  for (let i = 0; i < 1000 && !b.ctl.some((m) => m.t === PAUSE); i++) await tick();
  assert.ok(b.ctl.some((m) => m.t === PAUSE && m.id === id), 'file-pause sent');
  assert.ok(sink.inflight >= 16 * MiB && sink.inflight < 17 * MiB, `paused at ${sink.inflight}`);
  assert.ok(!b.ctl.some((m) => m.t === RESUME));

  // The sender stops: after the in-flight frames land, nothing more is sent.
  await flush(60);
  const stalled = tx().bytes;
  const framesAtStall = a.frames;
  await flush(60);
  assert.equal(tx().bytes, stalled, 'sender stopped while paused');
  assert.equal(a.frames, framesAtStall);
  assert.equal(tx().state, 'sending');
  assert.ok(stalled < data.length);

  // Drain to just above 4 MiB: still paused.
  sink.release(sink.inflight - 4 * MiB - F.CHUNK_SIZE);
  await flush(10);
  assert.ok(!b.ctl.some((m) => m.t === RESUME), 'not resumed above 4 MiB');
  // Below 4 MiB → resume.
  sink.release(2 * F.CHUNK_SIZE);
  await flush(10);
  assert.ok(b.ctl.some((m) => m.t === RESUME && m.id === id), 'file-resume sent');
  await flush(40);
  assert.ok(tx().bytes > stalled, 'sender restarted');

  // Finish: write everything as it arrives.
  for (let i = 0; i < 5000 && tx().state !== 'done'; i++) {
    sink.release(Infinity);
    await tick();
  }
  assert.equal(tx().state, 'done');
  assert.equal(outState(receiver, id).state, 'done');
  assert.deepEqual(sink.ended, [id]);
  // 16 MiB + what the sender had already buffered when the pause arrived (≤ HIGH_WATER + a block).
  assert.ok(sink.maxInflight <= 16 * MiB + F.HIGH_WATER + 2 * MiB, `in flight bounded (${sink.maxInflight})`);
  const got = Buffer.concat(sink.written.map((u) => Buffer.from(u)));
  assert.equal(Buffer.compare(got, Buffer.from(data)), 0, 'byte-identical');
  sender.close();
  receiver.close();
});

test('a failed write (no-space) is reported immediately and ends the sender with that error', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const sink = makeSink({ fail: { ok: false, reason: 'no-space' } });
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, sink, { canReceive: () => true });
  const id = sender.sendFile(new Blob([pattern(8 * MiB)]));
  for (let i = 0; i < 400 && outState(sender, id).state !== 'error'; i++) await tick();
  const t = outState(sender, id);
  assert.equal(t.state, 'error');
  assert.equal(t.reason, 'no-space');
  assert.ok(t.bytes < 8 * MiB, 'stopped long before file-end');
  assert.ok(b.ctl.some((m) => m.t === F.ERROR && m.id === id && m.reason === 'no-space'));
  assert.ok(!a.ctl.some((m) => m.t === F.END), 'never reached file-end');
  const r = outState(receiver, id);
  assert.equal(r.state, 'error');
  assert.equal(r.reason, 'no-space');
  assert.deepEqual(sink.aborted, [id]);
  assert.deepEqual(sink.ended, []);
  sender.close();
  receiver.close();
});

test('a write that rejects is reported as write-failed', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const sink = makeSink();
  sink.chunk = () => Promise.reject(new Error('EIO'));
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, sink, { canReceive: () => true });
  const id = sender.sendFile(new Blob([pattern(MiB)]));
  for (let i = 0; i < 200 && outState(sender, id).state !== 'error'; i++) await tick();
  assert.equal(outState(sender, id).reason, 'write-failed');
  assert.equal(outState(receiver, id).state, 'error');
  sender.close();
  receiver.close();
});

test('a write failing after file-end is still reported (sink.end is not called)', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const sink = makeSink({ manual: true });
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, sink, { canReceive: () => true });
  const id = sender.sendFile(new Blob([pattern(256 * 1024)]));
  for (let i = 0; i < 200 && !a.ctl.some((m) => m.t === F.END); i++) await tick();
  await flush(5);
  assert.equal(sink.pending.length, 4, 'all four chunks queued, file-end received');
  // The writes are still pending: no verdict yet (the sender waits for file-done / file-error).
  assert.equal(outState(sender, id).state, 'sending');
  assert.equal(outState(sender, id).bytes, 256 * 1024);
  assert.deepEqual(sink.ended, []);
  const [first, ...rest] = sink.pending.splice(0);
  for (const e of rest) e.done();
  await flush(5);
  assert.equal(outState(sender, id).state, 'sending', 'still waiting for the first write');
  assert.deepEqual(sink.ended, []);
  first.done({ ok: false, reason: 'io-error' });
  await flush(10);
  assert.equal(outState(receiver, id).state, 'error');
  assert.equal(outState(receiver, id).reason, 'io-error');
  assert.equal(outState(sender, id).state, 'error');
  assert.equal(outState(sender, id).reason, 'io-error');
  assert.deepEqual(sink.ended, [], 'sink.end never called');
  assert.deepEqual(sink.aborted, [id]);
  sender.close();
  receiver.close();
});

test('a sink.chunk returning undefined (fire-and-forget) still works, without pausing', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const written = [];
  const sink = {
    begin: async () => ({ ok: true }),
    chunk: (id, data) => { written.push(data); },
    end: async () => ({ ok: true }),
    abort: () => {},
  };
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, sink, { canReceive: () => true });
  const data = pattern(20 * MiB, 3);
  const id = sender.sendFile(new Blob([data]));
  for (let i = 0; i < 3000 && outState(sender, id).state !== 'done'; i++) await tick();
  assert.equal(outState(sender, id).state, 'done');
  assert.ok(!b.ctl.some((m) => m.t === PAUSE));
  assert.equal(Buffer.compare(Buffer.concat(written.map((u) => Buffer.from(u))), Buffer.from(data)), 0);
  sender.close();
  receiver.close();
});

test('pause/resume for unknown ids or the clipboard lane are ignored', async () => {
  const { FileTransfer } = await load();
  const [a, b] = pair();
  const sender = new FileTransfer(a, null);
  const receiver = new FileTransfer(b, null, { onClipboardImage: () => {} });
  const png = pattern(200 * 1024);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const id = sender.sendClipboardImage(png);
  // A peer trying to stall the clipboard lane or an unknown transfer has no effect.
  b.send(JSON.stringify({ t: PAUSE, id }));
  b.send(JSON.stringify({ t: PAUSE, id: 'unknown-id' }));
  for (let i = 0; i < 400 && outState(sender, id).state !== 'done'; i++) await tick();
  assert.equal(outState(sender, id).state, 'done');
  sender.close();
  receiver.close();
});
