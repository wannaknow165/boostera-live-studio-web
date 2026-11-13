// CAM LINK v1 — the phone client (public/cam/cam-link.js) driven with fakes: a fake RTCPeerConnection with
// controllable connectionState / iceGatheringState / candidates / getStats, fake mediaDevices and tracks,
// a fake fetch scripted per route, and a fake clock. No browser, no network, no real timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CamLink, TEXT, EXTRA_TEXT, NOTICE, TIMING, sortCodecs, mungeAnswer, limitCandidates, derivePill, normalizeStatus, readStats, videoConstraints, audioConstraints, linkHeaders, mountCamPage } from '../public/cam/cam-link.js';
import { opsView } from '../public/cam/ops.js';

const T0 = 1762000000000; // fixed "now" for the fake clock
const CRLF = '\r\n';
const sdp = lines => lines.join(CRLF) + CRLF;
const SESSION = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1'];
const AUDIO = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=mid:1', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1'];
const H264_FMTP = 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
const OFFER = sdp([...SESSION, 'm=video 9 UDP/TLS/RTP/SAVPF 102 103 96 97', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=sendonly', 'a=rtpmap:102 H264/90000', H264_FMTP, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96', ...AUDIO, 'a=sendonly']);
const ANSWER_H264 = sdp([...SESSION, 'm=video 9 UDP/TLS/RTP/SAVPF 102 103', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=recvonly', 'a=rtpmap:102 H264/90000', H264_FMTP, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', ...AUDIO, 'a=recvonly']);
const ANSWER_VP8 = sdp([...SESSION, 'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=recvonly', 'a=rtpmap:96 VP8/90000', 'a=rtcp-fb:96 nack pli', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96', ...AUDIO, 'a=recvonly']);
// what Chrome on Android lists: VP8 first, three H.264 flavours further down
const CAPS = [
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/red', clockRate: 90000 },
  { mimeType: 'video/ulpfec', clockRate: 90000 },
];

// ---- fakes ----------------------------------------------------------------------------------------------------

// fake clock: the client gets now()/timers from here, so 10 s deadlines and 30 s back-offs are exact and instant
function clock(start = T0) {
  let t = start, seq = 0;
  const pending = [];
  const timers = {
    setTimeout(fn, ms) { const h = { id: ++seq, at: t + Math.max(0, Number(ms) || 0), fn }; pending.push(h); return h; },
    clearTimeout(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = pending[0];
      if (!next || next.at > end) break;
      t = next.at; pending.shift(); next.fn(); await settle();
    }
    t = end; await settle();
  }
  return { now: () => t, timers, advance, settle, get pending() { return pending.length; } };
}

class Emitter {
  constructor() { this.handlers = new Map(); }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.handlers.get(type) || [])]) fn(event); }
  count(type) { return this.handlers.get(type)?.size || 0; }
}

class FakeTrack extends Emitter {
  constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; this.muted = false; this.enabled = true; this.stops = 0; }
  stop() { this.stops++; this.readyState = 'ended'; } // like the real one: stop() fires no event
  end() { this.readyState = 'ended'; this.emit('ended'); } // the browser ended it (another app took the camera)
  mute() { this.muted = true; this.emit('mute'); }
  unmute() { this.muted = false; this.emit('unmute'); }
}

class FakeStream {
  constructor(tracks) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter(t => t !== track); }
}

class FakeMedia extends Emitter {
  constructor() { super(); this.calls = []; this.script = []; this.streams = []; }
  async getUserMedia(constraints) {
    this.calls.push(constraints);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') await next();
    const tracks = [];
    if (constraints.video) tracks.push(new FakeTrack('video'));
    if (constraints.audio) tracks.push(new FakeTrack('audio'));
    const stream = new FakeStream(tracks);
    this.streams.push(stream);
    return stream;
  }
}
const domError = name => Object.assign(new Error(name), { name, code: 0 }); // a DOMException carries a numeric legacy code

class FakeDocument extends Emitter {
  constructor() { super(); this.visibilityState = 'visible'; }
  hide() { this.visibilityState = 'hidden'; this.emit('visibilitychange'); }
  show() { this.visibilityState = 'visible'; this.emit('visibilitychange'); }
}

class FakeSentinel extends Emitter {
  constructor() { super(); this.released = false; }
  async release() { if (this.released) return; this.released = true; this.emit('release'); }
}
function fakeWakeLock() {
  return { requests: [], sentinels: [], reject: false, request(type) { this.requests.push(type); if (this.reject) return Promise.reject(domError('NotAllowedError')); const s = new FakeSentinel(); this.sentinels.push(s); return Promise.resolve(s); } };
}

