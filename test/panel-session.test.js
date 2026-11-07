'use strict';
/*
 * HostSession (src/renderer/panel/host-session.js) driven with a mocked panel API, a fake
 * RTCPeerConnection / RTCIceTransport and a controllable getDisplayMedia(). No Electron, no OS input.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.TunnelviewProtocol = require('../src/shared/protocol');
const P = globalThis.TunnelviewProtocol;

const load = () => import('../src/renderer/panel/host-session.js');
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* ------------------------------------------------------------------ fakes */

class FakeTrack extends EventTarget {
  constructor(kind, settings = {}) {
    super();
    this.kind = kind;
    this.readyState = 'live';
    this.enabled = true;
    this.contentHint = '';
    this.settings = settings;
    this.applied = [];
  }

  stop() { this.readyState = 'ended'; }

  getSettings() { return { ...this.settings }; }

  async applyConstraints(c) { this.applied.push(c); }
}

class FakeStream {
  constructor(tracks) { this.tracks = tracks; }

  getTracks() { return this.tracks.slice(); }

  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }

  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}

const stream = (audio = true, settings = {}) => new FakeStream([new FakeTrack('video', settings), ...(audio ? [new FakeTrack('audio')] : [])]);

class FakeDC extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.readyState = 'connecting';
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
    this.onmessage = null;
  }

  send(d) { this.sent.push(d); }

  close() { this.readyState = 'closed'; }

  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  json() { return this.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s)); }

  deliver(obj) {
    const e = new Event('message');
    e.data = JSON.stringify(obj);
    this.dispatchEvent(e);
  }
}

class FakeIce extends EventTarget {
  constructor() {
    super();
    this.pair = null;
  }

  getSelectedCandidatePair() { return this.pair; }

  select(local, remote, remoteType = 'host') {
    this.pair = {
      local: { address: local, protocol: 'udp', type: 'host' },
      remote: { address: remote, protocol: 'udp', type: remoteType },
    };
    this.dispatchEvent(new Event('selectedcandidatepairchange'));
  }
}

function installEnv(log, { pairInStats = true } = {}) {
  const env = { pcs: [], capture: [], gumCalls: 0, log };
  class FakePC extends EventTarget {
    constructor(cfg) {
      super();
      this.cfg = cfg;
      this.connectionState = 'new';
      this.signalingState = 'stable';
      this.localDescription = null;
      this.remoteDescription = null;
      this.transceivers = [];
      this.channels = {};
      this.ice = new FakeIce();
      this.sctp = null;
      this.restarts = 0;
      this.offers = 0;
      env.pcs.push(this);
      log.push('pc');
    }

    createDataChannel(label) {
      const ch = new FakeDC(label);
      this.channels[label] = ch;
      return ch;
    }

    addTransceiver(kind, init) {
      const sender = {
        track: null,
        transport: null,
        sets: [], // every setParameters() call
        replaceTrack: async (t) => {
          log.push(`replace:${kind}:${t ? t.kind : 'null'}`);
          sender.track = t;
        },
        getParameters: () => ({ encodings: [{}] }),
        setParameters: async (p) => { sender.sets.push(p); },
      };
      const tx = { kind, init, sender, direction: init.direction, setCodecPreferences() {} };
      this.transceivers.push(tx);
      return tx;
    }

    async createOffer(opts) {
      this.offers++;
      log.push(opts && opts.iceRestart ? 'createOffer:restart' : 'createOffer');
      return { type: 'offer', sdp: `v=0\r\no=- 1 ${this.offers} IN IP4 127.0.0.1\r\na=candidate:1 1 udp 1 192.168.1.2 47801 typ host\r\na=candidate:2 1 udp 1 100.64.0.1 47801 typ host\r\n` };
    }

    async setLocalDescription(d) {
      this.localDescription = d;
      this.signalingState = 'have-local-offer';
      // Chromium exposes the SCTP transport once the data m-section is negotiated.
      this.sctp = { transport: { iceTransport: this.ice } };
    }

    async setRemoteDescription(d) {
      this.remoteDescription = d;
      this.signalingState = 'stable';
    }

    async addIceCandidate() {}

    async getStats() {
      const m = new Map();
      if (pairInStats) {
        m.set('T', { type: 'transport', selectedCandidatePairId: 'CP' });
        m.set('CP', { type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' });
        m.set('L', { type: 'local-candidate', address: '100.64.0.1', protocol: 'udp' });
        m.set('R', { type: 'remote-candidate', address: '100.64.0.2', protocol: 'udp' });
      }
      return m;
    }

    restartIce() { this.restarts++; }

    close() {
      this.connectionState = 'closed';
      this.signalingState = 'closed';
    }

    setState(s) {
      this.connectionState = s;
      this.dispatchEvent(new Event('connectionstatechange'));
    }
  }
  globalThis.RTCPeerConnection = FakePC;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: (constraints) => {
        log.push(`gdm:${constraints.audio ? 'audio' : 'video'}`);
        return new Promise((resolve, reject) => env.capture.push({ constraints, resolve, reject }));
      },
    },
  });
  return env;
}

