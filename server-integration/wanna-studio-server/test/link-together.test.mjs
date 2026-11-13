// CAM LINK — the parts together. The other three link suites each test one part against a scripted stand-in for the
// others (hub: test/cam-link.test.mjs, program page: test/link-core.test.mjs, phone: test/cam-client.test.mjs). The races
// between the parts only show when two real parts run against each other, so here the REAL hub (lib/cam-link.mjs) and the
// REAL phone client (public/cam/cam-link.js) share one hand-driven clock, joined by a fetch shim; the program page is a
// small model of fx/link-receiver.js that speaks its protocol with its own time limits (taken from fx/link-core.js):
// one long poll after the other, an answer some hundred milliseconds after an offer, an echo every second while a link
// exists, the last frame held for under 3 s. No browser, no socket, no real timer: a 40 s scenario runs in milliseconds.
//
// What the model cannot show is what a real page paints; that part of each rule is pinned in test/link-core.test.mjs
// (for example: stop(replaced) holds the frame there, and here the hub is shown to send exactly that message first).
// The phone is handed in as a paired session that outlives a gateway restart, as on the LINK_DEV / adb-reverse test bed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createCamLink } from '../lib/cam-link.mjs';
import { CamLink } from '../public/cam/cam-link.js';
import { backoffMs, pollOutcome, LEASE_PARKED_MS, RETRY_PARKED_MS, BUSY_RETRY_MS, DENIED_RETRY_MS, FAST_EMPTY_MS, FAST_EMPTY_WAIT_MS, REPEAT_WAIT_MS, ECHO_LIVE_MS, ECHO_IDLE_MS, SLATE_MS } from '../fx/link-core.js';

const T0 = 1762000000000, KEY = 'unit-test-program-key-0123456789', ORIGIN = 'http://127.0.0.1:8800';
const CRLF = '\r\n', sdp = lines => lines.join(CRLF) + CRLF;
const SESSION = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1'];
const AUDIO = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=mid:1', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1'];
const FMTP = 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
const OFFER = sdp([...SESSION, 'm=video 9 UDP/TLS/RTP/SAVPF 102 103', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=sendonly', 'a=rtpmap:102 H264/90000', FMTP, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', ...AUDIO, 'a=sendonly']);
const ANSWER = sdp([...SESSION, 'm=video 9 UDP/TLS/RTP/SAVPF 102 103', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=recvonly', 'a=rtpmap:102 H264/90000', FMTP, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', ...AUDIO, 'a=recvonly']);
const GOOD = { w: 720, h: 1280, fps: 30, framesDecoded: 900, freezeCount: 0, jitterMs: 12, kbps: 1800, rttMs: 4, lossPct: 0, rafHz: 60, drawHz: 30, pcCreated: 1, vw: 736, vh: 1319, dpr: 1 };
const PHONE_A = { id: 'phone-a', label: 'Phone A' }, PHONE_B = { id: 'phone-b', label: 'Phone B' };