class FakePC {
  static made = [];
  static gather = 'complete'; // 'complete' = gathering is done as soon as the offer is set; 'manual' = the test drives it
  constructor(config) {
    this.config = config; this.transceivers = []; this.log = []; this.candidates = []; this.offerOptions = [];
    this.connectionState = 'new'; this.iceGatheringState = 'new'; this.localDescription = null; this.remoteDescription = null;
    this.closed = false; this.bytes = 0; this.frozen = false; this.restarts = 0;
    FakePC.made.push(this);
  }
  addTransceiver(track, init) {
    this.log.push('addTransceiver:' + track.kind);
    const sender = {
      track, replaced: [], sets: 0, params: { transactionId: 't', encodings: [{}] },
      getParameters() { return JSON.parse(JSON.stringify(this.params)); },
      async setParameters(p) { this.sets++; this.params = p; },
      async replaceTrack(next) { this.replaced.push(next); this.track = next; },
    };
    const transceiver = { sender, init, prefs: null, setCodecPreferences(list) { this.prefs = list; } };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  async createOffer(options) { this.log.push('createOffer'); this.offerOptions.push(options); return { type: 'offer', sdp: OFFER }; }
  async setLocalDescription(description) {
    this.log.push('setLocalDescription');
    const pc = this;
    this.localDescription = { type: description.type, get sdp() { return description.sdp + pc.candidates.map(c => 'a=' + c + CRLF).join(''); } };
    this.iceGatheringState = 'gathering';
    if (FakePC.gather === 'complete') { this.candidate('host'); this.gatherComplete(); }
  }
  async setRemoteDescription(description) { this.log.push('setRemoteDescription'); this.remoteDescription = description; this.connectionState = 'connecting'; }
  restartIce() { this.restarts++; }
  candidate(type) {
    const line = `candidate:${this.candidates.length + 1} 1 udp 2122260223 192.0.2.10 5000${this.candidates.length} typ ${type}`;
    this.candidates.push(line);
    this.onicecandidate?.({ candidate: { candidate: line, type } });
  }
  gatherComplete() { this.iceGatheringState = 'complete'; this.onicegatheringstatechange?.(); }
  set(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
  async getStats() {
    if (!this.frozen) this.bytes += 312500; // 2500 kbps when sampled once a second
    return new Map([
      ['V', { id: 'V', type: 'outbound-rtp', kind: 'video', bytesSent: this.bytes, frameWidth: 720, frameHeight: 1280, framesPerSecond: 30, qualityLimitationReason: 'none', encoderImplementation: 'ExternalEncoder (c2.exynos.h264.encoder)', codecId: 'C' }],
      ['A', { id: 'A', type: 'outbound-rtp', kind: 'audio', bytesSent: Math.round(this.bytes / 50) }],
      ['C', { id: 'C', type: 'codec', mimeType: 'video/H264' }],
      ['R', { id: 'R', type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.004, fractionLost: 0.015 }],
      ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
      ['P', { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.003, localCandidateId: 'L', remoteCandidateId: 'M' }],
      ['L', { id: 'L', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
      ['M', { id: 'M', type: 'remote-candidate', candidateType: 'prflx', protocol: 'udp' }],
    ]);
  }
  close() { this.closed = true; this.connectionState = 'closed'; }
}

const statusBody = (over = {}) => ({
  version: '1.3.0', serverTime: T0, iceServers: over.iceServers || [],
  program: { online: true, ready: true, throttled: false, ...over.program },
  link: { state: 'idle', mine: false, since: 0, echoAgeMs: null, stats: { w: 0, h: 0, fps: 0, kbps: 0, rttMs: 0, lossPct: 0 }, audio: { wanted: false, playing: false, level: 0 }, path: null, lastError: null, ...over.link },
  air: { known: false, live: false, ...over.air },
});
// what the hub answers while the program page shows this phone's picture
const linked = (over = {}) => statusBody({
  ...over,
  link: { state: 'connected', mine: true, since: T0, echoAgeMs: 200, stats: { w: 720, h: 1280, fps: 30, kbps: 2100, rttMs: 4, lossPct: 0 }, audio: { wanted: false, playing: false, level: 0 }, path: { local: 'host', remote: 'host', protocol: 'udp' }, ...over.link },
});

// mocked fetch: records every call and answers per route. api.status / api.whip script the replies.
function fakeApi(c) {
  const calls = [];
  const api = {
    calls, linked: false, status: null, whip: [], pair: [], answer: ANSWER_H264, stateFail: null,
    of: (method, path) => calls.filter(x => x.method === method && (path instanceof RegExp ? path.test(x.path) : x.path === path)),
  };
  const reply = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    async json() { return typeof body === 'string' ? JSON.parse(body) : body; },
  });
  api.fetchImpl = async (url, init = {}) => {
    const u = new URL(url, 'http://gateway.test');
    const call = { method: init.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...(init.headers || {}) }, body: init.body, keepalive: init.keepalive === true, at: c.now() - T0 };
    calls.push(call);
    if (call.method === 'GET' && call.path === '/api/link/status') {
      const r = typeof api.status === 'function' ? await api.status(call) : api.status;
      if (r instanceof Error) throw r;
      if (r?.http) return reply(r.http, { error: r.error || 'REQUEST_FAILED' });
      return reply(200, r || (api.linked ? linked() : statusBody()));
    }
    if (call.method === 'POST' && call.path === '/api/link/whip') {
      let r = api.whip.length ? api.whip.shift() : 201;
      if (typeof r === 'function') r = await r(call);
      if (r instanceof Error) throw r;
      if (r === 201) return reply(201, api.answer, { 'content-type': 'application/sdp', location: '/api/link/whip/' + call.headers['X-Link-Attempt'] });
      return reply(r.http, { error: r.error });
    }
    if (call.method === 'POST' && call.path === '/api/link/state') { if (api.stateFail) throw api.stateFail; return reply(200, { ok: true }); }
    if (call.method === 'POST' && call.path === '/api/mobile/pair') { // the gateway's own pairing route (it sets the session cookie)
      const r = api.pair.length ? api.pair.shift() : 200;
      if (r instanceof Error) throw r;
      if (r === 200) { api.status = null; return reply(200, { ok: true, device: { id: 'abc123', label: 'x' } }); }
      return typeof r.body === 'string' ? reply(r.http, r.body) : reply(r.http, { error: r.error });
    }
    if (call.method === 'DELETE' && /^\/api\/link\/whip\/[\w-]+$/.test(call.path)) return reply(200, { ok: true });
    if (call.method === 'POST' && /^\/api\/link\/whip\/[\w-]+\/bye$/.test(call.path)) return reply(200, { ok: true });
    return reply(404, { error: 'NOT_FOUND' });
  };
  return api;
}

// one phone: the client with every dependency faked. ids are id-1 (the page's client id), id-2 (first attempt), id-3 …
function rig(options = {}) {
  const c = clock(), api = fakeApi(c), media = new FakeMedia(), doc = new FakeDocument(), win = new Emitter(), wake = fakeWakeLock();
  FakePC.made = []; FakePC.gather = 'complete';
  let n = 0;
  const states = [], previews = [];
  const link = new CamLink({
    fetch: api.fetchImpl, PeerConnection: FakePC, mediaDevices: media, RtpSender: { getCapabilities: () => ({ codecs: CAPS }) }, RtpReceiver: null,
    now: c.now, timers: c.timers, wakeLock: wake, document: doc, window: win, randomId: () => 'id-' + ++n,
    onState: s => { if (states.at(-1) !== s.state) states.push(s.state); }, onPreview: t => previews.push(t), ...options,
  });
  const h = { c, api, media, doc, win, wake, link, states, previews, pcs: FakePC.made };
  h.camera = () => media.streams[0].getVideoTracks()[0];
  h.mic = () => media.streams[0].getAudioTracks()[0];
  h.whips = () => api.of('POST', '/api/link/whip');
  h.statePosts = () => api.of('POST', '/api/link/state').map(x => JSON.parse(x.body));
  return h;
}
// tap, let the offer go out, and let the newest connection connect while the hub reports the link as ours
async function goLive(h, options) {
  await h.link.start(options);
  await h.c.settle();
  h.api.linked = true;
  h.pcs.at(-1).set('connected');
  await h.c.settle();
  assert.equal(h.link.state, 'live');
  return h.pcs.at(-1);
}
// …and let it hold for 10 s: only a link that held restarts the retry delays at 0 s
async function goLiveProven(h, options) {
  const pc = await goLive(h, options);
  await h.c.advance(10000);
  return pc;
}

// ---- the tap -------------------------------------------------------------------------------------------------

test('one tap: wake lock, ONE getUserMedia, status, a sendonly H.264-first offer, WHIP, the munged answer, live on connected', async () => {
  const h = rig();
  h.api.status = statusBody({ iceServers: [{ urls: 'stun:stun.example.org:3478' }] });
  const tap = h.link.start();
  assert.deepEqual(h.wake.requests, ['screen'], 'the wake lock is asked for inside the tap, before anything is awaited');
  assert.equal(h.media.calls.length, 1, 'getUserMedia is called inside the tap too');
  assert.equal(h.link.state, 'acquiring');
  await tap; await h.c.settle();

  assert.deepEqual(h.media.calls, [{
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
  }], 'ONE prompt for camera and microphone together');
  assert.equal(h.previews[0], h.camera(), 'the self-view gets the raw camera track');

  const [status, whip] = h.api.calls;
  assert.equal(status.method + ' ' + status.path, 'GET /api/link/status', 'status comes first: iceServers and whether the program is online');
  assert.deepEqual(status.query, { attempt: 'id-2' });
  assert.equal(status.headers['X-Link-Client'], 'id-1');

  assert.equal(h.pcs.length, 1);
  const pc = h.pcs[0];
  assert.deepEqual(pc.config, { iceServers: [{ urls: ['stun:stun.example.org:3478'] }], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  assert.deepEqual(pc.log, ['addTransceiver:video', 'addTransceiver:audio', 'createOffer', 'setLocalDescription', 'setRemoteDescription'], 'the offer is made only after the tracks exist');
  const [video, audio] = pc.transceivers;
  assert.equal(video.sender.track, h.camera()); assert.equal(audio.sender.track, h.mic());
  for (const t of pc.transceivers) { assert.equal(t.init.direction, 'sendonly'); assert.deepEqual(t.init.streams, [h.media.streams[0]]); }
  assert.equal(video.prefs[0].mimeType, 'video/H264', 'H.264 first when the phone lists it');
  assert.equal(video.prefs.length, CAPS.length, 'sorted, not filtered');
  assert.equal(audio.prefs, null);
  assert.deepEqual(video.sender.params.encodings[0], { maxBitrate: 2500000, maxFramerate: 30 });
  assert.equal(video.sender.params.degradationPreference, 'maintain-framerate');
  assert.deepEqual(audio.sender.params.encodings[0], { maxBitrate: 96000 });

  assert.equal(whip.method + ' ' + whip.path, 'POST /api/link/whip');
  assert.deepEqual(whip.headers, { 'X-Link-Client': 'id-1', 'Content-Type': 'application/sdp', 'X-Link-Attempt': 'id-2' }, 'no takeover header on an ordinary tap');
  assert.equal(whip.body, pc.localDescription.sdp, 'the body is pc.localDescription.sdp');
  assert.ok(whip.body.includes('typ host') && !OFFER.includes('typ host'), '…which carries the gathered candidates (the createOffer string has none)');
  assert.ok(pc.remoteDescription.sdp.includes(H264_FMTP + ';x-google-start-bitrate=2000'), 'the answer is munged before it is applied');
  assert.equal(pc.remoteDescription.type, 'answer');
  assert.equal(h.link.state, 'connecting');
  assert.equal(h.link.snapshot().pill.text, 'מתחברת לאולפן…');

  h.api.status = null; h.api.linked = true;
  pc.set('connected'); await h.c.settle();
  assert.deepEqual(h.states, ['acquiring', 'offering', 'connecting', 'live']);
  assert.equal(h.link.snapshot().tracksLive, true);
  assert.equal(h.link.snapshot().attempts, 1);
  assert.equal(pc.restarts, 0);
});

test('?voice=1 asks for the call profile and ?codec=vp8 puts VP8 first; a phone without H.264 keeps the browser order', async () => {
  const voice = rig({ voice: true, codec: 'vp8' });
  await voice.link.start(); await voice.c.settle();
  assert.deepEqual(voice.media.calls[0].audio, { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
  assert.deepEqual(voice.media.calls[0].video, videoConstraints());
  assert.equal(voice.pcs[0].transceivers[0].prefs[0].mimeType, 'video/VP8');
  assert.equal(voice.pcs[0].transceivers[0].prefs.length, CAPS.length);

  const plain = rig({ RtpSender: { getCapabilities: () => ({ codecs: CAPS.filter(c => c.mimeType !== 'video/H264') }) } });
  await plain.link.start(); await plain.c.settle();
  assert.equal(plain.pcs[0].transceivers[0].prefs, null, 'no preference is set, normal negotiation decides');
  assert.equal(plain.link.state, 'connecting');

  const odd = rig({ codec: 'hevc' });
  await odd.link.start(); await odd.c.settle();
  assert.equal(odd.pcs[0].transceivers[0].prefs[0].mimeType, 'video/H264', 'an unknown ?codec= value means the default');
});

test('a browser that validates preferences against its receive list still gets H.264 first; one that refuses both still connects', async () => {
  class Picky extends FakePC {
    addTransceiver(track, init) { const t = super.addTransceiver(track, init); const set = t.setCodecPreferences; t.tries = []; t.setCodecPreferences = function (list) { this.tries.push(list); if (list.some(c => c.sendOnly)) throw domError('InvalidModificationError'); set.call(this, list); }; return t; }
  }
  const sendCaps = [...CAPS, { mimeType: 'video/AV1', clockRate: 90000, sendOnly: true }];
  const h = rig({ PeerConnection: Picky, RtpSender: { getCapabilities: () => ({ codecs: sendCaps }) }, RtpReceiver: { getCapabilities: () => ({ codecs: CAPS }) } });
  await h.link.start(); await h.c.settle();
  const video = h.pcs[0].transceivers[0];
  assert.equal(video.tries.length, 2);
  assert.equal(video.prefs[0].mimeType, 'video/H264'); assert.equal(video.prefs.length, CAPS.length);
  assert.equal(h.link.state, 'connecting');

  const none = rig({ PeerConnection: Picky, RtpSender: { getCapabilities: () => ({ codecs: sendCaps }) }, RtpReceiver: { getCapabilities: () => ({ codecs: sendCaps }) } });
  await none.link.start(); await none.c.settle();
  assert.equal(none.pcs[0].transceivers[0].prefs, null);
  assert.equal(none.link.state, 'connecting', 'a codec preference is optional');
});

test('gather-done: complete, or a host candidate and 300 ms of quiet, or 2000 ms; then pc.localDescription.sdp is sent', async () => {
  const quiet = rig(); FakePC.gather = 'manual';
  await quiet.link.start(); await quiet.c.settle();
  const pc = quiet.pcs[0];
  assert.equal(quiet.whips().length, 0, 'nothing is sent while candidates are still coming');
  pc.candidate('srflx'); await quiet.c.advance(1000);
  assert.equal(quiet.whips().length, 0, 'a reflexive candidate alone does not start the quiet timer');
  pc.candidate('host'); await quiet.c.advance(299);
  assert.equal(quiet.whips().length, 0);
  pc.candidate('host'); await quiet.c.advance(299);
  assert.equal(quiet.whips().length, 0, 'a new candidate restarts the 300 ms');
  await quiet.c.advance(1);
  assert.equal(quiet.whips().length, 1);
  assert.equal(quiet.whips()[0].body, pc.localDescription.sdp);
  assert.equal((quiet.whips()[0].body.match(/a=candidate:/g) || []).length, 3, 'with every candidate gathered so far');
  assert.equal(quiet.whips()[0].at, 1599);

  const cap = rig(); FakePC.gather = 'manual';
  await cap.link.start(); await cap.c.settle();
  cap.pcs[0].candidate('srflx');
  await cap.c.advance(1999); assert.equal(cap.whips().length, 0);
  await cap.c.advance(1); assert.equal(cap.whips().length, 1, 'never longer than 2000 ms (Safari may never say "complete")');

  const done = rig(); FakePC.gather = 'manual';
  await done.link.start(); await done.c.settle();
  done.pcs[0].gatherComplete(); await done.c.settle();
  assert.equal(done.whips().length, 1); assert.equal(done.whips()[0].at, 0);
});

test('denied, busy camera and an insecure page each get their own state, release everything and can be tried again', async () => {
  const h = rig();
  h.media.script.push(domError('NotAllowedError'));
  await h.link.start(); await h.c.settle();
  assert.equal(h.link.state, 'denied'); assert.equal(h.link.snapshot().error, 'NOT_ALLOWED_ERROR');
  assert.equal(NOTICE.denied, 'אין אישור למצלמה או למיקרופון. פתחי את הגדרות האתר בדפדפן, אשרי את שניהם ולחצי נסי שוב');
  assert.equal(h.api.calls.length, 0, 'nothing is sent to the studio without a camera');
  assert.equal(h.wake.sentinels[0].released, true, 'the wake lock is given back');
  assert.equal(h.c.pending, 0);

  h.media.script.push(domError('NotReadableError'));
  await h.link.start(); await h.c.settle();
  assert.equal(h.link.state, 'busy_camera');
  assert.equal(NOTICE.busy_camera, 'אפליקציה אחרת משתמשת במצלמה. סגרי אותה ונסי שוב');

  await goLive(h); // "try again" works
  assert.equal(h.media.calls.length, 3);

  const insecure = rig({ mediaDevices: null });
  await insecure.link.start();
  assert.equal(insecure.link.state, 'denied'); assert.equal(insecure.link.snapshot().error, 'CAMERA_UNSUPPORTED');
});

// ---- waiting for the studio ----------------------------------------------------------------------------------

test('program offline: no offer is made, status is polled every 3 s, and the offer goes out by itself when the program is online', async () => {
  const h = rig();
  h.api.status = statusBody({ program: { online: false, ready: false } });
  await h.link.start(); await h.c.settle();
  assert.equal(h.link.state, 'program_offline');
  assert.equal(h.link.snapshot().pill.text, 'האולפן דלוק, מסך השידור עוד נפתח. מנסה שוב לבד…');
  assert.equal(h.pcs.length, 0); assert.equal(h.whips().length, 0);
  assert.equal(h.link.snapshot().tracksLive, true, 'the camera stays on while she waits');
  await h.c.advance(2999); assert.equal(h.api.of('GET', '/api/link/status').length, 1);
  await h.c.advance(1); assert.equal(h.api.of('GET', '/api/link/status').length, 2);
  await h.c.advance(3000); assert.equal(h.api.of('GET', '/api/link/status').length, 3);
  assert.equal(h.link.state, 'program_offline');

  h.api.status = null; // online now
  await h.c.advance(3000);
  assert.equal(h.whips().length, 1); assert.equal(h.whips()[0].at, 9000);
  assert.equal(h.link.state, 'connecting');
  h.api.linked = true; h.pcs[0].set('connected'); await h.c.settle();
  assert.equal(h.link.state, 'live');
  assert.equal(h.media.calls.length, 1, 'still the one getUserMedia');
});

test('503 PROGRAM_OFFLINE on the offer is the same wait; 504 PROGRAM_TIMEOUT is retried with a new attempt id', async () => {
  const h = rig();
  h.api.whip.push({ http: 503, error: 'PROGRAM_OFFLINE' });
  await h.link.start(); await h.c.settle();
  assert.equal(h.link.state, 'program_offline');
  assert.equal(h.pcs[0].closed, true, 'the unanswered connection is closed');
  assert.equal(h.api.of('DELETE', /whip/).length, 0, 'nothing to delete: the hub made no resource');
  await h.c.advance(3000);
  assert.equal(h.whips().length, 2);
  assert.equal(h.link.state, 'connecting');

  const t = rig();
  t.api.whip.push({ http: 504, error: 'PROGRAM_TIMEOUT' });
  await t.link.start(); await t.c.settle();
  assert.equal(t.link.state, 'offering'); assert.equal(t.link.snapshot().error, 'PROGRAM_TIMEOUT');
  assert.equal(t.link.snapshot().pill.text, 'מתחברת לאולפן…');
  assert.equal(t.pcs[0].closed, true);
  await t.c.advance(999); assert.equal(t.whips().length, 1);
  await t.c.advance(1); assert.equal(t.whips().length, 2);
  assert.deepEqual(t.whips().map(w => w.headers['X-Link-Attempt']), ['id-2', 'id-3']);
  assert.notEqual(t.pcs[1], t.pcs[0]);
  t.api.linked = true; t.pcs[1].set('connected'); await t.c.settle();
  assert.equal(t.link.state, 'live');
});

test('retries wait 0, 1, 2, 4, 8, 15, 30, 30 … seconds, for as long as the page is visible and she has not pressed stop', async () => {
  const h = rig();
  h.api.whip.push(...Array(9).fill({ http: 504, error: 'PROGRAM_TIMEOUT' }));
  await h.link.start(); await h.c.settle();
  await h.c.advance(125000);
  const at = h.whips().map(w => w.at);
  assert.deepEqual(at.slice(1).map((x, i) => x - at[i]), [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000]);
  assert.equal(h.link.state, 'offering');
  await h.c.advance(30000); // the tenth offer is answered
  assert.equal(h.link.state, 'connecting');
  assert.equal(h.link.snapshot().tracksLive, true);
});

test('no path: not connected within 10 s of setRemoteDescription -> no_path, the attempt is deleted, and it retries', async () => {
  const h = rig();
  await h.link.start(); await h.c.settle();
  assert.equal(h.link.state, 'connecting');
  await h.c.advance(9999); assert.equal(h.link.state, 'connecting');
  await h.c.advance(1);
  assert.equal(h.link.state, 'no_path');
  assert.equal(h.link.snapshot().pill.text, 'אין נתיב ישיר לאולפן · בדקי שהטלפון על אותה רשת Wi‑Fi');
  assert.equal(h.link.snapshot().error, 'ICE_NO_PATH');
  assert.equal(h.pcs[0].closed, true);
  assert.deepEqual(h.api.of('DELETE', /whip/).map(x => x.path), ['/api/link/whip/id-2'], 'the hub is told to let the dead attempt go');
  assert.equal(h.camera().readyState, 'live', 'the camera stays on');

  await h.c.advance(999); assert.equal(h.whips().length, 1);
  await h.c.advance(1); assert.equal(h.whips().length, 2);
  assert.equal(h.link.state, 'no_path', 'the advice stays on screen while it tries again');
  h.pcs[1].set('failed'); await h.c.settle(); // ICE says so before the 10 s are over
  assert.equal(h.link.snapshot().error, 'ICE_FAILED');
  assert.equal(h.pcs[1].closed, true);
  await h.c.advance(2000);
  assert.equal(h.whips().length, 3);
  h.api.linked = true; h.pcs[2].set('connected'); await h.c.settle();
  assert.equal(h.link.state, 'live');
  assert.deepEqual(h.states, ['acquiring', 'offering', 'connecting', 'no_path', 'live']);
  await h.c.advance(20000);
  assert.equal(h.link.state, 'live', 'no deadline is left behind');
});

test('the studio cannot be reached: server_unreachable with the camera kept, retried, and connected when it is back', async () => {
  const h = rig();
  h.api.status = new Error('network down');
  await h.link.start(); await h.c.settle();
  assert.equal(h.link.state, 'server_unreachable');
  assert.equal(h.link.snapshot().pill.text, 'האולפן שלך לא זמין כרגע. זה לא בטלפון שלך.');
  assert.equal(h.pcs.length, 0);
  h.api.status = { http: 502 };
  await h.c.advance(1000);
  assert.equal(h.link.state, 'server_unreachable'); assert.equal(h.link.snapshot().error, 'STATUS_HTTP_502');
  h.api.status = null; h.api.whip.push(new Error('connection reset'));
  await h.c.advance(2000);
  assert.equal(h.link.snapshot().error, 'WHIP_UNREACHABLE');
  await h.c.advance(4000);
  assert.equal(h.link.state, 'connecting');
});

test('a phone that is not paired (401) is told so; a check before any tap avoids a useless camera prompt', async () => {
  const h = rig();
  h.api.status = { http: 401, error: 'PAIRING_REQUIRED' };
  await h.link.preflight();
  assert.equal(h.link.state, 'unpaired'); assert.equal(h.media.calls.length, 0);
  assert.equal(NOTICE.unpaired, 'הטלפון לא משויך לאולפן');
  h.api.status = null;
  h.win.emit('pageshow'); await h.c.settle(); // back from the pairing page
  assert.equal(h.link.state, 'idle');

  const tapped = rig();
  tapped.api.status = { http: 401, error: 'PAIRING_REQUIRED' };
  await tapped.link.start(); await tapped.c.settle();
  assert.equal(tapped.link.state, 'unpaired'); assert.equal(tapped.link.snapshot().error, 'PAIRING_REQUIRED');
  assert.equal(tapped.camera().readyState, 'ended', 'nothing to send to: the camera is released');
  assert.equal(tapped.c.pending, 0);

  const down = rig();
  down.api.status = new Error('offline');
  await down.link.preflight();
  assert.equal(down.link.state, 'idle', 'an unreachable gateway is reported only after the tap');
});

test('pairing from the page: the 8-digit code goes to the gateway\'s pairing route; then the start card, or the next offer of a running recovery', async () => {
  const h = rig();
  h.api.status = { http: 401, error: 'PAIRING_REQUIRED' };
  await h.link.preflight(); assert.equal(h.link.state, 'unpaired');
  assert.deepEqual(await h.link.pair('1234'), { ok: false, error: 'INVALID_PAIRING_CODE' }, 'not 8 digits: nothing is sent');
  assert.equal(h.api.of('POST', '/api/mobile/pair').length, 0);
  h.api.pair.push({ http: 401, error: 'INVALID_PAIRING_CODE' }, { http: 429, error: 'TOO_MANY_ATTEMPTS' }, { http: 502, body: '<html>bad gateway</html>' }, new Error('offline'));
  assert.deepEqual(await h.link.pair('12345678'), { ok: false, error: 'INVALID_PAIRING_CODE' });
  assert.deepEqual(await h.link.pair('12345678'), { ok: false, error: 'TOO_MANY_ATTEMPTS' });
  assert.deepEqual(await h.link.pair('12345678'), { ok: false, error: 'PAIR_HTTP_502' }, 'nothing free-form from a proxy page');
  assert.deepEqual(await h.link.pair('12345678'), { ok: false, error: 'PAIR_UNREACHABLE' });
  assert.equal(h.link.state, 'unpaired'); assert.equal(h.media.calls.length, 0, 'pairing never touches the camera');
  assert.deepEqual(await h.link.pair(' 1234 5678 ', 'Android cam <b>'), { ok: true });
  const sent = h.api.of('POST', '/api/mobile/pair').at(-1);
  assert.deepEqual(JSON.parse(sent.body), { code: '12345678', label: 'Android cam b' }); assert.equal(sent.headers['Content-Type'], 'application/json');
  assert.equal(h.link.state, 'idle', 'paired: the notice gives way to the start card');
  assert.equal(h.c.pending, 0);

  // the pairing ran out while she was live (12 h, or the gateway was restarted): the camera stays, and pairing again resumes the recovery
  const live = rig();
  const pc = await goLiveProven(live);
  live.api.status = { http: 401, error: 'PAIRING_REQUIRED' };
  pc.set('failed'); await live.c.settle();
  assert.equal(live.link.state, 'unpaired'); assert.equal(live.camera().readyState, 'live', 'media is left alone'); assert.equal(live.whips().length, 1);
  assert.deepEqual(await live.link.pair('87654321'), { ok: true }); await live.c.settle();
  assert.equal(live.whips().length, 2, 'the next offer goes out at once'); assert.equal(live.camera().readyState, 'live');
  live.api.linked = true; live.pcs.at(-1).set('connected'); await live.c.settle();
  assert.equal(live.link.state, 'live');
});

test('a gateway restart: "not mine" is not counted before the program page is back, and a link the hub adopted again needs no new offer', async () => {
  // the gateway is back as an empty process: status answers, but no program page has polled it yet -> nothing can have adopted the link
  const h = rig();
  const pc = await goLiveProven(h);
  h.api.status = statusBody({ program: { online: false, ready: false } });
  await h.c.advance(8000);
  assert.equal(h.link.state, 'live'); assert.equal(h.pcs.length, 1, 'no recovery while the program is offline: the media still flows');
  // the page found the gateway again (online); its echo, and with it the adoption, comes a moment later: 3 s of grace from here
  h.api.status = statusBody({ program: { online: true, ready: false } });
  await h.c.advance(2000); assert.equal(h.link.state, 'live');
  h.api.status = null; // adopted: mine and connected again
  await h.c.advance(10000);
  assert.equal(h.link.state, 'live'); assert.equal(h.pcs.length, 1); assert.equal(h.whips().length, 1, 'the healthy connection was never replaced');
  // online and still not mine after 3 s: somebody else holds the link -> the usual recovery
  h.api.status = statusBody({ link: { state: 'connected', mine: false } });
  await h.c.advance(4000);
  assert.equal(h.link.snapshot().error, 'LINK_NOT_MINE'); assert.equal(h.pcs.length, 2);

  // the recovery has started, the program was offline for its attempt, and the hub adopts the link before any offer left the phone
  const late = rig();
  const kept = await goLiveProven(late);
  // (the heartbeat asks with the running attempt's id and sees the page online; the new attempt's own look a moment later finds it gone)
  late.api.status = call => statusBody({ program: { online: call.query.attempt === 'id-2' } });
  await late.c.advance(4000);
  assert.equal(late.link.state, 'program_offline'); assert.equal(late.link.snapshot().error, 'PROGRAM_OFFLINE'); assert.equal(late.whips().length, 1, 'no offer was sent');
  late.api.status = null; // the hub has adopted the running link: mine, connected, a fresh echo
  await late.c.advance(1000);
  assert.equal(late.link.state, 'live', 'healed by the hub\'s own word'); assert.equal(late.link.snapshot().error, null);
  await late.c.advance(30000);
  assert.equal(late.whips().length, 1, 'no offer follows'); assert.equal(kept.closed, false); assert.equal(late.pcs.filter(p => !p.closed).length, 1);

  // …but a recovery that started from the phone's own evidence (nothing leaves it) is not called off by the hub's word
  const flat = rig();
  const dead = await goLiveProven(flat);
  flat.api.whip.push(() => new Promise(() => {})); // the offer stays parked
  dead.frozen = true; await flat.c.advance(6000);
  assert.equal(flat.link.snapshot().error, 'BYTES_FLAT'); assert.equal(flat.link.state, 'recovering');
  await flat.c.advance(3000); assert.equal(flat.link.state, 'recovering');
});

test('a permission that was taken away while live is said (the denied notice), not retried for ever behind an amber pill', async () => {
  // both tracks ended and the permission is gone: nothing is left to send
  const h = rig();
  await goLiveProven(h);
  const attempt = h.whips()[0].headers['X-Link-Attempt'];
  h.media.script.push(domError('NotAllowedError'));
  h.camera().stop(); h.mic().stop(); h.camera().emit('ended'); await h.c.settle();
  assert.equal(h.link.state, 'denied'); assert.equal(h.link.snapshot().error, 'NOT_ALLOWED_ERROR');
  assert.equal(NOTICE.denied, TEXT.denied);
  assert.deepEqual(h.api.of('DELETE', /whip/).map(x => x.path), ['/api/link/whip/' + attempt], 'the hub is told to let the link go');
  assert.equal(h.pcs[0].closed, true); assert.equal(h.c.pending, 0, 'no retry keeps running');
  await h.link.start(); await h.c.settle(); assert.equal(h.link.state, 'connecting', '"try again" is a tap: the browser may ask her again');

  // the camera is refused but the microphone still flows: one refusal can be a passing "not now"; the second one in a row is final
  const half = rig();
  const pc = await goLiveProven(half);
  half.media.script.push(domError('NotAllowedError'), domError('NotAllowedError'));
  half.camera().end(); await half.c.settle();
  assert.equal(half.link.state, 'interrupted'); assert.equal(half.mic().readyState, 'live'); assert.equal(pc.closed, false);
  await half.c.advance(1000);
  assert.equal(half.link.state, 'denied'); assert.equal(half.mic().readyState, 'ended'); assert.equal(pc.closed, true);

  // any other failure (another app holds the camera) keeps trying, as before
  const busy = rig();
  await goLiveProven(busy);
  busy.media.script.push(domError('NotReadableError'), domError('NotReadableError'), domError('NotReadableError'));
  busy.camera().end(); await busy.c.settle(); await busy.c.advance(3000);
  assert.equal(busy.link.state, 'interrupted'); assert.equal(busy.media.calls.length, 4);
  await busy.c.advance(4000); assert.equal(busy.link.state, 'live', 'the camera came back');
});

test('the pill: her own mute is not blamed on the studio, and a frame rate that hovers around 15 does not make it flicker', async () => {
  const heard = { audio: { wanted: true, playing: true, level: 0 } };
  const muted = (link, extra = {}) => derivePill({ state: 'live', status: normalizeStatus(linked({ link })), control: 'ok', micMuted: true, ...extra });
  assert.deepEqual(muted(heard), { tone: 'ok', text: TEXT.seen, sub: TEXT.micMuted, air: false }, 'seen, and the second line says why she is not heard');
  assert.deepEqual(muted(heard, { levelFresh: true }), { tone: 'ok', text: TEXT.seen, sub: TEXT.micMuted, air: false }, 'never "seen and heard" beside a muted microphone');
  assert.deepEqual(muted({}), { tone: 'ok', text: TEXT.seen, sub: TEXT.audioOffTest, air: false }, 'the studio plays no sound at all: that is still the thing to know');
  assert.equal(muted({ ...heard, echoAgeMs: 4000 }).text, TEXT.connecting, 'muted or not, green needs a fresh echo');
  // through the client
  const h = rig();
  await goLive(h);
  h.api.status = linked({ link: { audio: { wanted: true, playing: true, level: 0.3 } } });
  await h.c.advance(1000); assert.equal(h.link.snapshot().pill.text, TEXT.seenHeard);
  h.link.toggleMic();
  assert.deepEqual([h.link.snapshot().pill.tone, h.link.snapshot().pill.text, h.link.snapshot().pill.sub], ['ok', TEXT.seen, TEXT.micMuted], 'at once, not after 5 s of silence');
  h.api.status = linked({ link: { audio: { wanted: true, playing: true, level: 0 } } });
  await h.c.advance(8000); assert.equal(h.link.snapshot().pill.text, TEXT.seen, 'and it never turns into "the studio does not play your voice"');
  h.link.toggleMic(); await h.c.advance(1000);
  assert.equal(h.link.snapshot().pill.text, TEXT.seenNotHeard, 'unmuted and no level for more than 5 s: now it is the truth');

  // frames: green at 15 or more; once green, left only below 10 on two statuses in a row
  const f = rig();
  await goLive(f);
  const at = fps => { f.api.status = linked({ link: { stats: { w: 720, h: 1280, fps, kbps: 900, rttMs: 4, lossPct: 0 } } }); return f.c.advance(1000).then(() => f.link.snapshot().pill.tone); };
  assert.equal(await at(14), 'busy', 'never reached 15: not green (the spec\'s threshold)');
  assert.equal(await at(15), 'ok');
  for (const fps of [14, 15, 13, 16, 12, 10]) assert.equal(await at(fps), 'ok', 'hovering around 15 stays green: ' + fps);
  assert.equal(await at(9), 'ok', 'one low reading is not enough');
  assert.equal(await at(12), 'ok'); assert.equal(await at(9), 'ok');
  assert.equal(await at(8), 'busy', 'below 10 twice in a row: she is not really seen');
  assert.equal(await at(14), 'busy', 'and back only at 15');
  assert.equal(await at(15), 'ok');
  f.api.status = linked({ link: { state: 'stalled', stats: { w: 720, h: 1280, fps: 30, kbps: 900, rttMs: 4, lossPct: 0 } } });
  await f.c.advance(1000); assert.equal(f.link.snapshot().pill.tone, 'busy');
  assert.equal(await at(14), 'busy', 'a link that was not "connected" starts from the threshold again');
  // the pure function without a memory decides on the status alone, as the spec writes it
  assert.equal(derivePill({ state: 'live', status: normalizeStatus(linked({ link: { stats: { w: 1, h: 1, fps: 14, kbps: 1, rttMs: 1, lossPct: 0 } } })) }).tone, 'busy');
  assert.equal(derivePill({ state: 'live', status: normalizeStatus(linked({ link: { stats: { w: 1, h: 1, fps: 14, kbps: 1, rttMs: 1, lossPct: 0 } } })), fpsOk: true }).tone, 'ok');
  assert.equal(derivePill({ state: 'live', status: normalizeStatus(linked()), fpsOk: false }).tone, 'busy');
});

// ---- another device ------------------------------------------------------------------------------------------

test('LINK_REPLACED: stops retrying, releases the tracks, and "bring it back here" sends the takeover header once', async () => {
  const h = rig();
  h.api.whip.push({ http: 409, error: 'LINK_REPLACED' });
  await h.link.start(); await h.c.settle();
  assert.equal(h.link.state, 'replaced');
  assert.equal(NOTICE.replaced, 'המצלמה עברה למכשיר אחר'); assert.equal(TEXT.takeover, 'החזירי לכאן');
  const first = h.media.streams[0];
  assert.deepEqual(first.getTracks().map(t => t.readyState), ['ended', 'ended'], 'camera and microphone are released');
  assert.equal(h.pcs[0].closed, true);
  assert.equal(h.previews.at(-1), null);
  assert.equal(h.wake.sentinels[0].released, true);
  assert.equal(h.c.pending, 0, 'no timer is left');
  const before = h.api.calls.length;
  await h.c.advance(120000);
  assert.equal(h.api.calls.length, before, 'no retry, no heartbeat, no delete');

  h.api.whip.push({ http: 504, error: 'PROGRAM_TIMEOUT' }); // the takeover offer itself times out…
  await h.link.start({ takeover: true }); await h.c.settle();
  assert.equal(h.media.calls.length, 2, 'the tap takes camera and microphone again');
  assert.equal(h.whips()[1].headers['X-Link-Takeover'], '1');
  await h.c.advance(1000);
  assert.equal(h.whips().length, 3);
  assert.equal(h.whips()[2].headers['X-Link-Takeover'], undefined, '…and the automatic retry never takes a link over');
  h.api.linked = true; h.pcs.at(-1).set('connected'); await h.c.settle();
  assert.equal(h.link.state, 'live');
});

test('replaced while live: the hub reports the link is no longer mine -> a re-offer -> 409 REPLACED -> everything is released', async () => {
  const h = rig();
  const pc = await goLiveProven(h);
  h.api.status = linked({ link: { mine: false } }); // another phone took over
  h.api.whip.push({ http: 409, error: 'REPLACED' });
  await h.c.advance(3999);
  assert.equal(h.link.state, 'live'); assert.equal(h.pcs.length, 1, 'a short "not mine" (a restarted gateway re-adopting the link) changes nothing');
  await h.c.advance(1);
  assert.equal(h.whips().length, 2);
  assert.equal(h.whips()[1].headers['X-Link-Takeover'], undefined);
  assert.equal(h.link.state, 'replaced');
  assert.equal(pc.closed, true); assert.equal(h.pcs[1].closed, true);
  assert.deepEqual(h.media.streams[0].getTracks().map(t => t.readyState), ['ended', 'ended']);
  assert.equal(h.api.of('DELETE', /whip/).length, 0);
  assert.equal(h.c.pending, 0);
});

// ---- recovery ------------------------------------------------------------------------------------------------

test('recovery after "failed" is make-before-break: a NEW connection and attempt id, the old one closes only after the swap', async () => {
  const h = rig();
  const old = await goLiveProven(h);
  old.set('failed'); await h.c.settle();
  assert.equal(h.link.state, 'recovering');
  assert.equal(h.link.snapshot().pill.text, 'החיבור נפל · מתחברת מחדש…');
  assert.equal(h.pcs.length, 2, 'a new RTCPeerConnection at once (delay 0)');
  const fresh = h.pcs[1];
  assert.deepEqual(h.whips().map(w => w.headers['X-Link-Attempt']), ['id-2', 'id-3']);
  assert.equal(h.whips()[1].headers['X-Link-Takeover'], undefined);
  assert.equal(fresh.transceivers[0].sender.track, h.camera(), 'the same camera track, no new prompt');
  assert.equal(h.media.calls.length, 1);
  assert.equal(old.closed, false, 'the old connection is kept until the new one is connected');
  assert.equal(old.restarts, 0); assert.deepEqual(fresh.offerOptions, [undefined], 'no ICE restart');

  fresh.set('connected'); await h.c.settle();
  assert.equal(h.link.state, 'live');
  assert.equal(old.closed, true); assert.equal(fresh.closed, false);
  assert.equal(h.api.of('DELETE', /whip/).length, 0, 'the hub already replaced the old attempt');
  assert.equal(h.link.snapshot().attempt, 'id-3');
  await h.c.advance(1000);
  assert.equal(h.api.of('GET', '/api/link/status').at(-1).query.attempt, 'id-3', 'the heartbeat follows the new attempt');
  assert.deepEqual(h.states, ['acquiring', 'offering', 'connecting', 'live', 'recovering', 'live']);
});

test('"disconnected" gets 4 s to heal by itself; after that a new attempt starts', async () => {
  const h = rig();
  const pc = await goLiveProven(h);
  pc.set('disconnected');
  await h.c.advance(2000);
  pc.set('connected');
  await h.c.advance(10000);
  assert.equal(h.pcs.length, 1, 'a short Wi-Fi hiccup costs nothing');
  assert.equal(h.link.state, 'live');

  pc.set('disconnected');
  await h.c.advance(3999);
  assert.equal(h.link.state, 'live'); assert.equal(h.pcs.length, 1);
  await h.c.advance(1);
  assert.equal(h.link.state, 'recovering'); assert.equal(h.link.snapshot().error, 'PC_DISCONNECTED');
  assert.equal(h.pcs.length, 2); assert.equal(pc.closed, false);
  h.pcs[1].set('connected'); await h.c.settle();
  assert.equal(h.link.state, 'live'); assert.equal(pc.closed, true);
});

test('recovery keeps trying with the delays, and a failed recovery attempt does not take the camera away', async () => {
  const h = rig();
  const old = await goLive(h);
  await h.c.advance(20000); // a link that proved itself
  h.api.whip.push({ http: 504, error: 'PROGRAM_TIMEOUT' }, new Error('reset'), 201);
  const from = h.c.now() - T0;
  old.set('failed'); await h.c.settle();
  await h.c.advance(3000);
  assert.deepEqual(h.whips().slice(1).map(w => w.at - from), [0, 1000, 3000], 'delays 0, 1, 2 s');
  assert.equal(h.link.state, 'recovering');
  assert.equal(h.camera().readyState, 'live');
  assert.equal(old.closed, false);
  h.pcs.at(-1).set('connected'); await h.c.settle();
  assert.equal(h.link.state, 'live');

  // a link that dies before the program ever confirmed it does not start over at 0 s: no connect/fail flapping
  const flap = rig();
  const first = await goLive(flap);
  first.set('failed'); await flap.c.settle();
  assert.equal(flap.link.state, 'recovering'); assert.equal(flap.pcs.length, 1, 'it waits its turn: 1 s');
  await flap.c.advance(1000); assert.equal(flap.pcs.length, 2);
  flap.pcs[1].set('connected'); await flap.c.settle();
  flap.pcs[1].set('failed'); await flap.c.settle();
  await flap.c.advance(1999); assert.equal(flap.pcs.length, 2);
  await flap.c.advance(1); assert.equal(flap.pcs.length, 3, '…then 2 s');
});

test('recovery triggers from the hub and from the sender: a stale program echo, and outbound bytes flat for 5 s', async () => {
  const stale = rig();
  await goLiveProven(stale);
  stale.api.status = linked({ link: { echoAgeMs: 5001 } });
  await stale.c.advance(1000);
  assert.equal(stale.link.state, 'recovering'); assert.equal(stale.link.snapshot().error, 'ECHO_STALE');
  assert.equal(stale.pcs.length, 2);

  // ...but not while the program's engine is still loading (program.ready false): that page is held up for seconds at a
  // time, cannot answer a new offer either, and has already made this connection
  const loading = rig();
  await goLiveProven(loading);
  loading.api.status = linked({ program: { online: true, ready: false, throttled: false }, link: { state: 'negotiating', echoAgeMs: 9000 } });
  await loading.c.advance(8000);
  assert.equal(loading.link.state, 'live'); assert.equal(loading.pcs.length, 1, 'the connection it has is left alone'); assert.equal(loading.whips().length, 1);
  assert.equal(loading.link.snapshot().pill.text, 'מתחברת לאולפן…', 'and the pill does not claim that she is seen');
  loading.api.status = linked({ link: { echoAgeMs: 9000 } }); // the engine is ready and the page is still silent: now it is a reason
  await loading.c.advance(1000);
  assert.equal(loading.link.snapshot().error, 'ECHO_STALE'); assert.equal(loading.pcs.length, 2);

  // the hub says the link is over (the program page was reloaded and no longer names this attempt): offer again at once
  const lost = rig();
  await goLiveProven(lost);
  lost.api.status = statusBody({ link: { state: 'lost', mine: false, lastError: 'STALE_ATTEMPT' } });
  await lost.c.advance(1000);
  assert.equal(lost.link.snapshot().error, 'LINK_LOST');
  assert.equal(lost.pcs.length, 2, 'no 3 s wait: nobody else holds the link');
  assert.equal(lost.whips()[1].headers['X-Link-Takeover'], undefined);
  lost.api.status = null; lost.pcs[1].set('connected'); await lost.c.settle();
  assert.equal(lost.link.state, 'live');
  // and again a moment later (the page was reloaded twice): the link was young, but the hub's own word is answered within a second
  lost.link.streak = 5; // as if earlier attempts had already grown the delays
  lost.api.status = statusBody({ link: { state: 'lost', mine: false, lastError: 'PROGRAM_OFFLINE' } });
  await lost.c.advance(1000); assert.equal(lost.link.snapshot().error, 'LINK_LOST'); assert.equal(lost.pcs.length, 2, 'not at once: this link lived only a moment');
  await lost.c.advance(1000); assert.equal(lost.pcs.length, 3, 'but after one second, not after the 8 or 15 the delays had grown to');

  // a restarted gateway knows nothing for a moment ("idle", not mine) and then adopts the running link: nothing to do
  const restarted = rig();
  await goLiveProven(restarted);
  restarted.api.status = statusBody();
  await restarted.c.advance(2000);
  restarted.api.status = null;
  await restarted.c.advance(10000);
  assert.equal(restarted.pcs.length, 1); assert.equal(restarted.link.state, 'live');

  const offline = rig();
  await goLive(offline);
  offline.api.status = linked({ program: { online: false }, link: { echoAgeMs: 60000 } });
  await offline.c.advance(10000);
  assert.equal(offline.pcs.length, 1, 'an old echo while the program is offline is not a reason to re-offer');

  const silent = rig(); // the hub never gets an echo for this link although the program is online
  await goLive(silent);
  silent.api.status = linked({ link: { echoAgeMs: null } });
  await silent.c.advance(6000); assert.equal(silent.pcs.length, 1);
  await silent.c.advance(1000); assert.equal(silent.link.snapshot().error, 'ECHO_STALE');

  const flat = rig();
  const pc = await goLive(flat);
  await flat.c.advance(3000);
  pc.frozen = true; // the far end is gone but ICE has not noticed yet
  await flat.c.advance(4000); assert.equal(flat.link.state, 'live');
  await flat.c.advance(1000);
  assert.equal(flat.link.state, 'recovering'); assert.equal(flat.link.snapshot().error, 'BYTES_FLAT');
  assert.equal(pc.closed, false);

  const hidden = rig(); // nothing is sent while the phone is in her pocket: that is an interruption, not a dead link
  const quietPc = await goLive(hidden);
  await hidden.c.advance(2000);
  hidden.doc.hide(); quietPc.frozen = true;
  await hidden.c.advance(20000);
  assert.equal(hidden.pcs.length, 1);
});

test('a connection that heals before any new offer left the phone cancels the recovery (the gateway is down, media is fine)', async () => {
  const h = rig();
  const pc = await goLiveProven(h);
  h.api.status = new Error('gateway down');
  pc.set('disconnected');
  await h.c.advance(4000);
  assert.equal(h.link.state, 'server_unreachable', 'the recovery attempt could not even ask for status');
  assert.equal(h.pcs.length, 1); assert.equal(h.whips().length, 1);
  pc.set('connected'); await h.c.settle();
  assert.equal(h.link.state, 'live');
  assert.equal(h.link.snapshot().pill.text, 'משדרת · אין קשר בקרה עם האולפן');
  await h.c.advance(60000);
  assert.equal(h.pcs.length, 1, 'no retry keeps running behind a healthy link');
  assert.equal(pc.closed, false);
});

test('recovery waits while the page is hidden and starts at once when she comes back', async () => {
  const h = rig();
  const pc = await goLiveProven(h);
  h.doc.hide();
  pc.set('failed'); await h.c.settle();
  await h.c.advance(60000);
  assert.equal(h.pcs.length, 1, 'no offer with a camera that is not delivering');
  h.doc.show(); await h.c.settle();
  assert.equal(h.pcs.length, 2);
  h.pcs[1].set('connected'); await h.c.settle();
  assert.equal(h.link.state, 'live');
});

// ---- interruptions -------------------------------------------------------------------------------------------

test('a track that ended is taken again for that kind only and swapped in with replaceTrack: no new connection, no new offer', async () => {
  const h = rig();
  const pc = await goLive(h);
  const oldCamera = h.camera(), oldMic = h.mic();
  oldCamera.end(); await h.c.settle();
  assert.deepEqual(h.media.calls[1], { video: videoConstraints() }, 'video only: the healthy microphone is not asked again');
  const camera = h.media.streams[1].getVideoTracks()[0];
  assert.deepEqual(pc.transceivers[0].sender.replaced, [camera]);
  assert.deepEqual(pc.transceivers[1].sender.replaced, []);
  assert.equal(oldCamera.stops, 1, 'the old track is stopped');
  assert.equal(oldCamera.count('ended') + oldCamera.count('mute') + oldCamera.count('unmute'), 0, 'and no longer listened to');
  assert.equal(h.previews.at(-1), camera, 'the self-view follows');
  assert.equal(h.pcs.length, 1); assert.deepEqual(pc.log.filter(x => x === 'createOffer'), ['createOffer'], 'no renegotiation');
  assert.equal(h.link.state, 'live');
  assert.deepEqual(h.statePosts().map(p => p.video), ['live', 'ended', 'live'], 'every change is reported');
  assert.equal(oldMic.readyState, 'live');

  oldMic.end(); await h.c.settle();
  assert.deepEqual(h.media.calls[2], { audio: audioConstraints(false) });
  assert.deepEqual(pc.transceivers[1].sender.replaced, [h.media.streams[2].getAudioTracks()[0]]);
});

test('a muted track gets 1 s to come back; muted longer -> re-acquired; a broken camera is not asked for in a tight loop', async () => {
  const h = rig();
  const pc = await goLive(h);
  h.camera().mute();
  assert.equal(h.link.state, 'interrupted');
  await h.c.advance(500);
  h.camera().unmute(); await h.c.advance(5000);
  assert.equal(h.media.calls.length, 1, 'it came back by itself');
  assert.equal(h.link.state, 'live');

  h.mic().mute();
  await h.c.advance(999); assert.equal(h.media.calls.length, 1);
  await h.c.advance(1);
  assert.deepEqual(h.media.calls[1], { audio: audioConstraints(false) });
  assert.equal(pc.transceivers[1].sender.replaced.length, 1);
  assert.equal(h.link.state, 'live');
  assert.deepEqual(h.statePosts().map(p => p.video + '/' + p.audio).filter((x, i, a) => x !== a[i - 1]), ['live/live', 'muted/live', 'live/live', 'live/muted', 'live/live']);

  // the camera is held by another app: every try fails -> 1, 2, 4, 8, 15, 15 s apart, and it works again when it is free
  const from = h.media.calls.length, start = h.c.now();
  const times = [];
  h.media.getUserMedia = async function (constraints) { this.calls.push(constraints); times.push(h.c.now() - start); if (this.fail) throw domError('NotReadableError'); const s = new FakeStream([new FakeTrack('video')]); this.streams.push(s); return s; };
  h.media.fail = true;
  h.media.streams[0].getVideoTracks()[0].end(); await h.c.settle();
  await h.c.advance(46000);
  assert.deepEqual(times, [0, 1000, 3000, 7000, 15000, 30000, 45000]);
  assert.equal(h.link.state, 'interrupted');
  assert.equal(h.pcs.length, 1, 'an interruption never tears the connection down');
  h.media.fail = false;
  h.media.emit('devicechange'); await h.c.settle();
  assert.equal(h.media.calls.length, from + 7, 'devicechange alone does not jump the delay');
  await h.c.advance(15000);
  assert.equal(h.link.state, 'live');
});

test('hidden page: reported as an interruption; on return the wake lock is asked again and a still-muted camera is re-acquired', async () => {
  const h = rig();
  const pc = await goLive(h);
  assert.equal(h.link.snapshot().wakeLock, 'held');
  h.doc.hide();
  h.wake.sentinels[0].release(); // the browser drops the lock of a hidden page
  h.camera().mute();
  await h.c.settle();
  assert.equal(h.link.state, 'interrupted');
  assert.deepEqual(h.statePosts().at(-1), { ...h.statePosts().at(-1), video: 'muted', audio: 'live', visible: false });
  await h.c.advance(30000);
  assert.equal(h.media.calls.length, 1, 'nothing is re-acquired in the background');
  assert.equal(h.pcs.length, 1); assert.equal(pc.closed, false);

  h.doc.show(); await h.c.settle();
  assert.deepEqual(h.wake.requests, ['screen', 'screen'], 'asked again on every return');
  assert.equal(h.statePosts().at(-1).visible, true);
  await h.c.advance(999); assert.equal(h.media.calls.length, 1, 'the browser gets a second to unmute the camera by itself');
  await h.c.advance(1);
  assert.deepEqual(h.media.calls[1], { video: videoConstraints() });
  assert.equal(h.link.state, 'live');

  h.win.emit('pageshow'); await h.c.settle();
  assert.equal(h.wake.requests.length, 2, 'a lock that is still held is not requested twice');
});

test('a rejected or missing wake lock is reported so the page can warn that the screen may turn off', async () => {
  const rejected = rig();
  rejected.wake.reject = true;
  await goLive(rejected);
  assert.equal(rejected.link.snapshot().wakeLock, 'rejected');
  assert.equal(TEXT.wakeHint, 'המסך עלול להיכבות. כבי מצב חיסכון בסוללה.');
  assert.equal(rejected.link.state, 'live', 'it is a warning, not a failure');

  const none = rig({ wakeLock: null });
  await goLive(none);
  assert.equal(none.link.snapshot().wakeLock, 'unsupported');
});

// ---- heartbeat and truth -------------------------------------------------------------------------------------

test('heartbeat: status every 1 s with the attempt id, state with sender stats every 2 s and at once on connect', async () => {
  const h = rig();
  await goLive(h);
  const statusBefore = h.api.of('GET', '/api/link/status').length;
  assert.equal(h.statePosts().length, 1, 'the capture state is reported as soon as the link is up');
  await h.c.advance(10000);
  const polls = h.api.of('GET', '/api/link/status').slice(statusBefore);
  assert.deepEqual(polls.map(p => p.at), [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
  assert.ok(polls.every(p => p.query.attempt === 'id-2' && p.headers['X-Link-Client'] === 'id-1'));
  const posts = h.api.of('POST', '/api/link/state');
  assert.deepEqual(posts.map(p => p.at), [0, 2000, 4000, 6000, 8000, 10000]);
  assert.equal(posts[1].headers['Content-Type'], 'application/json'); assert.equal(posts[1].headers['X-Link-Client'], 'id-1');
  assert.deepEqual(JSON.parse(posts.at(-1).body), {
    attempt: 'id-2', video: 'live', audio: 'live', visible: true,
    stats: { w: 720, h: 1280, fps: 30, kbps: 2550, rttMs: 4, codec: 'video/H264', encoder: 'ExternalEncoder c2.exynos.h264.encoder', limit: 'none' },
  });
  for (const p of posts) { assert.ok(p.body.length <= 2048); for (const v of Object.values(JSON.parse(p.body).stats)) if (typeof v === 'string') assert.match(v, /^[A-Za-z0-9 ._/-]{0,40}$/); }
  assert.deepEqual(h.link.snapshot().stats.path, { local: 'host', remote: 'prflx', protocol: 'udp' });
  assert.equal(h.link.snapshot().stats.lossPct, 1.5);
  assert.equal(h.pcs.length, 1); assert.equal(h.link.state, 'live');
});

test('a failed control call never stops media: network error, 401 and 500 on status and state leave camera and connection alone', async () => {
  const h = rig();
  const pc = await goLive(h);
  await h.c.advance(2000);
  assert.equal(h.link.snapshot().pill.text, 'מחוברת לאולפן · רואים אותך');

  for (const failure of [new Error('network down'), { http: 401, error: 'PAIRING_REQUIRED' }, { http: 500 }]) {
    h.api.status = failure; h.api.stateFail = new Error('network down');
    await h.c.advance(30000);
    assert.equal(h.link.state, 'live');
    assert.deepEqual([h.camera().readyState, h.mic().readyState], ['live', 'live']);
    assert.equal(h.camera().stops + h.mic().stops, 0);
    assert.equal(pc.closed, false); assert.equal(h.pcs.length, 1, 'no re-offer either');
    assert.deepEqual(h.link.snapshot().pill, { tone: 'warn', text: 'משדרת · אין קשר בקרה עם האולפן', sub: '', air: false });
    assert.equal(h.link.snapshot().control, 'lost');
    h.api.status = null; h.api.stateFail = null;
    await h.c.advance(1000);
    assert.equal(h.link.snapshot().pill.text, 'מחוברת לאולפן · רואים אותך', 'and the truth returns with the control link');
  }
  assert.ok(h.api.of('GET', '/api/link/status').length > 90, 'it keeps asking once a second');
});

test('the pill is driven by the program echo: green needs a fresh echo, enough frames and (when wanted) sound that plays', async () => {
  const live = (link, extra = {}) => derivePill({ state: 'live', status: normalizeStatus(linked({ link, ...extra })), control: 'ok', levelFresh: extra.levelFresh === true });
  const heard = { audio: { wanted: true, playing: true, level: 0.2 } };
  assert.deepEqual(live({}), { tone: 'ok', text: 'מחוברת לאולפן · רואים אותך', sub: 'הקול כבוי באולפן (מצב בדיקה)', air: false });
  assert.deepEqual(live(heard, { levelFresh: true }), { tone: 'ok', text: 'מחוברת לאולפן · רואים ושומעים אותך', sub: '', air: false });
  assert.deepEqual(live(heard), { tone: 'warn', text: 'רואים אותך · הקול לא מושמע באולפן', sub: '', air: false }, 'no level seen in the last 5 s');
  assert.equal(live({ audio: { wanted: true, playing: false, level: 0.2 } }, { levelFresh: true }).text, 'רואים אותך · הקול לא מושמע באולפן');
  for (const notSeen of [{ echoAgeMs: 3000 }, { echoAgeMs: null }, { stats: { w: 720, h: 1280, fps: 14, kbps: 900, rttMs: 4, lossPct: 0 } }, { mine: false }, { state: 'negotiating' }, { state: 'stalled' }, { state: 'lost' }]) {
    assert.deepEqual(live({ ...heard, ...notSeen }, { levelFresh: true }), { tone: 'busy', text: 'מתחברת לאולפן…', sub: '', air: false }, JSON.stringify(notSeen));
  }
  assert.equal(live(heard, { levelFresh: true, program: { throttled: true } }).text, 'מסך השידור באולפן מוסתר או ממוזער');
  assert.deepEqual(live(heard, { levelFresh: true, air: { known: true, live: true } }), { tone: 'ok', text: 'מחוברת לאולפן · רואים ושומעים אותך', sub: '', air: true });
  assert.equal(TEXT.onAir, '🔴 באוויר בטיקטוק');
  assert.equal(derivePill({ state: 'live', status: normalizeStatus(linked({ air: { live: true } })), airFresh: false }).air, false, 'never a stale "on air"');
  assert.equal(derivePill({ state: 'live', status: normalizeStatus(linked()), control: 'lost' }).text, 'משדרת · אין קשר בקרה עם האולפן');
  assert.equal(derivePill({ state: 'recovering' }).text, 'החיבור נפל · מתחברת מחדש…');
  assert.equal(derivePill({ state: 'interrupted' }).text, 'החיבור נפל · מתחברת מחדש…');
  for (const quiet of ['idle', 'acquiring', 'stopped', 'denied', 'busy_camera', 'replaced', 'unpaired']) assert.equal(derivePill({ state: quiet }).text, '', quiet);

  // through the client: the level must have been seen within 5 s, connectionState alone proves nothing
  const h = rig();
  await goLive(h);
  h.api.status = linked({ link: heard, air: { known: true, live: true } });
  await h.c.advance(1000);
  assert.deepEqual(h.link.snapshot().pill, { tone: 'ok', text: 'מחוברת לאולפן · רואים ושומעים אותך', sub: '', air: true });
  h.api.status = linked({ link: { audio: { wanted: true, playing: true, level: 0 } } });
  await h.c.advance(5000);
  assert.equal(h.link.snapshot().pill.text, 'מחוברת לאולפן · רואים ושומעים אותך', 'she was quiet for 5 s');
  await h.c.advance(1000);
  assert.equal(h.link.snapshot().pill.text, 'רואים אותך · הקול לא מושמע באולפן');
  h.api.status = linked({ link: { echoAgeMs: 4000, stats: { w: 720, h: 1280, fps: 0, kbps: 0, rttMs: 4, lossPct: 0 } } });
  await h.c.advance(1000);
  assert.equal(h.pcs[0].connectionState, 'connected');
  assert.equal(h.link.snapshot().pill.text, 'מתחברת לאולפן…', 'connected is not "they see you"');
});

test('status is reduced to booleans, clamped numbers and known words: nothing free-form from the program reaches the page', () => {
  const s = normalizeStatus({
    version: '<b>1.3.0</b>', serverTime: 'now', iceServers: [{ urls: 'stun:stun.example.org:3478' }, { urls: 'javascript:alert(1)' }, { urls: ['turn:turn.example.org:3478?transport=udp', 'http://evil.example/'], username: 'u', credential: 'c' }, 7],
    program: { online: 'yes', ready: true, throttled: 1 },
    link: { state: '<img>', mine: 'true', since: -5, echoAgeMs: '250', stats: { w: 1e12, h: 'x', fps: 30.4, kbps: -1, rttMs: 4.6, lossPct: 250, note: '<script>' }, audio: { wanted: true, playing: 'no', level: 9, sink: '<b>' }, path: { local: 'host', remote: '10.0.0.7', protocol: 'udp' }, lastError: 'not a code', sdp: 'v=0', attempt: 'someone-else' },
    air: { known: true, live: 'true' }, secret: 'x',
  });
  assert.deepEqual(s, {
    version: 'b 1.3.0 /b', serverTime: 0,
    iceServers: [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478?transport=udp'], username: 'u', credential: 'c' }],
    program: { online: false, ready: true, throttled: false },
    link: { state: 'idle', mine: false, since: 0, echoAgeMs: 250, stats: { w: 100000, h: 0, fps: 30.4, kbps: 0, rttMs: 5, lossPct: 100 }, audio: { wanted: true, playing: false, level: 1 }, path: null, lastError: null },
    air: { known: true, live: false },
  });
  assert.deepEqual(normalizeStatus(null).link.stats, { w: 0, h: 0, fps: 0, kbps: 0, rttMs: 0, lossPct: 0 });
  assert.equal(normalizeStatus(linked({ link: { lastError: 'STREAM_REJECTED' } })).link.lastError, 'STREAM_REJECTED');
  assert.deepEqual(readStats(null), { outbound: 0, bytes: 0, w: 0, h: 0, fps: 0, limit: '', encoder: '', codec: '', rttMs: 0, lossPct: 0, path: null });
});

// ---- stop ----------------------------------------------------------------------------------------------------

test('stop releases every track at once, closes the connection, deletes the attempt and leaves no timer behind', async () => {
  const h = rig();
  const pc = await goLive(h);
  await h.c.advance(3000);
  const before = h.api.calls.length;
  const stopping = h.link.stop();
  // synchronously, before the DELETE is even answered: the indicators go off within a second
  assert.deepEqual([h.camera().readyState, h.mic().readyState], ['ended', 'ended']);
  assert.deepEqual([h.camera().stops, h.mic().stops], [1, 1]);
  assert.equal(pc.closed, true);
  assert.equal(h.link.state, 'stopped'); assert.equal(h.link.snapshot().tracksLive, false);
  assert.equal(h.previews.at(-1), null);
  await stopping; await h.c.settle();
  const sent = h.api.calls.slice(before);
  assert.deepEqual(sent.map(x => x.method + ' ' + x.path), ['DELETE /api/link/whip/id-2']);
  assert.equal(sent[0].headers['X-Link-Client'], 'id-1'); assert.equal(sent[0].body, undefined);
  assert.equal(h.wake.sentinels[0].released, true);
  assert.equal(h.c.pending, 0);
  await h.c.advance(60000);
  assert.equal(h.api.calls.length, before + 1, 'no heartbeat after stop');
  assert.equal(TEXT.stopAsk, 'לעצור את המצלמה? השידור בטיקטוק ממשיך עד שסוגרים אותו באולפן.');
  assert.deepEqual([TEXT.stopYes, TEXT.stopNo], ['עצרי מצלמה', 'המשיכי']);

  await goLive(h); // and she can connect again
  assert.equal(h.media.calls.length, 2);
  assert.equal(h.whips().at(-1).headers['X-Link-Client'], 'id-1', 'the client id is per page load');
});

test('stop while the offer is parked or while the permission prompt is open leaves nothing running', async () => {
  const parked = rig();
  let answer;
  parked.api.whip.push(() => new Promise(resolve => { answer = resolve; }));
  await parked.link.start(); await parked.c.settle();
  assert.equal(parked.link.state, 'offering');
  await parked.link.stop(); await parked.c.settle();
  assert.deepEqual(parked.api.of('DELETE', /whip/).map(x => x.path), ['/api/link/whip/id-2'], 'the parked attempt is deleted by its id');
  assert.equal(parked.pcs[0].closed, true); assert.equal(parked.camera().readyState, 'ended');
  answer(201); await parked.c.settle(); // the late answer changes nothing
  assert.equal(parked.link.state, 'stopped'); assert.equal(parked.pcs[0].remoteDescription, null);
  assert.equal(parked.c.pending, 0);

  const prompt = rig();
  let grant;
  prompt.media.script.push(() => new Promise(resolve => { grant = resolve; }));
  const tap = prompt.link.start();
  await prompt.c.settle();
  assert.equal(prompt.link.state, 'acquiring');
  await prompt.link.stop();
  grant(); await tap; await prompt.c.settle();
  assert.equal(prompt.link.state, 'stopped');
  assert.deepEqual(prompt.media.streams[0].getTracks().map(t => t.readyState), ['ended', 'ended'], 'tracks that arrive after stop are released');
  assert.equal(prompt.pcs.length, 0); assert.equal(prompt.api.calls.length, 0);
});

test('pagehide says bye with keepalive; the microphone mute is track.enabled=false and is reported', async () => {
  const h = rig();
  await goLive(h);
  h.win.emit('pagehide');
  const bye = h.api.calls.at(-1);
  assert.equal(bye.method + ' ' + bye.path, 'POST /api/link/whip/id-2/bye');
  assert.equal(bye.keepalive, true); assert.equal(bye.headers['X-Link-Client'], 'id-1');
  assert.equal(h.camera().readyState, 'live');
  await h.c.settle();

  assert.equal(h.link.toggleMic(), true); await h.c.settle();
  assert.equal(h.mic().enabled, false); assert.equal(h.mic().stops, 0);
  assert.equal(h.link.snapshot().micMuted, true); assert.equal(TEXT.micMuted, 'המיקרופון מושתק');
  assert.equal(h.statePosts().at(-1).audio, 'muted');
  assert.equal(h.link.state, 'live', 'her own mute is not an interruption');
  await h.c.advance(5000);
  assert.equal(h.media.calls.length, 1, 'and nothing is re-acquired');
  h.mic().end(); await h.c.settle(); // a replaced microphone stays muted
  assert.equal(h.media.streams[1].getAudioTracks()[0].enabled, false);
  assert.equal(h.link.toggleMic(), false);
  assert.equal(h.media.streams[1].getAudioTracks()[0].enabled, true);

  const idle = rig();
  idle.win.emit('pagehide');
  assert.equal(idle.api.calls.length, 0, 'nothing to say bye to');
});

// ---- pure helpers --------------------------------------------------------------------------------------------

test('the answer munge adds the start bitrate to the negotiated video payload type only', () => {
  const h264 = mungeAnswer(ANSWER_H264);
  assert.ok(h264.includes(H264_FMTP + ';x-google-start-bitrate=2000' + CRLF));
  assert.ok(h264.includes('a=fmtp:103 apt=102' + CRLF), 'the repair stream is untouched');
  assert.ok(h264.includes('a=fmtp:111 minptime=10;useinbandfec=1' + CRLF), 'audio is untouched');
  assert.equal((h264.match(/x-google-start-bitrate/g) || []).length, 1);
  assert.equal(h264.split(CRLF).length, ANSWER_H264.split(CRLF).length, 'no line added when an fmtp line exists');
  assert.equal(mungeAnswer(h264), h264, 'applying it twice changes nothing');

  const vp8 = mungeAnswer(ANSWER_VP8).split(CRLF);
  assert.deepEqual(vp8.slice(vp8.indexOf('a=rtpmap:96 VP8/90000'), vp8.indexOf('a=rtpmap:96 VP8/90000') + 3), ['a=rtpmap:96 VP8/90000', 'a=fmtp:96 x-google-start-bitrate=2000', 'a=rtcp-fb:96 nack pli'], 'VP8 has no fmtp line: one is added right after its rtpmap');
  assert.equal(vp8.length, ANSWER_VP8.split(CRLF).length + 1);
  assert.ok(mungeAnswer(ANSWER_VP8).endsWith(CRLF) && !mungeAnswer(ANSWER_VP8).includes('\n\n'), 'line endings are kept');

  const rtxFirst = sdp([...SESSION, 'm=video 9 UDP/TLS/RTP/SAVPF 97 96', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96', 'a=rtpmap:96 VP8/90000']);
  assert.ok(mungeAnswer(rtxFirst).includes('a=fmtp:96 x-google-start-bitrate=2000'), 'a repair format is never taken for the codec');
  assert.ok(mungeAnswer(rtxFirst).includes('a=fmtp:97 apt=96' + CRLF));
  const audioFirst = sdp([...SESSION, ...AUDIO, 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000']);
  assert.ok(mungeAnswer(audioFirst).includes('a=fmtp:111 minptime=10;useinbandfec=1' + CRLF + 'm=video'));
  assert.ok(mungeAnswer(audioFirst).endsWith('a=rtpmap:96 VP8/90000' + CRLF + 'a=fmtp:96 x-google-start-bitrate=2000' + CRLF));
  const lf = mungeAnswer(ANSWER_VP8.replaceAll(CRLF, '\n'));
  assert.ok(!lf.includes('\r') && lf.includes('a=fmtp:96 x-google-start-bitrate=2000\n'));
  assert.equal(mungeAnswer(ANSWER_H264, 1500).includes('x-google-start-bitrate=1500'), true);

  const audioOnly = sdp([...SESSION, ...AUDIO]);
  assert.equal(mungeAnswer(audioOnly), audioOnly);
  const rejected = sdp([...SESSION, 'm=video 0 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000']);
  assert.equal(mungeAnswer(rejected), rejected, 'a rejected video section is left alone');
  for (const odd of ['', null, undefined, 42]) assert.equal(mungeAnswer(odd), odd);
});

test('codec preference: the wanted codec first, the list sorted and never filtered', () => {
  const sorted = sortCodecs(CAPS);
  assert.deepEqual(sorted.map(c => c.mimeType), ['video/H264', 'video/H264', 'video/H264', 'video/VP8', 'video/rtx', 'video/VP9', 'video/red', 'video/ulpfec']);
  assert.match(sorted[0].sdpFmtpLine, /packetization-mode=1;profile-level-id=42e01f/, 'constrained baseline, packetization-mode 1 first');
  assert.deepEqual(sorted.slice(1, 3).map(c => c.sdpFmtpLine), [CAPS[3].sdpFmtpLine, CAPS[4].sdpFmtpLine], 'the other H.264 flavours keep their order');
  assert.deepEqual(new Set(sorted), new Set(CAPS)); assert.equal(sorted.length, CAPS.length);
  assert.deepEqual(sortCodecs(CAPS, 'h264'), sorted);
  assert.deepEqual(sortCodecs(CAPS, 'vp8').map(c => c.mimeType), CAPS.map(c => c.mimeType), 'VP8 is already first on this phone');
  assert.deepEqual(sortCodecs([...CAPS].reverse(), 'vp8')[0], CAPS[0]);
  assert.equal(sortCodecs(CAPS.filter(c => c.mimeType !== 'video/H264')), null, 'not listed -> no preference at all');
  assert.equal(sortCodecs(undefined), null); assert.equal(sortCodecs([]), null);
  assert.notEqual(sorted, CAPS, 'the capability list itself is not reordered');
  assert.equal(CAPS[0].mimeType, 'video/VP8');
});

test('the offer never carries more than the 40 candidates the hub accepts, and the documented timings are the spec\'s', () => {
  const line = (i, proto) => `a=candidate:${i} 1 ${proto} 2122260223 192.0.2.${i} 9 typ host`;
  const offer = extra => sdp([...SESSION, 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', ...extra, 'a=end-of-candidates', ...AUDIO]);
  const count = (text, re = /^a=candidate:/gm) => (text.match(re) || []).length;
  const udp = n => Array.from({ length: n }, (_, i) => line(i + 1, 'udp'));
  assert.equal(limitCandidates(offer(udp(40))), offer(udp(40)), 'at the limit: untouched');
  const mixed = limitCandidates(offer([...udp(35), ...Array.from({ length: 12 }, (_, i) => line(100 + i, 'TCP'))]));
  assert.equal(count(mixed), 40); assert.equal(count(mixed, /^a=candidate:.* udp /gm), 35, 'TCP candidates go first');
  const many = limitCandidates(offer(udp(47)));
  assert.equal(count(many), 40); assert.ok(many.includes(line(40, 'udp')) && !many.includes(line(41, 'udp')), 'then the tail');
  assert.ok(many.endsWith(CRLF) && many.includes('a=end-of-candidates' + CRLF + 'm=audio'), 'the rest of the offer is intact');
  assert.equal(limitCandidates(undefined), undefined);
  assert.deepEqual([...TIMING.retryDelaysMs], [0, 1000, 2000, 4000, 8000, 15000, 30000]);
  assert.deepEqual([TIMING.gatherQuietMs, TIMING.gatherMaxMs, TIMING.connectDeadlineMs, TIMING.offlinePollMs, TIMING.statusMs, TIMING.statusMs * TIMING.stateEveryTicks, TIMING.disconnectGraceMs, TIMING.echoStaleMs, TIMING.flatMs, TIMING.muteGraceMs, TIMING.echoFreshMs, TIMING.levelSeenMs],
    [300, 2000, 10000, 3000, 1000, 2000, 4000, 5000, 5000, 1000, 3000, 5000]);
});

// ---- embed-ready seams ---------------------------------------------------------------------------------------

test('embed-ready seams: one headers function (returns {} today) feeds every request, and a framing page hears each state', async () => {
  assert.deepEqual(linkHeaders(), {});
  const messages = [];
  const h = rig({ headers: () => ({ Authorization: 'Bearer ticket-for-a-test' }), parent: { postMessage: (data, origin) => messages.push([data, origin]) } });
  await goLive(h);
  await h.c.advance(2000);
  h.win.emit('pagehide');
  await h.link.stop();
  assert.ok(h.api.calls.length >= 7);
  assert.deepEqual([...new Set(h.api.calls.map(x => x.method + ' ' + x.path.replace(/id-\d+/, ':id')))].sort(), ['DELETE /api/link/whip/:id', 'GET /api/link/status', 'POST /api/link/state', 'POST /api/link/whip', 'POST /api/link/whip/:id/bye']);
  for (const call of h.api.calls) assert.equal(call.headers.Authorization, 'Bearer ticket-for-a-test', call.method + ' ' + call.path);
  assert.deepEqual(messages.map(m => m[0]), ['acquiring', 'offering', 'connecting', 'live', 'stopped'].map(state => ({ type: 'cam-link', state })));

  const plain = rig();
  await goLive(plain);
  assert.ok(plain.api.calls.every(call => call.headers.Authorization === undefined && call.headers.Cookie === undefined), 'today: no credentials are built by the page');
});

// ---- the files -----------------------------------------------------------------------------------------------

const file = name => fs.readFileSync(new URL('../public/cam/' + name, import.meta.url), 'utf8');

test('the module is importable without a DOM and the pages obey the strict CSP: no inline script, no handlers, text only', () => {
  assert.equal(typeof globalThis.document, 'undefined', 'this test file itself ran the import with no DOM');
  const js = file('cam-link.js'), ops = file('ops.js');
  for (const source of [js, ops]) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    assert.doesNotMatch(source, /^import\s/m, 'no imports: nothing node or the CSP could fail to resolve');
  }
  assert.match(js, /searchParams\.get\('ui'\) === '1'\) mountCamPage\(\);\s*$/, 'the page UI starts only when the script URL asks for it');
  for (const name of ['index.html', 'ops.html']) {
    const html = file(name);
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
    assert.equal(scripts.length, 1, name);
    assert.match(scripts[0], /^<script type="module" src="\/cam\/(cam-link\.js\?ui=1|ops\.js)"><\/script>$/, 'an external module from /cam/ only');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
    assert.doesNotMatch(html, /javascript:|style\s*=|<style|<base\b|<iframe|manifest|serviceWorker|sw\.js/i);
    assert.doesNotMatch(html, /https?:\/\//, 'nothing is loaded from another origin');
    assert.match(html, /<link rel="stylesheet" href="\/cam\/cam\.css">/);
  }
  const html = file('index.html'), css = file('cam.css');
  assert.match(html, /^<!doctype html>\s*<html lang="he" dir="rtl">/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">/);
  assert.match(html, /<video id="self" class="self" muted playsinline autoplay/);
  assert.doesNotMatch(html, /WANNA|brand|<header/i, 'no brand header');
  assert.match(css, /\.self\s*{[^}]*transform:\s*scaleX\(-1\)/, 'the self-view is mirrored by CSS only');
  for (const side of ['top', 'right', 'bottom', 'left']) assert.ok(css.includes('env(safe-area-inset-' + side + ')'), side);
  assert.doesNotMatch(css, /@import|url\(/);
  assert.doesNotMatch(js, /scale\(-1|scaleX/, 'the stream itself is never mirrored');
});

test('the copy is exactly the spec (Hebrew, addressed to a woman) and the page carries it', () => {
  assert.deepEqual({ ...TEXT, checklist: [...TEXT.checklist] }, {
    title: 'עלי לשידור',
    start: 'חברי מצלמה ומיקרופון',
    before: 'הטלפון יבקש אישור למצלמה ולמיקרופון',
    checklist: ['Wi‑Fi', 'מטען בכבל', 'נא לא להפריע', 'טלפון לאורך'],
    connecting: 'מתחברת לאולפן…',
    reconnecting: 'החיבור נפל · מתחברת מחדש…',
    seenHeard: 'מחוברת לאולפן · רואים ושומעים אותך',
    seen: 'מחוברת לאולפן · רואים אותך',
    audioOffTest: 'הקול כבוי באולפן (מצב בדיקה)',
    seenNotHeard: 'רואים אותך · הקול לא מושמע באולפן',
    onAir: '🔴 באוויר בטיקטוק',
    throttled: 'מסך השידור באולפן מוסתר או ממוזער',
    controlLost: 'משדרת · אין קשר בקרה עם האולפן',
    programOffline: 'האולפן דלוק, מסך השידור עוד נפתח. מנסה שוב לבד…',
    noPath: 'אין נתיב ישיר לאולפן · בדקי שהטלפון על אותה רשת Wi‑Fi',
    serverUnreachable: 'האולפן שלך לא זמין כרגע. זה לא בטלפון שלך.',
    denied: 'אין אישור למצלמה או למיקרופון. פתחי את הגדרות האתר בדפדפן, אשרי את שניהם ולחצי נסי שוב',
    busyCamera: 'אפליקציה אחרת משתמשת במצלמה. סגרי אותה ונסי שוב',
    replaced: 'המצלמה עברה למכשיר אחר',
    takeover: 'החזירי לכאן',
    unpaired: 'הטלפון לא משויך לאולפן',
    sending: '🔴 המצלמה והמיקרופון משודרים לאולפן',
    micMuted: 'המיקרופון מושתק',
    wakeHint: 'המסך עלול להיכבות. כבי מצב חיסכון בסוללה.',
    landscape: 'סובבי את הטלפון לאורך',
    stopAsk: 'לעצור את המצלמה? השידור בטיקטוק ממשיך עד שסוגרים אותו באולפן.',
    stopYes: 'עצרי מצלמה',
    stopNo: 'המשיכי',
    retry: 'נסי שוב',
  });
  assert.ok(TEXT.checklist[0].includes('\u2011') && TEXT.noPath.includes('Wi\u2011Fi'), 'Wi‑Fi is written with a non-breaking hyphen, as in the spec');
  const html = file('index.html');
  const inside = id => { const m = html.match(new RegExp('id="' + id + '"[^>]*>([^<]*)<')); assert.ok(m, id); return m[1]; };
  assert.equal(html.match(/<title>([^<]*)<\/title>/)[1], TEXT.title);
  assert.match(html, new RegExp('<h1>' + TEXT.title + '</h1>'));
  assert.equal(inside('start'), TEXT.start);
  assert.ok(html.includes('<p class="lead">' + TEXT.before + '</p>'));
  assert.deepEqual([...html.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map(m => m[1]), [...TEXT.checklist]);
  assert.equal(inside('air'), TEXT.onAir);
  assert.equal(inside('retry'), TEXT.retry); assert.equal(inside('takeover'), TEXT.takeover);
  assert.equal(inside('mic-muted'), TEXT.micMuted); assert.equal(inside('wake-hint'), TEXT.wakeHint); assert.equal(inside('sending'), TEXT.sending);
  assert.equal(inside('stop'), TEXT.stopYes);
  assert.equal(inside('confirm-text'), TEXT.stopAsk); assert.equal(inside('confirm-stop'), TEXT.stopYes); assert.equal(inside('confirm-keep'), TEXT.stopNo);
  assert.equal(inside('landscape'), TEXT.landscape);
  assert.match(html, /<a id="pair-link" class="button" href="\/mobile\/" target="_blank" rel="noopener" hidden>/, 'the unpaired notice links to the pairing page, beside this page (it stays open and checks again on return)');
  // strings the spec does not list: pairing from this page, and the screen reader's name of the mute button
  assert.deepEqual({ ...EXTRA_TEXT }, {
    pairLabel: 'קוד השיוך מהאולפן (8 ספרות)',
    pairGo: 'שייכי את הטלפון',
    pairBad: 'הקוד שגוי או שפג תוקפו. בקשי קוד חדש מהאולפן.',
    pairWait: 'יותר מדי ניסיונות. חכי דקה ונסי שוב.',
    pairFailed: 'השיוך לא הצליח. נסי שוב.',
    pairLink: 'לשיוך הטלפון',
    micLabel: 'השתקת מיקרופון',
  });
  assert.ok(html.includes('<label for="pair-code" class="pair-label">' + EXTRA_TEXT.pairLabel + '</label>'));
  assert.equal(inside('pair-go'), EXTRA_TEXT.pairGo); assert.equal(inside('pair-link'), EXTRA_TEXT.pairLink);
  assert.match(html, /<input id="pair-code"[^>]*inputmode="numeric"[^>]*maxlength="8"/); assert.doesNotMatch(html, /<form/, 'no form: the page policy is form-action none');
  assert.ok(html.includes('aria-pressed="false" aria-label="' + EXTRA_TEXT.micLabel + '"'), 'pressed = muted, so the button is named for what pressing does');
  for (const id of ['mic-muted', 'wake-hint', 'air']) assert.match(html, new RegExp('id="' + id + '"[^>]*role="status"'), id + ' is announced when it appears');
  assert.match(html, /id="confirm" class="sheet" role="dialog" aria-modal="true"/);
  assert.doesNotMatch(Object.values(EXTRA_TEXT).join(' '), /(^|[^א-ת])(הפעל|בדוק|עצור|פתח|סגור|נסה|לחץ|חבר|סובב|שייך|בקש|חכה|הקלד)([^א-ת]|$)/, 'no masculine imperatives');
  assert.doesNotMatch(Object.values(TEXT).flat().join(' ') + ' ' + html, /(^|[^א-ת])(הפעל|בדוק|עצור|פתח|סגור|נסה|לחץ|חבר|סובב)([^א-ת]|$)/, 'no masculine imperatives');
});

// ---- the page itself, on a fake DOM built from the ids in index.html ------------------------------------------

class FakeElement extends Emitter {
  static focused = null;
  constructor(id, hidden) { super(); this.id = id; this.hidden = hidden; this.textContent = ''; this.dataset = {}; this.attributes = {}; this.disabled = false; this.srcObject = null; this.value = ''; }
  focus() { FakeElement.focused = this.id; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  click() { this.emit('click', {}); }
  play() { return Promise.resolve(); }
}
function page({ search = '', orientation = 'portrait-primary', coarse = true } = {}) {
  const h = rig();
  const elements = new Map();
  for (const m of file('index.html').matchAll(/<[a-z0-9]+\b([^>]*?)\bid="([^"]+)"([^>]*)>/g)) elements.set(m[2], new FakeElement(m[2], /\shidden(\s|$)/.test(m[1] + ' ' + m[3] + ' ')));
  const win = h.win;
  win.matchMedia = query => ({ matches: query === '(pointer: coarse)' ? g.coarse : false });
  win.parent = win;
  const g = {
    coarse, document: Object.assign(h.doc, { getElementById: id => elements.get(id) || null }), window: win, location: { search },
    screen: { orientation: Object.assign(new Emitter(), { type: orientation }) }, MediaStream: FakeStream,
    fetch: h.api.fetchImpl, RTCPeerConnection: FakePC, RTCRtpSender: { getCapabilities: () => ({ codecs: CAPS }) }, navigator: { mediaDevices: h.media, wakeLock: h.wake, maxTouchPoints: 5 },
  };
  let n = 0;
  const link = mountCamPage(g, { now: h.c.now, timers: h.c.timers, randomId: () => 'id-' + ++n });
  const $ = id => { const el = elements.get(id); assert.ok(el, 'index.html has #' + id); return el; };
  const inside = { start: 'start-card', retry: 'notice', takeover: 'notice', 'pair-link': 'notice', 'pair-box': 'notice', 'pair-code': 'pair-box', 'pair-go': 'pair-box', 'pair-error': 'pair-box', mic: 'controls', stop: 'controls', 'confirm-stop': 'confirm', 'confirm-keep': 'confirm' };
  const visible = () => [...elements.values()].filter(el => !el.hidden && !elements.get(inside[el.id])?.hidden).map(el => el.id).filter(id => !/^(cam|self|pill-text|notice-text|confirm-text|d-)/.test(id)).sort();
  return { ...h, link, g, $, visible };
}

test('the page: one primary button, then self-view, pill, the fixed "being sent" label, mute and a confirmed stop', async () => {
  const p = page();
  assert.equal(p.g.window.camLink, p.link, 'window.camLink is exposed for the end-to-end test');
  assert.ok(p.link instanceof CamLink);
  await p.c.settle();
  assert.equal(p.api.calls.length, 1, 'one status check before any tap');
  assert.deepEqual(p.visible(), ['start', 'start-card'], 'before the tap: only the card with the primary button');
  assert.equal(p.$('cam').dataset.state, 'idle');

  p.$('start').click(); await p.c.settle();
  assert.equal(p.$('cam').dataset.state, 'connecting');
  assert.deepEqual(p.visible(), ['controls', 'mic', 'pill', 'sending', 'stop']);
  assert.equal(p.$('pill-text').textContent, TEXT.connecting); assert.equal(p.$('pill').dataset.tone, 'busy');
  assert.ok(p.$('self').srcObject instanceof FakeStream, 'the self-view shows the camera');
  assert.deepEqual(p.$('self').srcObject.getTracks(), [p.camera()], 'video only: her own voice is never played back');

  p.api.linked = true; p.pcs[0].set('connected'); await p.c.settle();
  await p.c.advance(1000);
  assert.equal(p.$('cam').dataset.state, 'live');
  assert.equal(p.$('pill-text').textContent, TEXT.seen); assert.equal(p.$('pill').dataset.tone, 'ok');
  assert.equal(p.$('pill-sub').textContent, TEXT.audioOffTest);
  assert.deepEqual(p.visible(), ['controls', 'mic', 'pill', 'pill-sub', 'sending', 'stop']);
  p.api.status = linked({ link: { audio: { wanted: true, playing: true, level: 0.3 } }, air: { known: true, live: true } });
  await p.c.advance(1000);
  assert.equal(p.$('pill-text').textContent, TEXT.seenHeard);
  assert.deepEqual(p.visible(), ['air', 'controls', 'mic', 'pill', 'sending', 'stop']);

  p.$('mic').click();
  assert.equal(p.mic().enabled, false); assert.equal(p.$('mic').attributes['aria-pressed'], 'true');
  assert.equal(p.$('mic-muted').hidden, false);
  p.$('mic').click();
  assert.equal(p.mic().enabled, true); assert.equal(p.$('mic-muted').hidden, true); assert.equal(p.$('mic').attributes['aria-pressed'], 'false');

  p.$('stop').click();
  assert.equal(p.$('confirm').hidden, false, 'stop asks first');
  assert.equal(FakeElement.focused, 'confirm-keep', 'the dialog takes the focus (on the safe answer)');
  assert.equal(p.camera().readyState, 'live');
  p.$('confirm-keep').click();
  assert.equal(p.$('confirm').hidden, true); assert.equal(p.link.state, 'live'); assert.equal(FakeElement.focused, 'stop', 'and gives it back');
  p.$('stop').click(); p.doc.emit('keydown', { key: 'a' }); assert.equal(p.$('confirm').hidden, false);
  p.doc.emit('keydown', { key: 'Escape' }); assert.equal(p.$('confirm').hidden, true, 'Escape closes it'); assert.equal(p.link.state, 'live');
  // the microphone she muted herself: the pill says so instead of blaming the studio
  p.$('mic').click(); assert.equal(p.$('pill-text').textContent, TEXT.seen); assert.equal(p.$('pill-sub').textContent, TEXT.micMuted); p.$('mic').click();
  // both tracks ended and not back yet: the controls belong to the session, so she can still stop
  p.media.script.push(domError('NotReadableError'));
  p.camera().stop(); p.mic().stop(); p.camera().emit('ended'); await p.c.settle();
  assert.equal(p.$('cam').dataset.state, 'interrupted');
  assert.deepEqual(p.visible(), ['air', 'controls', 'mic', 'pill', 'stop'], 'no "being sent" label without a live track, but stop is there');
  await p.c.advance(1000); assert.equal(p.$('cam').dataset.state, 'live', 'the tracks came back'); await p.c.advance(1000);
  p.$('stop').click(); p.$('confirm-stop').click();
  assert.equal(p.camera().readyState, 'ended'); assert.equal(p.mic().readyState, 'ended');
  await p.c.settle();
  assert.equal(p.$('cam').dataset.state, 'stopped');
  assert.equal(p.$('self').srcObject, null);
  assert.deepEqual(p.visible(), ['start', 'start-card'], 'the label is gone the moment no track is live');
  assert.equal(p.api.of('DELETE', /whip/).length, 1);
});

test('the page: notices with their one action, the wake-lock hint, the landscape hint and the hidden diagnostics', async () => {
  const p = page();
  await p.c.settle();
  p.api.whip.push({ http: 409, error: 'LINK_REPLACED' });
  p.$('start').click(); await p.c.settle();
  assert.equal(p.$('notice-text').textContent, TEXT.replaced);
  assert.deepEqual(p.visible(), ['notice', 'takeover']);
  p.$('takeover').click(); await p.c.settle();
  assert.equal(p.whips().at(-1).headers['X-Link-Takeover'], '1');
  assert.equal(p.$('notice').hidden, true);
  await p.link.stop();

  p.media.script.push(domError('NotAllowedError'));
  p.$('start').click(); await p.c.settle();
  assert.equal(p.$('notice-text').textContent, TEXT.denied);
  assert.deepEqual(p.visible(), ['notice', 'retry']);
  p.media.script.push(domError('NotReadableError'));
  p.$('retry').click(); await p.c.settle();
  assert.equal(p.$('notice-text').textContent, TEXT.busyCamera);
  assert.deepEqual(p.visible(), ['notice', 'retry']);

  p.wake.reject = true;
  p.$('retry').click(); await p.c.settle();
  p.api.linked = true; p.pcs.at(-1).set('connected'); await p.c.settle();
  assert.equal(p.$('wake-hint').hidden, false, 'the screen may turn off: she is told');
  assert.equal(p.$('diag').hidden, true);
  for (let i = 0; i < 4; i++) p.$('pill').click();
  assert.equal(p.$('diag').hidden, true);
  p.$('pill').click();
  assert.equal(p.$('diag').hidden, false, 'five taps on the pill');
  await p.c.advance(2000);
  assert.equal(p.$('d-codec').textContent, 'video/H264');
  assert.equal(p.$('d-encoder').textContent, 'ExternalEncoder c2.exynos.h264.encoder');
  assert.equal(p.$('d-size').textContent, '720×1280'); assert.equal(p.$('d-fps').textContent, '30'); assert.equal(p.$('d-kbps').textContent, '2550');
  assert.equal(p.$('d-rtt').textContent, '4'); assert.equal(p.$('d-loss').textContent, '1.5'); assert.equal(p.$('d-limit').textContent, 'none');
  assert.equal(p.$('d-path').textContent, 'host → prflx / udp'); assert.equal(p.$('d-attempts').textContent, '3', 'offers made since the page was loaded');
  assert.match(p.$('d-state').textContent, /^live/);
  for (let i = 0; i < 5; i++) p.$('pill').click();
  assert.equal(p.$('diag').hidden, true);

  assert.equal(p.$('landscape').hidden, true);
  p.g.screen.orientation.type = 'landscape-primary'; p.g.screen.orientation.emit('change');
  assert.equal(p.$('landscape').hidden, false);
  assert.equal(p.link.state, 'live', 'the stream continues under the hint');
  p.g.coarse = false; p.g.window.emit('resize');
  assert.equal(p.$('landscape').hidden, true, 'a desktop browser is always "landscape": no hint there');
  p.g.coarse = true; p.g.screen.orientation.type = 'portrait-primary'; p.g.screen.orientation.emit('change');
  assert.equal(p.$('landscape').hidden, true);

  const debug = page({ search: '?debug=1&voice=1&codec=vp8' });
  await debug.c.settle();
  assert.equal(debug.$('diag').hidden, false, '?debug=1');
  debug.$('start').click(); await debug.c.settle();
  assert.equal(debug.media.calls[0].audio.echoCancellation, true, '?voice=1');
  assert.equal(debug.pcs[0].transceivers[0].prefs[0].mimeType, 'video/VP8', '?codec=vp8');

  const unpaired = page();
  unpaired.api.status = { http: 401, error: 'PAIRING_REQUIRED' };
  await unpaired.link.preflight();
  assert.equal(unpaired.$('notice-text').textContent, TEXT.unpaired);
  assert.deepEqual(unpaired.visible(), ['notice', 'pair-box', 'pair-code', 'pair-go', 'pair-link'], 'the code can be typed right here');
  // a wrong code: said in her words, the field stays
  unpaired.api.pair.push({ http: 401, error: 'INVALID_PAIRING_CODE' }, { http: 429, error: 'TOO_MANY_ATTEMPTS' }, new Error('offline'));
  unpaired.$('pair-code').value = '00000000'; unpaired.$('pair-go').click();
  assert.equal(unpaired.$('pair-go').disabled, true, 'one try at a time'); await unpaired.c.settle();
  assert.equal(unpaired.$('pair-error').textContent, EXTRA_TEXT.pairBad); assert.equal(unpaired.$('pair-error').hidden, false); assert.equal(unpaired.$('pair-go').disabled, false);
  unpaired.$('pair-code').emit('keydown', { key: '1' }); await unpaired.c.settle(); assert.equal(unpaired.api.of('POST', '/api/mobile/pair').length, 1);
  unpaired.$('pair-code').emit('keydown', { key: 'Enter' }); await unpaired.c.settle(); assert.equal(unpaired.$('pair-error').textContent, EXTRA_TEXT.pairWait, 'Enter in the field does the same as the button');
  unpaired.$('pair-go').click(); await unpaired.c.settle(); assert.equal(unpaired.$('pair-error').textContent, EXTRA_TEXT.pairFailed);
  // the right code: paired, the notice is gone and the start card is back
  unpaired.$('pair-code').value = '12345678'; unpaired.$('pair-go').click(); await unpaired.c.settle();
  assert.deepEqual(JSON.parse(unpaired.api.of('POST', '/api/mobile/pair').at(-1).body), { code: '12345678', label: 'Browser cam' });
  assert.equal(unpaired.$('pair-code').value, ''); assert.equal(unpaired.$('pair-error').hidden, true);
  assert.deepEqual(unpaired.visible(), ['start', 'start-card']);
  assert.equal(unpaired.media.calls.length, 0, 'pairing asked for no camera');
});

// ---- operator page -------------------------------------------------------------------------------------------

test('operator page: AUDIO OFF and the program-window banner appear exactly when the spec says', () => {
  // the shape lib/cam-link.mjs answers on GET /api/link/ops
  const ops = (over = {}) => ({
    version: '1.3.0', serverTime: T0, iceServers: [],
    program: {
      online: true, ready: true, throttled: false, pageId: 'air', parked: true, state: 'connected', showing: 'webrtc', hidden: false, attempt: '1a2b3c4d', echoAgeMs: 200,
      stats: { w: 720, h: 1280, fps: 30, framesDecoded: 900, freezeCount: 0, jitterMs: 3, kbps: 2100, rttMs: 4, lossPct: 0, rafHz: 60, drawHz: 30, pcCreated: 1, vw: 736, vh: 1319, dpr: 1, ...over.window },
      audio: { wanted: true, playing: true, level: 0.2, sink: 'CABLE Input' }, path: { local: 'host', remote: 'host', protocol: 'udp' }, ...over.program,
    },
    link: {
      state: 'connected', mine: false, since: T0 - 7000, echoAgeMs: 200, stats: { w: 720, h: 1280, fps: 30, kbps: 2100, rttMs: 4, lossPct: 0 },
      audio: { wanted: true, playing: true, level: 0.2, sink: 'CABLE Input' }, path: { local: 'host', remote: 'host', protocol: 'udp' }, lastError: null,
      attempt: '1a2b3c4d', phase: 'answered', waiting: false, adopted: false, client: { label: 'Android' },
      capture: { video: 'live', audio: 'live', visible: true, at: T0 - 500, stats: { w: 1280, h: 720, fps: 30, kbps: 2400, rttMs: 4, codec: 'video/H264', encoder: 'MediaCodec', limit: 'none' } }, ...over.link,
    },
    air: { known: true, live: false }, dev: true, build: { version: '1.3.0', root: 'C:/studio', startedAt: T0 - 60000 }, lease: { pageId: 'air', lastSeenAt: T0 - 500 }, queue: { length: 0, seq: 5 },
    events: over.events || [{ at: T0 - 2000, type: 'offer', detail: { attempt: '1a2b3c4d', client: 'Android', takeover: false } }, { at: T0 - 1000, type: 'connected', detail: { attempt: '1a2b3c4d', ms: 640 } }],
  });
  const ids = data => opsView(data).banners.map(b => b.id);
  assert.deepEqual(ids(ops()), [], 'all good: no banner');
  assert.deepEqual(ids(ops({ link: { audio: { wanted: false, playing: false, level: 0, sink: '' } } })), ['audio']);
  assert.deepEqual(ids(ops({ link: { audio: { wanted: true, playing: false, level: 0, sink: 'no_sink' } } })), ['audio']);
  assert.equal(opsView(ops({ link: { audio: { wanted: false } } })).banners[0].text, 'AUDIO OFF');
  assert.match(opsView(ops({ link: { audio: { wanted: true, playing: false, sink: 'no_sink' } } })).banners[0].detail, /no_sink/);
  assert.deepEqual(ids(ops({ link: { state: 'idle', audio: { wanted: false } } })), [], 'no link, no audio alarm');
  assert.match(opsView(ops({ link: { audio: { wanted: true, playing: false, sink: 'no_sink' } } })).banners[0].detail, /allow Microphone for the program page/, 'the usual cause of no_sink and its cure are named');
  // before anybody is connected: the hub's link.audio.sink is empty then, and the page's own word (it looks for the device at start-up) is what counts
  const waiting = sink => ops({ program: { audio: { wanted: true, playing: false, level: 0, sink } }, link: { state: 'idle', audio: { wanted: true, playing: false, level: 0, sink: '' }, capture: null } });
  const sinkRow = data => Object.fromEntries(opsView(data).cards.find(c => c.id === 'audio').rows).sink;
  assert.deepEqual(ids(waiting('no_sink')), ['sink'], 'the operator learns of a silent output before she is on camera');
  assert.deepEqual([opsView(waiting('no_sink')).banners[0].text, sinkRow(waiting('no_sink'))], ['OUTPUT DEVICE NOT FOUND', 'no_sink']);
  assert.match(opsView(waiting('no_sink')).banners[0].detail, /silent.*allow Microphone for the program page/);
  assert.deepEqual([ids(waiting('CABLE Input')), sinkRow(waiting('CABLE Input'))], [[], 'CABLE Input'], 'and sees the device that WILL be used');
  assert.deepEqual(ids(ops({ program: { audio: { wanted: false, playing: false, level: 0, sink: '' } }, link: { state: 'idle', audio: { wanted: false } } })), [], 'desk mode wants no output');
  assert.deepEqual(ids(ops({ program: { online: false, audio: { wanted: true, sink: 'no_sink' } }, link: { state: 'idle' } })), [], 'a closed program window is offline, nothing else');
  assert.deepEqual(ids(ops({ program: { audio: { wanted: true, playing: false, level: 0, sink: 'no_sink' } }, link: { audio: { wanted: true, playing: false, level: 0, sink: 'no_sink' } } })), ['audio'], 'connected: AUDIO OFF says it, once');
  assert.deepEqual(ids(ops({ link: { state: 'negotiating', audio: { wanted: false } } })), []);
  assert.deepEqual(ids(ops({ program: { throttled: true } })), ['window']);
  assert.equal(opsView(ops({ program: { throttled: true } })).banners[0].text, 'PROGRAM WINDOW THROTTLED');
  assert.deepEqual(ids(ops({ window: { vw: 700 } })), ['window']);
  assert.equal(opsView(ops({ window: { vw: 700 } })).banners[0].text, 'PROGRAM WINDOW TOO SMALL');
  assert.match(opsView(ops({ window: { vw: 700 } })).banners[0].detail, /700x1319.*720x1280/);
  assert.deepEqual(ids(ops({ window: { vw: 720, vh: 1279 } })), ['window']);
  assert.deepEqual(ids(ops({ window: { vw: 720, vh: 1280 } })), [], 'exactly 720x1280 is enough');
  assert.deepEqual(ids(ops({ program: { throttled: true }, link: { audio: { wanted: false } } })), ['audio', 'window'], 'both at once');
  assert.deepEqual(ids(ops({ program: { online: false, throttled: true }, link: { state: 'lost' } })), [], 'a closed program window is "offline", not "throttled"');
  assert.deepEqual(ids(ops({ program: { stats: null } })), [], 'a page that has not reported yet has no known size');
  assert.deepEqual(ids(null), []); assert.deepEqual(ids({}), []);

  const view = opsView(ops());
  const card = id => Object.fromEntries(view.cards.find(c => c.id === id).rows);
  assert.deepEqual(view.cards.map(c => c.id), ['program', 'link', 'video', 'audio', 'phone', 'air', 'build']);
  assert.deepEqual(card('program'), { online: 'yes', ready: 'yes', throttled: 'no', viewport: '736 x 1319 CSS px', 'device pixel ratio': '1', 'page id': 'air', 'last seen': 'now (its poll is open)', showing: 'webrtc (connected)', 'raf / draw Hz': '60 / 30', 'connections made': '1' });
  assert.equal(Object.fromEntries(opsView(ops({ program: { parked: false } })).cards[0].rows)['last seen'], '0.5 s ago');
  assert.deepEqual(card('link'), { state: 'connected', since: '7.0 s ago', 'program echo age': '200 ms', 'last error': '—', 'ICE path': 'host -> host / udp', phone: 'Android · attempt 1a2b3c4d' });
  assert.deepEqual(card('video'), { size: '720 x 1280', fps: '30', bitrate: '2100 kbps', 'round trip': '4 ms', loss: '0 %', 'frames decoded': '900', freezes: '0', jitter: '3 ms' });
  assert.deepEqual(card('audio'), { wanted: 'yes', playing: 'yes', level: '0.200', sink: 'CABLE Input' });
  assert.deepEqual(card('phone'), { video: 'live', audio: 'live', 'page visible': 'yes', sending: '1280 x 720 @ 30 fps, 2400 kbps', 'codec / encoder': 'video/H264 / MediaCodec', 'limited by': 'none' });
  assert.deepEqual(card('air'), { 'event connection known': 'yes', live: 'no' });
  assert.equal(card('build').version, '1.3.0'); assert.equal(card('build').root, 'C:/studio'); assert.equal(card('build')['dev mode (LINK_DEV)'], 'yes');
  assert.deepEqual(view.events.map(e => [e.type, e.detail]), [['connected', 'attempt=1a2b3c4d ms=640'], ['offer', 'attempt=1a2b3c4d client=Android takeover=false']], 'newest first');
  assert.equal(opsView(ops({ events: Array.from({ length: 80 }, (_, i) => ({ at: i, type: 't' + i })) })).events.length, 50);
  assert.deepEqual(opsView(ops({ link: { capture: null } })).cards.map(c => c.id), ['program', 'link', 'video', 'audio', 'air', 'build'], 'no phone card without a link');
  assert.equal(opsView(ops({ link: { audio: { wanted: false } } })).cards.find(c => c.id === 'audio').tone, 'bad');
  // tolerant of the page's numbers arriving under link.stats instead
  const moved = opsView({ program: { online: true, throttled: false }, link: { state: 'idle', stats: { vw: 600, vh: 900, dpr: 1.5 } } });
  assert.deepEqual(moved.banners.map(b => b.id), ['window']);
  assert.equal(JSON.stringify(opsView(ops({ events: [{ at: 1, type: '<b>', detail: { note: '<img src=x>' } }] }))).includes('<img'), true, 'values stay text: the page writes them with textContent, never as markup');
  assert.doesNotMatch(file('ops.js'), /innerHTML|insertAdjacentHTML/);
});