function makeApi(log) {
  return {
    signals: [],
    ended: [],
    clipboard: [],
    sendSignal(m) {
      this.signals.push(m);
      log.push(`signal:${m.t}${m.description ? `:${m.description.type}` : ''}`);
    },
    selectDisplay: async (id) => { log.push(`select:${id}`); return { ok: true, sourceId: `screen:${id}:0` }; },
    commitDisplay: async (id) => { log.push(`commit:${id}`); return { ok: true }; },
    listDisplays: async () => DISPLAYS.map((d) => ({ ...d })),
    endSession(r) { this.ended.push(r); },
    input(evt) { log.push(`input:${evt.t}`); },
    releaseAll() { log.push('releaseAll'); },
    setClipboardSync() {},
    writeClipboard: async (item) => { log.push(`clip:${item.kind}`); return { ok: true }; },
    fileBegin: async () => ({ ok: false, reason: 'test' }),
    fileChunk: () => {},
    fileEnd: async () => ({ ok: false }),
    fileAbort: () => {},
  };
}

const DISPLAYS = [
  { id: '1', name: 'A', primary: true, width: 2560, height: 1440, scaleFactor: 1 },
  { id: '2', name: 'B', primary: false, width: 5120, height: 2880, scaleFactor: 2 },
];

function init(over = {}) {
  return {
    permissions: { control: true, clipboard: true, files: true, audio: true },
    input: { available: true, reason: null },
    settings: { quality: 'balanced', codec: 'auto', clipboardSync: true },
    audioSupported: true,
    displays: DISPLAYS.map((d) => ({ ...d })),
    initialDisplayId: '1',
    hostOs: 'windows',
    ...over,
  };
}

async function setup(opts = {}) {
  const log = [];
  const env = installEnv(log, opts);
  const api = makeApi(log);
  const { HostSession } = await load();
  const s = new HostSession(api, init(opts.init));
  const events = { notice: [], ended: [], path: [] };
  for (const k of Object.keys(events)) s.addEventListener(k, (e) => events[k].push(e.detail));
  return { log, env, api, s, events };
}

const ANSWER = [
  'v=0', 'o=- 9 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2',
  'm=video 9 UDP/TLS/RTP/SAVPF 102 103 96', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=recvonly',
  'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', 'a=rtpmap:96 VP8/90000',
  'a=candidate:9 1 udp 1 10.0.0.9 47801 typ host',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:1', 'a=recvonly', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:2', '',
].join('\r\n');

/* ------------------------------------------------------------------ tests */

test('offer is sent before the screen capture resolves; transceivers carry no shared stream', async () => {
  const { log, env, api, s } = await setup();
  const started = s.start();
  await flush();
  assert.equal(env.capture.length, 1, 'getDisplayMedia called');
  assert.ok(log.includes('signal:sdp:offer'), 'offer sent while capture is pending');
  assert.ok(log.indexOf('gdm:audio') < log.indexOf('signal:sdp:offer'), 'capture started first, in parallel');
  const offer = api.signals.find((m) => m.t === 'sdp');
  assert.ok(!offer.description.sdp.includes('192.168.1.2'), 'non-tailnet candidates scrubbed from the offer');
  const pc = env.pcs[0];
  assert.deepEqual(pc.transceivers.map((t) => t.kind), ['video', 'audio']);
  for (const tx of pc.transceivers) assert.equal(tx.init.streams, undefined, 'no shared MediaStream (no A/V sync group)');
  assert.equal(s.phase, 'connecting');

  env.capture[0].resolve(stream(true));
  await started;
  assert.ok(!log.some((l) => l.startsWith('replace:')), 'nothing attached before the path is verified');
  pc.ice.select('100.64.0.1', '100.100.1.2');
  await flush();
  assert.equal(s.pathOk, true);
  assert.ok(log.includes('replace:video:video'));
  assert.ok(log.includes('replace:audio:audio'));
  s.end('test', { fromMain: true });
});