// ---- one clock for everybody ------------------------------------------------------------------------------------
function clock(start = T0) {
  let t = start, seq = 0; const pending = [];
  const timers = {
    setTimeout(fn, ms) { const h = { id: ++seq, at: t + Math.max(0, Number(ms) || 0), fn }; pending.push(h); return h; },
    clearTimeout(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    for (;;) { pending.sort((a, b) => a.at - b.at || a.id - b.id); const next = pending[0]; if (!next || next.at > end) break; t = next.at; pending.shift(); next.fn(); await settle(); }
    t = end; await settle();
  }
  return { now: () => t, timers, advance, settle };
}

// ---- what the phone's browser provides (the fakes of test/cam-client.test.mjs, reduced to what a link needs) --------
class Emitter {
  constructor() { this.handlers = new Map(); }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.handlers.get(type) || [])]) fn(event); }
}
class FakeTrack extends Emitter {
  constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; this.muted = false; this.enabled = true; }
  stop() { this.readyState = 'ended'; }
}
class FakeMedia extends Emitter {
  async getUserMedia(c) { const tracks = [...(c.video ? [new FakeTrack('video')] : []), ...(c.audio ? [new FakeTrack('audio')] : [])]; return { getTracks: () => [...tracks], getVideoTracks: () => tracks.filter(t => t.kind === 'video'), getAudioTracks: () => tracks.filter(t => t.kind === 'audio'), addTrack() {}, removeTrack() {} }; }
}
class FakeDocument extends Emitter { constructor() { super(); this.visibilityState = 'visible'; } }
class FakePC {
  constructor(config) { this.config = config; this.connectionState = 'new'; this.iceGatheringState = 'new'; this.localDescription = null; this.closed = false; this.bytes = 0; this.frozen = false; }
  addTransceiver(track) { return { sender: { track, getParameters: () => ({ encodings: [{}] }), async setParameters() {}, async replaceTrack(next) { this.track = next; } }, setCodecPreferences() {} }; }
  async createOffer() { return { type: 'offer', sdp: OFFER }; }
  async setLocalDescription(d) { this.localDescription = { type: d.type, sdp: d.sdp + 'a=candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host' + CRLF }; this.iceGatheringState = 'complete'; this.onicegatheringstatechange?.(); }
  async setRemoteDescription() { this.connectionState = 'connecting'; }
  set(state) { if (this.closed) return; this.connectionState = state; this.onconnectionstatechange?.(); }
  async getStats() {
    if (!this.frozen && this.connectionState === 'connected') this.bytes += 312500;
    return new Map([['V', { id: 'V', type: 'outbound-rtp', kind: 'video', bytesSent: this.bytes, frameWidth: 720, frameHeight: 1280, framesPerSecond: 30 }]]);
  }
  close() { this.closed = true; this.connectionState = 'closed'; }
}