test('path verified before capture: replaceTrack waits for the capture, then attaches', async () => {
  const { log, env, s } = await setup();
  const started = s.start();
  await flush();
  const pc = env.pcs[0];
  pc.ice.select('100.64.0.1', 'fd7a:115c:a1e0::2');
  await flush();
  assert.equal(s.pathOk, true);
  assert.equal(s.mediaAttached, false);
  assert.ok(!log.some((l) => l.startsWith('replace:')));
  env.capture[0].resolve(stream(false));
  await started;
  await flush();
  assert.equal(s.mediaAttached, true);
  assert.deepEqual(log.filter((l) => l.startsWith('replace:')), ['replace:video:video']);
  s.end('test', { fromMain: true });
});

test('capture failure ends the session with capture-failed', async () => {
  const { env, api, s, events } = await setup({ init: { audioSupported: false } });
  const started = s.start();
  await flush();
  env.capture[0].reject(new Error('Permission denied'));
  await started;
  assert.equal(s.ended, true);
  assert.equal(s.endReason, 'capture-failed');
  assert.deepEqual(api.ended, ['capture-failed']);
  assert.equal(events.notice.length, 1);
  assert.match(events.notice[0].text, /Screen capture failed/);
});

test('macOS capture hint asks to quit and reopen Tunnelview', async () => {
  const { HostSession } = await load();
  const s = new HostSession(makeApi([]), init({ hostOs: 'macos' }));
  assert.match(s._captureHint(new Error('x')), /quit and reopen Tunnelview on this Mac/);
});

test('a non-tailnet selected pair ends the session before any media is attached', async () => {
  const { log, env, s, events } = await setup();
  const started = s.start();
  await flush();
  env.pcs[0].ice.select('100.64.0.1', '192.168.1.50');
  env.capture[0].resolve(stream());
  await started;
  await flush();
  assert.equal(s.endReason, 'non-tailnet-path');
  assert.equal(events.path[0].status, 'failed');
  assert.ok(!log.some((l) => l.startsWith('replace:')));
  assert.equal(env.capture.length, 1);
});

test('the applied answer is scrubbed and munged (start bitrate + Opus stereo)', async () => {
  const { env, s } = await setup();
  const started = s.start();
  await flush();
  await s.handleSignal({ t: 'sdp', description: { type: 'answer', sdp: ANSWER } });
  const sdp = env.pcs[0].remoteDescription.sdp;
  assert.ok(sdp.includes('profile-level-id=42e01f;x-google-start-bitrate=4000'));
  assert.ok(sdp.includes('a=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=4000'));
  assert.ok(sdp.includes('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=128000'));
  assert.ok(!sdp.includes('10.0.0.9'));
  // A second answer while 'stable' is ignored.
  await s.handleSignal({ t: 'sdp', description: { type: 'answer', sdp: ANSWER.replace('o=- 9 2', 'o=- 9 3') } });
  assert.ok(env.pcs[0].remoteDescription.sdp.includes('o=- 9 2'));
  env.capture[0].resolve(stream());
  await started;
  s.end('test', { fromMain: true });
});

test("'failed' before ever connecting ends with connection-failed", async () => {
  const { env, s } = await setup();
  const started = s.start();
  await flush();
  env.pcs[0].setState('failed');
  assert.equal(s.endReason, 'connection-failed');
  env.capture[0].resolve(stream());
  await started;
  assert.equal(env.capture[0].constraints.video.frameRate.max, 60);
});

test("'failed' after connecting restarts ICE; the new answer is applied and the session recovers", async () => {
  const { log, env, api, s } = await setup();
  const started = s.start();
  await flush();
  const pc = env.pcs[0];
  await s.handleSignal({ t: 'sdp', description: { type: 'answer', sdp: ANSWER } });
  env.capture[0].resolve(stream());
  await started;
  pc.setState('connected');
  await flush();
  assert.equal(s.phase, 'live');
  pc.setState('failed');
  await flush();
  assert.equal(s.ended, false);
  assert.equal(s.phase, 'reconnecting');
  assert.equal(pc.restarts, 1);
  assert.ok(log.includes('createOffer:restart'));
  const offers = api.signals.filter((m) => m.t === 'sdp');
  assert.equal(offers.length, 2);
  assert.ok(!offers[1].description.sdp.includes('192.168.1.2'));
  // The renegotiation answer is accepted (have-local-offer) and munged like the first one.
  await s.handleSignal({ t: 'sdp', description: { type: 'answer', sdp: ANSWER.replace('o=- 9 2', 'o=- 9 3') } });
  assert.ok(pc.remoteDescription.sdp.includes('o=- 9 3'));
  assert.ok(pc.remoteDescription.sdp.includes('x-google-start-bitrate=4000'));
  pc.setState('connected');
  await flush();
  assert.equal(s.phase, 'live');
  assert.equal(s.ended, false);
  assert.equal(s.timers.disconnect, null);
  s.end('test', { fromMain: true });
});

test('disconnected: ICE restart after 3 s, connection-lost after 30 s without recovery', async (t) => {
  // Before start(): every session timer (connect timeout included) must be a mocked one.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { env, s } = await setup();
  const started = s.start();
  await flush();
  const pc = env.pcs[0];
  await s.handleSignal({ t: 'sdp', description: { type: 'answer', sdp: ANSWER } });
  env.capture[0].resolve(stream());
  await started;
  pc.setState('connected');
  await flush();
  pc.setState('disconnected');
  t.mock.timers.tick(2_900);
  await flush();
  assert.equal(pc.restarts, 0);
  t.mock.timers.tick(200);
  await flush();
  assert.equal(pc.restarts, 1);
  // No answer to the restart offer (have-local-offer): further restarts are skipped.
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(pc.restarts, 1);
  assert.equal(s.ended, false);
  t.mock.timers.tick(17_000);
  await flush();
  assert.equal(s.endReason, 'connection-lost');
});

test('display switch: capped constraints, input mapping committed only after the new track is in', async () => {
  const { log, env, s } = await setup();
  const started = s.start();
  await flush();
  const pc = env.pcs[0];
  env.capture[0].resolve(stream(false));
  await started;
  pc.ice.select('100.64.0.1', '100.64.0.2');
  await flush();
  pc.channels.control.open();
  log.length = 0;
  s.requestDisplay('2');
  await flush();
  assert.equal(env.capture.length, 2);
  // 5120×2880 @2x → fit 3840×2160 (aspect kept), not the 2560×1440 logical size.
  assert.deepEqual(env.capture[1].constraints.video.width, { max: 3840 });
  assert.deepEqual(env.capture[1].constraints.video.height, { max: 2160 });
  assert.ok(!log.includes('commit:2'), 'mapping not moved while the old picture is still shown');
  env.capture[1].resolve(stream(false, { width: 5120, height: 2880 }));
  await flush();
  const iReplace = log.indexOf('replace:video:video');
  const iCommit = log.indexOf('commit:2');
  assert.ok(iReplace !== -1 && iCommit > iReplace, `replace before commit: ${log.join(',')}`);
  assert.equal(s.currentDisplayId, '2');
  // getSettings() reported the full size → applyConstraints enforces the cap.
  assert.deepEqual(s.videoTrack.applied[0].width, { max: 3840 });
  assert.deepEqual(s.videoTrack.applied[0].height, { max: 2160 });
  const displays = pc.channels.control.json().filter((m) => m.t === 'displays');
  assert.equal(displays[displays.length - 1].current, '2');
  s.end('test', { fromMain: true });
});

test('failed display switch keeps the stream and never commits the new display', async () => {
  const { log, env, s, events } = await setup({ init: { audioSupported: false } });
  const started = s.start();
  await flush();
  env.capture[0].resolve(stream(false));
  await started;
  env.pcs[0].ice.select('100.64.0.1', '100.64.0.2');
  await flush();
  log.length = 0;
  s.requestDisplay('2');
  await flush();
  env.capture[1].reject(new Error('nope'));
  await flush();
  assert.equal(s.currentDisplayId, '1');
  assert.ok(!log.some((l) => l.startsWith('commit:')));
  assert.ok(log.includes('select:1'), 'capture selection restored');
  assert.equal(events.notice[events.notice.length - 1].text, 'Could not capture that display.');
  s.end('test', { fromMain: true });
});

test('audio permission off/on detaches and re-attaches the audio track', async () => {
  const { log, env, s } = await setup();
  const started = s.start();
  await flush();
  env.capture[0].resolve(stream(true));
  await started;
  env.pcs[0].ice.select('100.64.0.1', '100.64.0.2');
  await flush();
  const audioTx = env.pcs[0].transceivers[1];
  assert.equal(audioTx.sender.track.kind, 'audio');
  log.length = 0;
  s.setPermissions({ control: true, clipboard: true, files: true, audio: false });
  assert.equal(s.audioTrack.enabled, false);
  await flush();
  assert.deepEqual(log.filter((l) => l.startsWith('replace:')), ['replace:audio:null']);
  s.setPermissions({ control: true, clipboard: true, files: true, audio: true });
  await flush();
  assert.equal(s.audioTrack.enabled, true);
  assert.deepEqual(log.filter((l) => l.startsWith('replace:')), ['replace:audio:null', 'replace:audio:audio']);
  s.end('test', { fromMain: true });
});