// ---- the world: a clock, a hub that can be restarted, and the "network" between the parts ---------------------------
function world() {
  const c = clock(), w = { c, down: false, events: [], hubEvents: [] };
  const at = () => (c.now() - T0) / 1000;
  w.at = at; w.say = (who, what) => { w.events.push(at().toFixed(2).padStart(6) + '  ' + who.padEnd(8) + what); };
  w.newHub = () => { w.hub = createCamLink({ env: {}, port: 8801, upstreamPort: 8800, root: 'X:/together', version: '1.3.0', now: c.now, timers: c.timers, programKey: KEY, log: e => { w.hubEvents.push({ at: at(), type: e.type, detail: e.detail }); w.say('hub', e.type + ' ' + JSON.stringify(e.detail)); } }); };
  w.newHub();
  w.sleep = ms => new Promise(r => c.timers.setTimeout(r, ms));
  // the gateway process dies and comes back empty (a new hub); requests in between fail like a refused connection
  w.restart = async downMs => { const old = w.hub; w.down = true; old.close(); w.say('TEST', 'gateway down'); await c.advance(downMs); w.newHub(); w.down = false; w.say('TEST', 'gateway back (a new, empty hub)'); w.backAt = at(); };
  w.count = type => w.hubEvents.filter(e => e.type === type).length;
  w.trace = () => '\n' + w.events.join('\n');
  // one request to the hub, as fetch sees it. cutAfter: the caller's network drops that long after the hub took the request
  w.call = (method, route, { headers = {}, body, local = false, paired, signal, cutAfter = null } = {}) => new Promise((resolve, reject) => {
    if (w.down) return reject(new TypeError('Failed to fetch'));
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(req, { method, url: route, socket: { remoteAddress: '127.0.0.1' }, headers: Object.fromEntries(Object.entries({ host: local ? '127.0.0.1:8801' : 'phone.example', ...headers }).map(([k, v]) => [k.toLowerCase(), v])) });
    const res = new EventEmitter(); let gone = false;
    Object.assign(res, { req, status: 0, headers: {}, text: '', headersSent: false, writableEnded: false, destroyed: false });
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = String(v); };
    res.writeHead = (status, h = {}) => { res.status = status; for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = String(v); res.headersSent = true; return res; };
    res.end = chunk => {
      if (chunk !== undefined) res.text += chunk; res.writableEnded = true; setImmediate(() => res.emit('close'));
      if (!gone) resolve({ status: res.status, ok: res.status >= 200 && res.status < 300, headers: { get: n => res.headers[String(n).toLowerCase()] ?? null }, text: async () => res.text, json: async () => JSON.parse(res.text) });
    };
    const leave = error => { if (gone || res.writableEnded) return; gone = true; res.destroyed = true; res.emit('close'); reject(error); };
    if (signal) signal.addEventListener('abort', () => leave(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    if (cutAfter != null) c.timers.setTimeout(() => leave(new TypeError('network changed')), cutAfter);
    w.hub.handle(req, res, new URL(route, 'http://gateway'), { local, paired });
  });
  return w;
}

// ---- the real phone client -------------------------------------------------------------------------------------------
function phone(w, session, name) {
  const doc = new FakeDocument(), win = new Emitter(); let n = 0;
  const ph = { name, pcs: [], states: [], whips: [], cutNextWhip: null, dead: false };
  class PC extends FakePC { constructor(cfg) { super(cfg); ph.pcs.push(this); } }
  const fetchImpl = (url, init = {}) => {
    if (ph.dead) return Promise.reject(new TypeError('the page is gone'));
    const u = new URL(url, 'http://gateway.test'), method = init.method || 'GET', isWhip = method === 'POST' && u.pathname === '/api/link/whip';
    const cutAfter = isWhip ? ph.cutNextWhip : null; if (isWhip) ph.cutNextWhip = null;
    const p = w.call(method, u.pathname + u.search, { headers: init.headers, body: init.body, paired: session, signal: init.signal, cutAfter });
    if (isWhip) {
      const rec = { attempt: init.headers['X-Link-Attempt'], at: w.at(), status: null, code: '' }; ph.whips.push(rec);
      p.then(async r => { rec.status = r.status; if (r.status !== 201) { try { rec.code = JSON.parse(await r.text()).error; } catch { /* no body */ } } w.say(name, `whip ${rec.attempt} -> ${r.status} ${rec.code}`); }, () => { rec.status = 0; w.say(name, `whip ${rec.attempt} -> no reply`); });
    }
    return p;
  };
  ph.link = new CamLink({
    fetch: fetchImpl, PeerConnection: PC, mediaDevices: new FakeMedia(), RtpSender: null, RtpReceiver: null, wakeLock: null, document: doc, window: win,
    now: w.c.now, timers: w.c.timers, randomId: () => name + '-' + String(++n).padStart(4, '0'),
    onState: s => { const word = s.state + (s.error ? '(' + s.error + ')' : ''); if (ph.states.at(-1) !== word) { ph.states.push(word); w.say(name, 'state ' + word); } },
  });
  ph.open = () => ph.pcs.filter(pc => !pc.closed);
  // the browser is killed: no bye, no more requests, and its connections die with it
  ph.kill = () => { ph.dead = true; ph.link.halt(); };
  return ph;
}

// ---- the program page, reduced to its protocol (fx/link-receiver.js) ------------------------------------------------
// engine: 'ready' | 'loading' (what it reports while its models load) · answerMs: offer -> answer (gathering) ·
// blockedUntil: the page is held up (a long task): it handles nothing and reports nothing until then.
function page(w, id, { inst = 'load-' + id, takeover = 1, engine = 'ready', answerMs = 400, phones = [] } = {}) {
  const H = { origin: ORIGIN, 'x-link-program-key': KEY, 'content-type': 'application/json' };
  const p = { id, inst, engine, answerMs, phones, alive: true, superseded: false, lease: 'none', after: 0, fails: 0, session: null, blockedUntil: 0, got: [], closed: [], blackouts: [], holdTimer: null, echoAt: -1e9 };
  const post = (route, json) => w.call('POST', '/api/link/program/' + route, { local: true, headers: H, body: JSON.stringify(json) }).catch(() => null);
  const free = async () => { while (p.alive && w.c.now() < p.blockedUntil) await w.sleep(p.blockedUntil - w.c.now()); };
  p.word = () => (p.engine !== 'ready' ? 'loading' : !p.session ? 'idle' : p.session.connected ? 'connected' : 'answering');
  p.echo = async () => {
    if (!p.alive || p.superseded || p.lease !== 'held' || w.c.now() < p.blockedUntil) return;
    p.echoAt = w.c.now();
    await post('state', { program: id, inst, attempt: p.session?.id ?? null, state: p.word(), showing: p.session?.connected ? 'webrtc' : 'slate', stats: GOOD, hidden: false, audio: { wanted: false, playing: false, level: 0, sink: null }, path: { local: 'host', remote: 'host', protocol: 'udp' } });
  };
  const setLease = v => { if (p.lease === v) return; p.lease = v; if (v === 'held') void p.echo(); };
  const black = why => { p.blackouts.push({ at: w.at(), why }); w.say('page ' + id, 'BLACK (' + why + ')'); };
  // keepFrame: her last frame stays for what is left of its 3 s; black follows only if no new picture came by then
  p.close = (why, keepFrame) => {
    const s = p.session; if (!s) return; p.session = null; p.closed.push(s.id); w.say('page ' + id, `closes ${s.id} (${why})`);
    const pc = s.pc; if (pc) w.c.timers.setTimeout(() => { if (!pc.closed) pc.set('failed'); }, 500); // the phone's end notices that the far end is gone
    if (!s.connected) return;
    if (!keepFrame) return black(why);
    w.c.timers.clearTimeout(p.holdTimer); p.holdTimer = w.c.timers.setTimeout(() => { if (!p.session?.connected) black('held frame ran out after ' + why); }, SLATE_MS);
  };
  const connect = s => { // the two ends connect about 300 ms after the answer reached the phone
    for (const ph of p.phones) { const pc = ph.pcs.at(-1); if (pc && !pc.closed && ph.link.pending?.id === s.id) { s.pc = pc; pc.set('connected'); } }
    if (!s.pc) return; // nobody is at the other end (the phone gave up meanwhile)
    s.connected = true; w.c.timers.clearTimeout(p.holdTimer); void p.echo();
  };
  async function handle(m) {
    p.got.push({ at: w.at(), type: m.type, attempt: m.attempt, reason: m.reason });
    if (m.type === 'offer') {
      if (p.session?.id === m.attempt || p.closed.includes(m.attempt)) return; // delivered again
      p.close('new offer', true);
      const s = p.session = { id: m.attempt, connected: false, pc: null }; void p.echo();
      await w.sleep(p.answerMs); await free(); if (p.session !== s) return;
      const r = await post('answer', { program: id, inst, attempt: s.id, sdp: ANSWER });
      if (!r || r.status !== 200) { if (p.session === s) { p.session = null; p.closed.push(s.id); } return; }
      w.c.timers.setTimeout(() => { if (p.session === s) connect(s); }, 300);
    } else if (m.type === 'stop' && p.session?.id === m.attempt) { p.close('stop ' + m.reason, m.reason === 'replaced'); void p.echo(); }
  }
  (async () => { // the hub client: one long poll after the other
    while (p.alive && !p.superseded) {
      const t0 = w.c.now(), parked = w.c.timers.setTimeout(() => setLease('held'), p.fails ? RETRY_PARKED_MS : LEASE_PARKED_MS);
      let status = 0, body = null;
      try { const r = await w.call('GET', `/api/link/program/poll?program=${id}&inst=${inst}&after=${p.after}&takeover=${takeover}`, { local: true, headers: H }); status = r.status; if (status !== 204) { try { body = await r.json(); } catch { body = null; } } } catch { status = 0; }
      w.c.timers.clearTimeout(parked);
      if (!p.alive) return;
      await free(); // a page that is held up reads the reply only when it is free again
      const out = pollOutcome(status, body); let wait = 0;
      if (out.kind !== 'error') p.fails = 0;
      if (out.kind === 'message') { setLease('held'); if (out.message.seq <= p.after) wait = REPEAT_WAIT_MS; p.after = out.message.seq; void handle(out.message); }
      else if (out.kind === 'empty') { setLease('held'); if (w.c.now() - t0 < FAST_EMPTY_MS) wait = FAST_EMPTY_WAIT_MS; }
      else if (out.kind === 'superseded') { p.superseded = true; p.lease = 'superseded'; w.say('page ' + id, 'superseded: stops for good'); p.close('superseded', false); return; }
      else { p.after = 0; if (out.kind === 'busy') { p.lease = 'busy'; wait = BUSY_RETRY_MS; } else if (out.kind === 'denied') { setLease('none'); wait = DENIED_RETRY_MS; } else { p.fails++; if (p.fails >= 3) setLease('none'); wait = backoffMs(p.fails); } }
      if (wait) await w.sleep(wait);
    }
  })();
  (async () => { while (p.alive && !p.superseded) { await w.sleep(ECHO_LIVE_MS); if (p.session || w.c.now() - p.echoAt >= ECHO_IDLE_MS - 20) await p.echo(); } })(); // every second with a link, every 5 s idle
  p.shut = () => { p.alive = false; }; // the window is closed without a bye
  return p;
}

// one phone linked to one program page, proven for `holdMs`
async function linked(options = {}) {
  const w = world(), a = phone(w, PHONE_A, 'phoneA'), pg = page(w, 'air', { phones: [a], ...options });
  await w.c.advance(1500); await a.link.start(); await w.c.advance(options.holdMs ?? 15000);
  assert.equal(a.link.state, 'live', 'the link came up' + w.trace());
  return { w, a, pg };
}
const order = (pg, types) => pg.got.filter(m => types.includes(m.type)).map(m => m.type + ' ' + m.attempt + (m.reason ? ' ' + m.reason : ''));

// ---------------------------------------------------------------------------------------------------------------------

test('together: one tap links the phone, and the hub, the page and the phone agree about it', async () => {
  const { w, a, pg } = await linked();
  const ops = w.hub.snapshot();
  assert.deepEqual([ops.link.state, ops.link.phase, ops.program.online, ops.program.ready, ops.link.client.label], ['connected', 'answered', true, true, 'Phone A']);
  assert.deepEqual([a.pcs.length, a.open().length, pg.closed.length, pg.blackouts.length], [1, 1, 0, 0], 'one connection on each side, nothing closed');
  assert.deepEqual(a.whips.map(x => x.status), [201]);
  const snap = a.link.snapshot();
  assert.deepEqual([snap.pill.tone, snap.control, snap.status.link.mine], ['ok', 'ok', true], 'the pill is green from the page\'s own echo');
  await a.link.stop(); await w.c.advance(1500);
  assert.deepEqual([w.hub.snapshot().link.state, pg.session, pg.blackouts.map(b => b.why)], ['idle', null, ['stop client_stop']], 'she stopped: black at once, an idle hub');
});

test('together: a recovery swap — the hub tells the page to drop the old attempt BEFORE the new offer, and her picture is never black', async () => {
  const { w, a, pg } = await linked();
  // the page is held up for 6 s (no echo, no answer); media keeps flowing; the phone finds the echo stale and offers again
  pg.blockedUntil = w.c.now() + 6000; await w.c.advance(20000);
  const first = a.whips[0].attempt, second = a.whips[1]?.attempt;
  assert.ok(second, 'the phone offered again' + w.trace());
  assert.deepEqual(order(pg, ['stop', 'offer']), ['offer ' + first, 'stop ' + first + ' replaced', 'offer ' + second], 'stop(replaced) comes first: that is the message the receiver holds her last frame on' + w.trace());
  assert.deepEqual([a.link.state, a.open().length, pg.session?.id, pg.session?.connected], ['live', 1, second, true], 'swapped to the new connection' + w.trace());
  assert.deepEqual(pg.blackouts, [], 'the new picture arrived inside the 3 s her last frame is held' + w.trace());
  assert.deepEqual([w.count('replaced'), w.count('lost'), a.whips.length], [1, 0, 2], 'one swap, and it settles');
});

for (const downMs of [1000, 4000, 9000]) {
  test(`together: the gateway is restarted (down ${downMs / 1000} s) — media keeps flowing, the hub adopts the link, and the phone does not replace it`, async () => {
    const { w, a, pg } = await linked();
    const attempt = a.whips[0].attempt;
    await w.restart(downMs); await w.c.advance(25000);
    const adopted = w.hubEvents.find(e => e.type === 'adopted');
    assert.ok(adopted, 'the new hub adopted the running link from the page\'s echo' + w.trace());
    assert.ok(adopted.at - w.backAt <= 1300, `adopted ${(adopted.at - w.backAt).toFixed(2)} s after the gateway was back: inside the phone's 3 s of "not mine"` + w.trace());
    assert.deepEqual([a.link.state, a.pcs.length, a.open().length, a.whips.length], ['live', 1, 1, 1], 'the phone kept its one connection and never offered again' + w.trace());
    assert.deepEqual([pg.closed, pg.blackouts, pg.session?.id], [[], [], attempt], 'the page kept the connection it had' + w.trace());
    assert.deepEqual([w.count('replaced'), w.count('lost'), w.count('offer')], [0, 0, 1], 'nothing was replaced or lost');
    const ops = w.hub.snapshot(), snap = a.link.snapshot();
    assert.deepEqual([ops.link.state, ops.link.adopted, ops.link.attempt], ['connected', true, attempt.slice(0, 8)]);
    assert.deepEqual([snap.status.link.mine, snap.pill.tone, snap.control], [true, 'ok', 'ok'], 'and the phone owns it again: a green pill from the new hub\'s status');
    await a.link.stop(); await w.c.advance(1500);
    assert.deepEqual([w.hub.snapshot().link.state, pg.session], ['idle', null], 'she can still stop the adopted link');
  });
}

test('together: the program page comes back after the gateway only seconds later — the phone waits for it instead of replacing a healthy link', async () => {
  const { w, a, pg } = await linked();
  // the worst order: the gateway is back at once, the page is held up for 5 s more before it finds it again
  pg.blockedUntil = w.c.now() + 6000; await w.restart(1000); await w.c.advance(4000);
  assert.deepEqual([w.hub.snapshot().program.online, a.link.state, a.whips.length], [false, 'live', 1], 'gateway up, program not yet: "not mine" is not counted' + w.trace());
  await w.c.advance(25000);
  assert.deepEqual([w.count('adopted'), w.count('replaced'), a.link.state, a.pcs.length, pg.closed.length, pg.blackouts.length], [1, 0, 'live', 1, 0, 0], w.trace());
});

test('together: an offer that was cut off while it waited does not lock the phone out until it times out', async () => {
  const w = world(), a = phone(w, PHONE_A, 'phoneA'), pg = page(w, 'air', { phones: [a] });
  await w.c.advance(1500);
  pg.blockedUntil = w.c.now() + 3000; // the page is busy (its engine loads): no answer for 3 s
  a.cutNextWhip = 300;                // and the phone's Wi-Fi drops the waiting request after 300 ms
  const tapAt = w.at(); await a.link.start(); await w.c.advance(12000);
  assert.deepEqual(a.whips.map(x => [x.status, x.code]).slice(0, 2), [[0, ''], [201, '']], 'the second offer is taken at once (no 429 OFFER_IN_FLIGHT)' + w.trace());
  assert.equal(a.whips.some(x => x.code === 'OFFER_IN_FLIGHT'), false);
  const up = w.hubEvents.find(e => e.type === 'connected');
  assert.ok(up && up.at - tapAt < 6, `linked ${up ? (up.at - tapAt).toFixed(1) : '?'} s after the tap, not after the dead offer's 8 s` + w.trace());
  assert.deepEqual([a.link.state, a.open().length, pg.session?.id], ['live', 1, a.whips[1].attempt]);
  assert.deepEqual(order(pg, ['stop', 'offer']), ['offer ' + a.whips[0].attempt, 'stop ' + a.whips[0].attempt + ' replaced', 'offer ' + a.whips[1].attempt], 'the page was told to drop the dead attempt first');
});

test('together: the same paired phone after a lost bye — her new page links at once; a second page that is alive is another device', async () => {
  const { w, a, pg } = await linked();
  // the browser is killed (no bye reaches the hub); she opens the page again and taps 4 s later, inside the 10 s the link counts as held
  a.kill(); await w.c.advance(4000);
  const a2 = phone(w, PHONE_A, 'phoneA2'); pg.phones.push(a2);
  await a2.link.start(); await w.c.advance(6000);
  assert.deepEqual([a2.whips.map(x => [x.status, x.code]), a2.link.state], [[[201, '']], 'live'], 'no "the camera moved to another device" for her own phone' + w.trace());
  assert.equal(a2.states.some(s => s.startsWith('replaced')), false);
  // now a second tab of the same phone while the first is alive and linked: that one has to press the button
  const a3 = phone(w, PHONE_A, 'phoneA3'); pg.phones.push(a3);
  await a3.link.start(); await w.c.advance(3000);
  assert.deepEqual([a3.whips.map(x => [x.status, x.code]), a3.link.state, a2.link.state], [[[409, 'LINK_REPLACED']], 'replaced', 'live'], 'the link in use is left alone' + w.trace());
  await a3.link.start({ takeover: true }); await w.c.advance(8000);
  assert.deepEqual([a3.link.state, a2.link.state], ['live', 'replaced'], '"bring it back here" moves it, and the other tab lets go' + w.trace());
  assert.equal(a2.open().length + a.open().length, 0);
});

test('together: two phones while the program page still loads — the one that pressed the button keeps the link, no back and forth', async () => {
  const w = world(), a = phone(w, PHONE_A, 'phoneA'), b = phone(w, PHONE_B, 'phoneB'), pg = page(w, 'air', { phones: [a, b], engine: 'loading' });
  await w.c.advance(1500); await a.link.start(); await w.c.advance(6000);
  assert.deepEqual([a.link.state, w.hub.snapshot().link.state, w.hub.snapshot().program.ready], ['live', 'negotiating', false], 'linked, and the page says "loading"' + w.trace());
  await b.link.start(); await w.c.advance(2000);
  assert.deepEqual([b.link.state, b.whips[0].code, a.link.state], ['replaced', 'LINK_REPLACED', 'live'], 'another phone needs the button although the page never said "connected"' + w.trace());
  await b.link.start({ takeover: true }); await w.c.advance(30000);
  assert.deepEqual([b.link.state, a.link.state, pg.session?.id], ['live', 'replaced', b.whips.at(-1).attempt], 'B holds the link, A let go' + w.trace());
  assert.equal(w.count('replaced'), 1, 'the link changed hands exactly once' + w.trace());
  assert.deepEqual([a.open().length, b.open().length, a.pcs.length, pg.closed.length], [0, 1, 2, 1], 'A made one more connection (its refused retry), the page closed exactly one');
  pg.engine = 'ready'; await w.c.advance(3000);
  assert.deepEqual([w.hub.snapshot().link.state, b.link.snapshot().pill.tone], ['connected', 'ok'], 'and when the engine is ready it is B who is seen');
});

test('together: a second program window with the same address takes the slot over; the first stops for good and the link heals with one swap', async () => {
  const { w, a, pg } = await linked();
  const second = page(w, 'air', { inst: 'load-second', phones: [a] }); // the launcher's address again: program=air, takeover=1
  await w.c.advance(40000);
  assert.deepEqual([pg.superseded, pg.session, second.lease, second.session?.connected], [true, null, 'held', true], 'the older window stopped for good, the newer one holds the link' + w.trace());
  assert.deepEqual([a.link.state, a.pcs.length, a.open().length], ['live', 2, 1], 'the phone made one new connection' + w.trace());
  assert.deepEqual([w.count('program_superseded'), w.count('lost'), w.count('connected')], [1, 1, 2], 'lost once and linked again, not every few seconds' + w.trace());
  assert.equal(w.hubEvents.filter(e => e.type === 'answer_refused').length, 0, 'no second page answered the same offer');
  // the stopped window being closed releases nothing
  const before = w.hubEvents.length;
  await w.call('POST', '/api/link/program/bye?program=air&inst=' + pg.inst, { local: true, headers: { origin: ORIGIN } });
  await w.c.advance(3000);
  assert.deepEqual([w.hub.snapshot().program.online, w.hub.snapshot().link.state, w.hubEvents.slice(before).map(e => e.type)], [true, 'connected', []]);
});

test('together: the program window is closed without a bye and opened again — the phone is linked again by itself', async () => {
  const { w, a, pg } = await linked();
  pg.shut(); pg.close('window closed', false); // no bye: the hub learns it from the silence
  const again = page(w, 'air', { inst: 'load-again', phones: [a] });
  await w.c.advance(20000);
  assert.deepEqual([a.link.state, a.open().length, again.session?.connected, w.hub.snapshot().link.state], ['live', 1, true, 'connected'], w.trace());
  assert.ok(a.pcs.length <= 3, 'without a storm of attempts: ' + a.pcs.length + w.trace());
});