test('audio off at start: the audio sender stays empty when media is attached', async () => {
  const { log, env, s } = await setup({ init: { permissions: { control: true, clipboard: true, files: true, audio: false } } });
  const started = s.start();
  await flush();
  assert.equal(env.capture[0].constraints.audio, false);
  env.capture[0].resolve(stream(false));
  await started;
  env.pcs[0].ice.select('100.64.0.1', '100.64.0.2');
  await flush();
  assert.deepEqual(log.filter((l) => l.startsWith('replace:')), ['replace:video:video']);
  s.end('test', { fromMain: true });
});

test('macOS: a capture held by the system alert ends with capture-blocked; the late stream is stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { env, api, s, events } = await setup({ init: { hostOs: 'macos', audioSupported: false } });
  const started = s.start();
  await flush();
  assert.equal(env.capture.length, 1);
  t.mock.timers.tick(15_000);
  await started;
  assert.equal(s.endReason, 'capture-blocked');
  assert.deepEqual(api.ended, ['capture-blocked']);
  assert.match(events.notice[0].text, /macOS is waiting for someone at this Mac/);
  const late = stream(false);
  env.capture[0].resolve(late);
  await flush();
  assert.equal(late.getVideoTracks()[0].readyState, 'ended');
});

test('host-state carries inputBlocked while control is allowed', async () => {
  const { env, s } = await setup();
  const started = s.start();
  await flush();
  env.capture[0].resolve(stream(false));
  await started;
  const ctl = env.pcs[0].channels.control;
  ctl.open();
  s.setInputStatus({ available: true, reason: null, blocked: 'elevated-window' });
  let hs = ctl.json().filter((m) => m.t === 'host-state').pop();
  assert.equal(hs.inputBlocked, 'elevated-window');
  assert.equal(hs.controlAllowed, true);
  s.setInputStatus({ available: true, reason: null, blocked: 'bogus' });
  hs = ctl.json().filter((m) => m.t === 'host-state').pop();
  assert.equal(hs.inputBlocked, null);
  s.setInputStatus({ available: true, reason: null, blocked: 'secure-desktop' });
  s.setPermissions({ control: false, clipboard: true, files: true, audio: true });
  hs = ctl.json().filter((m) => m.t === 'host-state').pop();
  assert.equal(hs.inputBlocked, null);
  assert.equal(hs.controlAllowed, false);
  s.end('test', { fromMain: true });
});

test("'ended' event says whether main reported the end", async () => {
  const { s, events } = await setup();
  s.end('media-timeout', { fromMain: true });
  assert.deepEqual(events.ended, [{ reason: 'media-timeout', fromMain: true }]);
});

test("a peer-reflexive remote reported as 'redacted-ip.invalid' does not end the session", async () => {
  const { log, env, s, events } = await setup({ init: { audioSupported: false } });
  const started = s.start();
  await flush();
  env.capture[0].resolve(stream(false));
  await started;
  // RTCIceTransport.getSelectedCandidatePair() on a fast tailnet: the viewer's checks arrived first.
  env.pcs[0].ice.select('100.64.1.2', 'redacted-ip.invalid', 'prflx');
  await flush();
  assert.equal(s.ended, false);
  assert.equal(s.pathOk, true);
  assert.equal(events.path[0].status, 'ok');
  assert.equal(events.path[0].remote, null);
  assert.equal(events.path[0].remoteType, 'prflx');
  assert.ok(log.includes('replace:video:video'));
  // A real non-tailnet IP on the same transport still ends it.
  env.pcs[0].ice.select('100.64.1.2', '192.168.1.5', 'prflx');
  assert.equal(s.endReason, 'non-tailnet-path');
});

/** Started session, answer applied, path verified, 'connected'; control channel open. */
async function liveSession(opts = {}) {
  const ctx = await setup(opts);
  const { env, s } = ctx;
  const started = s.start();
  await flush();
  const pc = env.pcs[0];
  await s.handleSignal({ t: 'sdp', description: { type: 'answer', sdp: ANSWER } });
  env.capture[0].resolve(stream(false, opts.settings || {}));
  await started;
  pc.ice.select('100.64.0.1', '100.64.0.2');
  await flush();
  pc.channels.control.open();
  return { ...ctx, pc };
}

test('an ICE outage releases held keys and buttons at its first sign', async () => {
  const { log, s, pc } = await liveSession({ init: { audioSupported: false } });
  pc.setState('connected');
  await flush();
  pc.channels.input.deliver({ t: P.INPUT.KEY_DOWN, code: 'ShiftLeft', key: 'Shift', rep: false });
  pc.channels.input.deliver({ t: P.INPUT.MOUSE_DOWN, b: 0, x: 0.5, y: 0.5 });
  assert.deepEqual(log.filter((l) => l.startsWith('input:')), ['input:kd', 'input:md']);
  assert.ok(!log.includes('releaseAll'));
  pc.setState('disconnected');
  assert.deepEqual(log.filter((l) => l === 'releaseAll'), ['releaseAll'], 'released on the first disconnect');
  assert.equal(s.phase, 'reconnecting');
  pc.setState('failed'); // same outage → no second release
  await flush();
  assert.deepEqual(log.filter((l) => l === 'releaseAll'), ['releaseAll']);
  assert.equal(s.ended, false);
  s.end('test', { fromMain: true });
});

test("display gone: main served another display ('served') → input mapped onto it, list re-read", async () => {
  const { log, env, api, s } = await setup({ init: { audioSupported: false, initialDisplayId: '2' } });
  let list = DISPLAYS;
  api.listDisplays = async () => { log.push('list'); return list.map((d) => ({ ...d })); };
  api.commitDisplay = async (id) => {
    log.push(`commit:${id}`);
    return id === '2' ? { ok: false, error: 'not-found', served: '1' } : { ok: true };
  };
  const started = s.start();
  await flush();
  const pc = env.pcs[0];
  env.capture[0].resolve(stream(false));
  await started;
  pc.ice.select('100.64.0.1', '100.64.0.2');
  await flush();
  pc.channels.control.open();
  log.length = 0;
  // Display 2 is unplugged: its capture ends while the cached list still names it.
  s.videoTrack.stop();
  s.videoTrack.dispatchEvent(new Event('ended'));
  await flush();
  assert.equal(env.capture.length, 2, 'recaptures the same id');
  assert.ok(log.includes('select:2'));
  list = DISPLAYS.filter((d) => d.id === '1');
  // Main's handler fell back to the primary display, inside display 2's 3840×2160 box.
  env.capture[1].resolve(stream(false, { width: 2560, height: 1440 }));
  await flush();
  assert.deepEqual(log.filter((l) => l.startsWith('commit:') || l === 'list'), ['list', 'commit:2', 'commit:1', 'list']);
  // That box is not display 1's own (none): captured once more at its own size, then committed.
  assert.equal(env.capture.length, 3);
  assert.equal(env.capture[2].constraints.video.width, undefined);
  assert.equal(log.filter((l) => l.startsWith('select:')).pop(), 'select:1');
  env.capture[2].resolve(stream(false, { width: 2560, height: 1440 }));
  await flush();
  assert.deepEqual(log.filter((l) => l.startsWith('commit:') || l === 'list'), ['list', 'commit:2', 'commit:1', 'list', 'commit:1']);
  assert.equal(env.capture.length, 3, 'no further capture');
  assert.equal(s.currentDisplayId, '1');
  assert.equal(s.wantDisplayId, '1');
  assert.equal(s.streamInfo().display.id, '1');
  const displays = pc.channels.control.json().filter((m) => m.t === 'displays').pop();
  assert.equal(displays.current, '1');
  assert.deepEqual(displays.displays.map((d) => d.id), ['1']);
  assert.equal(s.ended, false);
  s.end('test', { fromMain: true });
});

/**
 * Live session streaming display '2' of `displays`; display 2 then vanishes (its track ends while
 * main's cached list still names it) and main serves display '1' instead (commit → served '1').
 */
async function displayVanishes(displays, opts = {}) {
  const ctx = await setup({ init: { audioSupported: false, initialDisplayId: '2', displays: displays.map((d) => ({ ...d })), ...opts.init } });
  const { log, env, api, s } = ctx;
  let list = displays;
  api.listDisplays = async () => { log.push('list'); return list.map((d) => ({ ...d })); };
  api.commitDisplay = async (id) => {
    log.push(`commit:${id}`);
    return list.some((d) => d.id === id) ? { ok: true } : { ok: false, error: 'not-found', served: '1' };
  };
  const started = s.start();
  await flush();
  const pc = env.pcs[0];
  env.capture[0].resolve(stream(false, opts.firstSettings || {}));
  await started;
  pc.ice.select('100.64.0.1', '100.64.0.2');
  await flush();
  pc.channels.control.open();
  log.length = 0;
  s.videoTrack.stop();
  s.videoTrack.dispatchEvent(new Event('ended'));
  await flush();
  assert.equal(env.capture.length, 2, 'recaptures the same id');
  list = displays.filter((d) => d.id === '1');
  return { ...ctx, pc };
}

test('display gone: an ultrawide\'s smaller box is not kept for the served primary (captured again at its own size)', async () => {
  const ULTRAWIDE = [
    { id: '1', name: 'A', primary: true, width: 2560, height: 1440, scaleFactor: 1 },
    { id: '2', name: 'Wide', primary: false, width: 5120, height: 1440, scaleFactor: 1 },
  ];
  const speed = { quality: 'speed', codec: 'auto', clipboardSync: true };
  const { log, env, s, pc } = await displayVanishes(ULTRAWIDE, { init: { settings: speed }, firstSettings: { width: 3840, height: 1080 } });
  // Display 2's own box (5120×1440 → 3840×1080) was requested ...
  assert.deepEqual(env.capture[1].constraints.video.width, { max: 3840 });
  assert.deepEqual(env.capture[1].constraints.video.height, { max: 1080 });
  // ... and main served the 2560×1440 primary inside it: Chromium fits it to 1920×1080.
  const squeezed = stream(false, { width: 1920, height: 1080 });
  env.capture[1].resolve(squeezed);
  await flush();
  assert.equal(env.capture.length, 3, 'the served display is captured once more');
  const last = env.capture[2].constraints.video;
  assert.equal(last.width, undefined, 'no max box: display 1 is captured at its native size');
  assert.equal(last.height, undefined);
  const native = stream(false, { width: 2560, height: 1440 });
  env.capture[2].resolve(native);
  await flush();
  assert.equal(env.capture.length, 3, 'at most one extra capture');
  assert.equal(s.currentDisplayId, '1');
  assert.equal(s.wantDisplayId, '1');
  assert.equal(s.videoTrack, native.getVideoTracks()[0]);
  assert.deepEqual(s._captureSize(), { width: 2560, height: 1440 });
  assert.equal(squeezed.getVideoTracks()[0].readyState, 'ended', 'the squeezed fallback capture is stopped');
  assert.equal(pc.transceivers[0].sender.track, native.getVideoTracks()[0]);
  // 'speed' follows the real size: 2560×1440 → 1920×1080.
  assert.equal(pc.transceivers[0].sender.sets.at(-1).encodings[0].scaleResolutionDownBy, 4 / 3);
  assert.deepEqual(log.filter((l) => l.startsWith('commit:')), ['commit:2', 'commit:1', 'commit:1']);
  const displays = pc.channels.control.json().filter((m) => m.t === 'displays').pop();
  assert.equal(displays.current, '1');
  assert.equal(s.ended, false);
  s.end('test', { fromMain: true });
});

test('display gone: the served display has the same (no) box → no extra capture', async () => {
  const TWO = [
    { id: '1', name: 'A', primary: true, width: 2560, height: 1440, scaleFactor: 1 },
    { id: '2', name: 'B', primary: false, width: 1920, height: 1080, scaleFactor: 1 },
  ];
  const { log, env, s } = await displayVanishes(TWO);
  assert.equal(env.capture[1].constraints.video.width, undefined);
  env.capture[1].resolve(stream(false, { width: 2560, height: 1440 }));
  await flush();
  assert.equal(env.capture.length, 2);
  assert.deepEqual(log.filter((l) => l.startsWith('commit:')), ['commit:2', 'commit:1']);
  assert.equal(s.currentDisplayId, '1');
  assert.equal(s.ended, false);
  s.end('test', { fromMain: true });
});

test('display gone: if the extra capture fails, the fallback stream stays live and committed', async () => {
  const ULTRAWIDE = [
    { id: '1', name: 'A', primary: true, width: 2560, height: 1440, scaleFactor: 1 },
    { id: '2', name: 'Wide', primary: false, width: 5120, height: 1440, scaleFactor: 1 },
  ];
  const { log, env, s, events } = await displayVanishes(ULTRAWIDE);
  const squeezed = stream(false, { width: 1920, height: 1080 });
  env.capture[1].resolve(squeezed);
  await flush();
  assert.equal(env.capture.length, 3);
  const notices = events.notice.length;
  env.capture[2].reject(new Error('busy'));
  await flush();
  assert.equal(env.capture.length, 3);
  assert.equal(s.ended, false);
  assert.equal(s.currentDisplayId, '1');
  assert.equal(s.videoTrack, squeezed.getVideoTracks()[0]);
  assert.equal(squeezed.getVideoTracks()[0].readyState, 'live');
  assert.deepEqual(log.filter((l) => l.startsWith('commit:')), ['commit:2', 'commit:1']);
  assert.equal(events.notice.length, notices, 'no "could not capture" notice: the picture is fine');
  s.end('test', { fromMain: true });
});

test("commitDisplay without 'served' (older main) keeps the requested id", async () => {
  const { log, env, api, s } = await setup({ init: { audioSupported: false } });
  api.commitDisplay = async (id) => { log.push(`commit:${id}`); return { ok: false, error: 'not-found' }; };
  const started = s.start();
  await flush();
  env.capture[0].resolve(stream(false));
  await started;
  env.pcs[0].ice.select('100.64.0.1', '100.64.0.2');
  await flush();
  log.length = 0;
  s.requestDisplay('2');
  await flush();
  env.capture[1].resolve(stream(false));
  await flush();
  assert.deepEqual(log.filter((l) => l.startsWith('commit:')), ['commit:2']);
  assert.equal(s.currentDisplayId, '2');
  s.end('test', { fromMain: true });
});

test("'speed' preset: scaleResolutionDownBy follows the capture size so the encoded size stays even", async () => {
  const speed = { quality: 'speed', codec: 'auto', clipboardSync: true };
  const { env, s, pc } = await liveSession({ init: { audioSupported: false, settings: speed }, settings: { width: 2560, height: 1440 } });
  const video = pc.transceivers[0].sender;
  assert.equal(pc.transceivers[0].init.sendEncodings[0].scaleResolutionDownBy, 2, 'safe default before the size is known');
  await flush();
  assert.equal(video.sets.at(-1).encodings[0].scaleResolutionDownBy, 4 / 3, '2560×1440 → 1920×1080');
  // Display switch: a 3840×2160 capture → 2560×1440.
  s.requestDisplay('2');
  await flush();
  env.capture[1].resolve(stream(false, { width: 3840, height: 2160 }));
  await flush();
  assert.equal(s.currentDisplayId, '2');
  assert.equal(video.sets.at(-1).encodings[0].scaleResolutionDownBy, 1.5);
  // Preset change: balanced → 1, back to speed → per size again.
  s.setQuality('balanced');
  await flush();
  assert.equal(video.sets.at(-1).encodings[0].scaleResolutionDownBy, 1);
  s.setQuality('speed');
  await flush();
  assert.equal(video.sets.at(-1).encodings[0].scaleResolutionDownBy, 1.5);
  // The capture size changes without a swap (display mode change): the next stats tick re-derives it.
  const n = video.sets.length;
  s.videoTrack.settings = { width: 2560, height: 1600 };
  pc.setState('connected'); // starts the 1 s stats poll; its first tick runs on a 0 ms timer
  await new Promise((r) => setTimeout(r, 30));
  await flush();
  assert.ok(video.sets.length > n);
  const scale = video.sets.at(-1).encodings[0].scaleResolutionDownBy;
  assert.deepEqual([Math.round(2560 / scale), Math.round(1600 / scale)], [1728, 1080]);
  s.end('test', { fromMain: true });
});

test("'speed' preset: a transient odd capture size (2561×1440) is scaled like the size it settles at", async () => {
  const speed = { quality: 'speed', codec: 'auto', clipboardSync: true };
  const info = [];
  const origInfo = console.info;
  console.info = (...a) => info.push(a);
  try {
    const { s, pc } = await liveSession({ init: { audioSupported: false, settings: speed }, settings: { width: 2561, height: 1440 } });
    const video = pc.transceivers[0].sender;
    await flush();
    // Scaled from the first report on: no full-size first seconds.
    assert.equal(video.sets.at(-1).encodings[0].scaleResolutionDownBy, 4 / 3);
    assert.deepEqual(s._captureSize(), { width: 2560, height: 1440 });
    // One log line per capture with what Chromium delivered.
    const caps = info.filter((a) => a[0] === '[panel] capture settings');
    assert.equal(caps.length, 1);
    assert.deepEqual({ ...caps[0][1] }, { displayId: '1', width: 2561, height: 1440, limit: null });
    // It settles at 2560×1440: the stats tick sees the same (even) size → no second setParameters.
    const n = video.sets.length;
    s.videoTrack.settings = { width: 2560, height: 1440 };
    pc.setState('connected'); // starts the 1 s stats poll; its first tick runs on a 0 ms timer
    await new Promise((r) => setTimeout(r, 30));
    await flush();
    assert.equal(video.sets.length, n, 'no encoder reconfiguration when 2561 settles to 2560');
    s.end('test', { fromMain: true });
  } finally {
    console.info = origInfo;
  }
});
