// CAM LINK hub (lib/cam-link.mjs) and its place in the gateway (mobile-gateway.mjs).
// Part 1 drives the hub directly with a hand-driven clock and pretend requests: every time rule is exact and instant.
// Part 2 goes through createMobileGateway over real sockets on a temp workspace root: who may call what, CORS, body
// limits, the whole offer/answer round trip, and the /cam/ files. No WebRTC here: an SDP is an opaque string.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createCamLink, createGatewayCamLink, linkProgramKey, linkFileLog, parseIceServers, validSdp, LEASE_MS, ONLINE_GRACE_MS, OFFER_TTL_MS, HELD_MS, HOLDER_SILENT_MS, DISOWN_GRACE_MS, QUEUE_MAX, EVENTS_MAX, OFFERS_PER_MINUTE } from '../lib/cam-link.mjs';
import { createMobileGateway } from '../mobile-gateway.mjs';

const T0 = 1762000000000;
const KEY = 'unit-test-program-key-0123456789';
const ORIGIN = 'http://127.0.0.1:8800';
const sdp = tag => 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=' + tag + '\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\n' + 'a=rtpmap:96 VP8/90000\r\n'.repeat(8);
const OFFER = sdp('the-offer'), ANSWER = sdp('the-answer');
const PHONE_A = { id: 'phone-a', label: 'Test phone' }, PHONE_B = { id: 'phone-b', label: 'Second phone' };
const GOOD_STATS = { w: 720, h: 1280, fps: 30, framesDecoded: 900, freezeCount: 0, jitterMs: 12, kbps: 1800, rttMs: 4, lossPct: 0, rafHz: 60, drawHz: 30, pcCreated: 1, vw: 736, vh: 1319, dpr: 1 };

// a clock the test moves by hand: the hub takes now() and its timers from here
function clock(start = T0) {
  let t = start, id = 0; const pending = [];
  const timers = {
    setTimeout(fn, ms) { const h = { id: ++id, at: t + Math.max(0, Number(ms) || 0), fn, unref() { return h; } }; pending.push(h); return h; },
    clearTimeout(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
  };
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    for (;;) { pending.sort((a, b) => a.at - b.at || a.id - b.id); const next = pending[0]; if (!next || next.at > end) break; t = next.at; pending.shift(); next.fn(); await settle(); }
    t = end; await settle();
  }
  return { now: () => t, timers, advance, settle, get pending() { return pending.length; } };
}

// a pretend request: the answer is collected on the returned object; leave() = the client went away without an answer
function send(hub, method, route, { headers = {}, body, json, local = false, paired } = {}) {
  const payload = json !== undefined ? JSON.stringify(json) : body;
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]);
  const lower = Object.fromEntries(Object.entries({ host: 'phone.example', ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  Object.assign(req, { method, url: route, headers: lower, socket: { remoteAddress: '127.0.0.1' } });
  const res = new EventEmitter();
  Object.assign(res, { req, status: 0, headers: {}, text: '', headersSent: false, writableEnded: false, destroyed: false });
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = String(v); };
  res.writeHead = (status, h = {}) => { res.status = status; for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = String(v); res.headersSent = true; return res; };
  res.end = chunk => { if (chunk !== undefined) res.text += chunk; res.writableEnded = true; setImmediate(() => res.emit('close')); };
  res.leave = () => { res.destroyed = true; res.emit('close'); };
  Object.defineProperty(res, 'json', { get() { try { return JSON.parse(res.text); } catch { return undefined; } } });
  res.handled = hub.handle(req, res, new URL(route, 'http://gateway'), { local, paired });
  return res;
}

function setup(options = {}) {
  const c = clock(), logged = [];
  const hub = createCamLink({ env: {}, port: 8801, upstreamPort: 8800, root: 'X:/unit-test-root', version: '1.3.0', now: c.now, timers: c.timers, log: e => logged.push(e), programKey: KEY, ...options });
  const s = { c, hub, logged };
  // the program page's requests: a local request, the program origin, the key
  s.page = (method, route, extra = {}) => send(hub, method, '/api/link/program/' + route, { local: true, ...extra, headers: { host: '127.0.0.1:8801', origin: ORIGIN, 'x-link-program-key': KEY, ...extra.headers } });
  s.poll = (pageId, after = 0, takeover = 0) => s.page('GET', `poll?program=${pageId}&after=${after}${takeover ? '&takeover=1' : ''}`);
  s.answer = (pageId, attempt, body = ANSWER) => s.page('POST', 'answer', { json: { program: pageId, attempt, sdp: body } });
  s.report = (pageId, attempt, state, extra = {}) => s.page('POST', 'state', { json: { program: pageId, attempt, state, showing: state === 'connected' ? 'webrtc' : 'slate', stats: GOOD_STATS, hidden: false, audio: { wanted: true, playing: true, level: 0.2, sink: 'CABLE Input' }, path: { local: 'host', remote: 'prflx', protocol: 'udp' }, ...extra } });
  // the phone's requests: a paired session, not local
  s.phone = (method, route, extra = {}) => send(hub, method, '/api/link/' + route, { paired: PHONE_A, ...extra });
  s.whip = (o = {}) => s.phone('POST', 'whip', { paired: o.session ?? PHONE_A, body: o.sdp ?? OFFER, headers: { 'content-type': 'application/sdp', ...(o.client ? { 'x-link-client': o.client } : {}), ...(o.attempt ? { 'x-link-attempt': o.attempt } : {}), ...(o.takeover ? { 'x-link-takeover': '1' } : {}), ...o.headers } });
  s.status = (o = {}) => s.phone('GET', 'status' + (o.attempt ? '?attempt=' + o.attempt : ''), { paired: o.session ?? PHONE_A, headers: o.client ? { 'x-link-client': o.client } : {} });
  s.stop = (attempt, o = {}) => s.phone(o.bye ? 'POST' : 'DELETE', 'whip/' + attempt + (o.bye ? '/bye' : ''), { paired: o.session ?? PHONE_A });
  s.tell = (attempt, body, o = {}) => s.phone('POST', 'state', { paired: o.session ?? PHONE_A, json: { attempt, ...body }, headers: o.client ? { 'x-link-client': o.client } : {} });
  s.view = () => hub.snapshot();
  return s;
}

// a pretend program page that behaves like the real one: it polls again at once and acknowledges what it received
function programPage(s, id, { takeover = 0 } = {}) {
  const page = { id, after: 0, inbox: [], open: null, refused: null };
  page.pump = async () => {
    await s.c.settle();
    for (let guard = 0; guard < 200; guard++) {
      if (page.open) {
        if (!page.open.writableEnded) return page; // parked
        const r = page.open; page.open = null;
        if (r.status === 200) { page.inbox.push(r.json); page.after = r.json.seq; } else if (r.status !== 204) { page.refused = r; return page; }
      }
      page.open = s.poll(id, page.after, takeover); await page.open.handled; await s.c.settle();
    }
    throw new Error('the pretend page never came to rest');
  };
  page.take = () => page.inbox.splice(0);
  return page;
}
// phone offers, page answers, page reports "connected"
async function connect(s, page, { attempt = 'attempt-0001', client = 'client-0001', session, takeover } = {}) {
  await page.pump();
  const w = s.whip({ attempt, client, session, takeover }); await w.handled; await page.pump();
  assert.ok(page.inbox.some(m => m.type === 'offer' && m.attempt === attempt), 'the page received the offer');
  const a = s.answer(page.id, attempt); await a.handled; assert.equal(a.status, 200, a.text);
  assert.equal(w.status, 201);
  const r = s.report(page.id, attempt, 'connected'); await r.handled; assert.equal(r.status, 200, r.text);
  return w;
}
const done = async r => { await r.handled; return r; };

// ---------------------------------------------------------------- part 1: the hub, by hand ----------------------

test('one program page owns the slot: another page is busy until the lease ends, and takeover supersedes the old page for good', async () => {
  const s = setup();
  const air = await done(s.poll('air')); assert.equal(air.writableEnded, false, 'the first page is parked: it owns the slot');
  const tab = await done(s.poll('tab')); assert.equal(tab.status, 409); assert.deepEqual(tab.json, { error: 'PROGRAM_BUSY' });
  assert.equal(air.writableEnded, false, 'and the owner is not disturbed');
  const taker = await done(s.poll('tab', 0, 1));
  assert.equal(air.status, 410); assert.deepEqual(air.json, { error: 'PROGRAM_SUPERSEDED' }); assert.equal(taker.writableEnded, false, 'takeover=1 takes the slot and parks');
  assert.equal(s.view().lease.pageId, 'tab');
  assert.deepEqual((await done(s.poll('air'))).json, { error: 'PROGRAM_BUSY' }, 'the old page without takeover is now the busy one');
  await s.c.advance(25000); assert.equal(taker.status, 204, 'a poll with nothing to deliver ends empty after the wait');
  await s.c.advance(LEASE_MS - 1); assert.equal((await done(s.poll('air'))).status, 409, 'the lease lasts 10 s after the last poll ended');
  await s.c.advance(1);
  const back = await done(s.poll('air')); assert.equal(back.writableEnded, false, 'after that the next page is the first one again');
  assert.equal(s.view().lease.pageId, 'air'); assert.equal(s.view().lease.lastSeenAt, s.c.now());
  // a page displaced while it had no poll parked is told so on its next poll, once
  await s.c.advance(25000); assert.equal(back.status, 204);
  const again = await done(s.poll('tab', 0, 1)); assert.equal(again.writableEnded, false);
  const told = await done(s.poll('air', 0, 1)); assert.equal(told.status, 410, 'even with takeover=1 in its link the displaced page is told to stop'); assert.deepEqual(told.json, { error: 'PROGRAM_SUPERSEDED' });
  assert.equal(again.writableEnded, false, 'and the new owner keeps its poll');
  assert.deepEqual(s.logged.filter(e => e.type.startsWith('program_')).map(e => e.type), ['program_lease', 'program_busy', 'program_superseded', 'program_lease', 'program_busy', 'program_lost', 'program_lease', 'program_superseded', 'program_lease']);
  assert.equal(s.logged.filter(e => e.type === 'program_busy' && e.detail.program === 'air').length, 1, 'a page that keeps retrying is written once');
});

test('the same page polling again replaces its own parked poll, and a poll that ends leaves no timer behind', async () => {
  const s = setup();
  const first = await done(s.poll('air')), second = await done(s.poll('air'));
  assert.equal(first.status, 204, 'the older poll of the same page is released'); assert.equal(second.writableEnded, false); assert.equal(s.c.pending, 1);
  second.leave(); await s.c.settle(); assert.equal(s.c.pending, 0, 'a page that went away takes its timer along');
  const third = await done(s.poll('air')); await s.c.advance(24999); assert.equal(third.writableEnded, false);
  await s.c.advance(1); assert.equal(third.status, 204); assert.equal(third.text, ''); assert.equal(s.c.pending, 0);
  for (const bad of ['', 'a b', 'x'.repeat(41), '<script>']) assert.deepEqual((await done(s.page('GET', 'poll?program=' + encodeURIComponent(bad)))).json, { error: 'PROGRAM_INVALID' });
});

test('online means a parked poll or one that ended under 3 s ago; an offer without a program is refused at once and never parked', async () => {
  const s = setup();
  const early = await done(s.whip({ attempt: 'attempt-0001' }));
  assert.equal(early.status, 503); assert.deepEqual(early.json, { error: 'PROGRAM_OFFLINE' }); assert.equal(s.c.pending, 0, 'nothing is parked');
  assert.equal(s.view().program.online, false); assert.equal(s.view().link.lastError, 'PROGRAM_OFFLINE');
  const p = await done(s.poll('air')); assert.equal(s.view().program.online, true);
  await s.c.advance(25000); assert.equal(p.status, 204); assert.equal(s.view().program.online, true, 'between two polls the page is still online');
  await s.c.advance(ONLINE_GRACE_MS - 1); assert.equal(s.view().program.online, true);
  await s.c.advance(1); assert.equal(s.view().program.online, false);
  assert.equal((await done(s.whip({ attempt: 'attempt-0002' }))).status, 503);
  // the refusal was not stored: the same attempt is accepted as soon as the page polls, and is handed to it at once
  const p2 = await done(s.poll('air'));
  const w = await done(s.whip({ attempt: 'attempt-0002' })); assert.equal(w.writableEnded, false, 'now it waits for the answer');
  assert.equal(p2.status, 200); assert.equal(p2.json.type, 'offer'); assert.equal(p2.json.attempt, 'attempt-0002');
  // an offer that arrives between two polls (online by the 3 s rule) waits for the next poll
  const s2 = setup(); const q = await done(s2.poll('air')); await s2.c.advance(25000); assert.equal(q.status, 204);
  const between = await done(s2.whip({ attempt: 'attempt-0003' })); assert.equal(between.writableEnded, false);
  assert.equal((await done(s2.poll('air'))).json.attempt, 'attempt-0003');
});

test('an offer is not used up by delivery: a reloaded page gets it again until it is answered; stop and capture messages are acknowledged away', async () => {
  const s = setup();
  const p1 = await done(s.poll('air'));
  const w = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' }));
  const offer = p1.json;
  assert.deepEqual(Object.keys(offer).sort(), ['attempt', 'client', 'iceServers', 'sdp', 'seq', 'type']);
  assert.deepEqual({ ...offer, seq: 0 }, { seq: 0, type: 'offer', attempt: 'attempt-0001', sdp: OFFER, iceServers: [], client: { label: 'Test phone' } });
  assert.ok(offer.seq > T0, 'message numbers start above anything an earlier gateway run handed out');
  const reloaded = await done(s.poll('air', 0)); assert.equal(reloaded.status, 200); assert.equal(reloaded.json.seq, offer.seq, 'the same offer again for a page that starts from zero');
  const stale = await done(s.poll('air', offer.seq + 1000)); assert.equal(stale.json?.seq, offer.seq, 'a number from an earlier gateway run counts as zero');
  const acked = await done(s.poll('air', offer.seq)); assert.equal(acked.writableEnded, false, 'a page that has it waits for the next message');
  assert.equal((await done(s.answer('air', 'attempt-0001'))).status, 200); assert.equal(w.status, 201);
  // answered: gone for everybody
  const afterAnswer = await done(s.poll('air', 0)); assert.equal(acked.status, 204); assert.equal(afterAnswer.writableEnded, false);
  // a capture message: delivered again until acknowledged, then never
  assert.equal((await done(s.tell('attempt-0001', { video: 'live', audio: 'live', visible: false }))).status, 200);
  const capture = afterAnswer.json; assert.deepEqual({ ...capture, seq: 0 }, { seq: 0, type: 'capture', attempt: 'attempt-0001', video: 'live', audio: 'live', visible: false });
  assert.ok(capture.seq > offer.seq, 'seq only grows');
  assert.equal((await done(s.poll('air', offer.seq))).json.seq, capture.seq, 'not acknowledged yet: delivered again');
  const quiet = await done(s.poll('air', capture.seq)); assert.equal(quiet.writableEnded, false);
  const fresh = await done(s.poll('air', 0)); assert.equal(quiet.status, 204); assert.equal(fresh.writableEnded, false, 'acknowledged messages are not replayed to a reloaded page');
  assert.equal(s.view().queue.length, 0);
});

test('an unanswered offer is handed out for 10 s at most, even when the phone is allowed to wait longer', async () => {
  const s = setup({ answerMs: 20000 });
  await done(s.poll('air')); const w = await done(s.whip({ attempt: 'attempt-0001' }));
  await s.c.advance(OFFER_TTL_MS - 1); assert.equal((await done(s.poll('air', 0))).json.type, 'offer');
  await s.c.advance(1); const late = await done(s.poll('air', 0)); assert.equal(late.writableEnded, false, 'too old to start on');
  await s.c.advance(10000); assert.equal(w.status, 504);
});

test('the answer reaches the waiting phone as 201 with Location and application/sdp; a repeat is harmless, anything else is stale', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const w = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' })); await page.pump();
  assert.deepEqual((await done(s.answer('tab', 'attempt-0001'))).json, { error: 'STALE_ATTEMPT' }, 'only the page that owns the slot may answer');
  assert.deepEqual((await done(s.answer('air', 'attempt-9999'))).json, { error: 'STALE_ATTEMPT' }, 'only for the current attempt');
  assert.deepEqual((await done(s.answer('air', 'attempt-0001', 'not an sdp'))).json, { error: 'SDP_INVALID' });
  assert.deepEqual((await done(s.answer('air', 'x'))).json, { error: 'ATTEMPT_INVALID' });
  assert.equal(w.writableEnded, false, 'none of these touched the waiting phone');
  const ok = await done(s.answer('air', 'attempt-0001')); assert.equal(ok.status, 200); assert.deepEqual(ok.json, { ok: true });
  assert.equal(w.status, 201); assert.equal(w.headers['content-type'], 'application/sdp'); assert.equal(w.headers.location, '/api/link/whip/attempt-0001'); assert.equal(w.text, ANSWER);
  assert.equal(w.headers['access-control-allow-origin'], undefined);
  assert.deepEqual((await done(s.answer('air', 'attempt-0001'))).json, { ok: true, repeated: true });
  const other = await done(s.answer('air', 'attempt-0001', sdp('another-answer'))); assert.equal(other.status, 409); assert.deepEqual(other.json, { error: 'STALE_ATTEMPT' });
  assert.equal(s.view().link.state, 'negotiating', 'answered, and the page has not reported "connected" yet');
  assert.equal((await done(s.report('air', 'attempt-0001', 'answering'))).status, 200); assert.equal(s.view().link.state, 'negotiating');
  assert.equal((await done(s.report('air', 'attempt-0001', 'connected'))).status, 200); assert.equal(s.view().link.state, 'connected');
  assert.equal((await done(s.report('air', 'attempt-0001', 'stalled'))).status, 200); assert.equal(s.view().link.state, 'stalled');
  assert.equal((await done(s.report('air', 'attempt-0001', 'connected'))).status, 200); assert.equal(s.view().link.state, 'connected');
  assert.equal(s.c.pending, 1, 'only the page\'s parked poll is left waiting');
});

test('no answer within 8 s is 504 PROGRAM_TIMEOUT, and a page that had seen the offer is told to stop', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const w = await done(s.whip({ attempt: 'attempt-0001' })); await page.pump(); assert.equal(page.take()[0].type, 'offer');
  await s.c.advance(7999); assert.equal(w.writableEnded, false); assert.equal(s.view().link.state, 'negotiating');
  await s.c.advance(1); assert.equal(w.status, 504); assert.deepEqual(w.json, { error: 'PROGRAM_TIMEOUT' });
  await page.pump(); const [stop] = page.take(); assert.deepEqual({ ...stop, seq: 0 }, { seq: 0, type: 'stop', attempt: 'attempt-0001', reason: 'expired' });
  assert.deepEqual((await done(s.answer('air', 'attempt-0001'))).json, { error: 'STALE_ATTEMPT' }, 'a late answer is refused');
  assert.equal(s.view().link.state, 'idle'); assert.equal(s.view().link.lastError, 'PROGRAM_TIMEOUT');
  // a page that never saw the offer is told nothing
  const s2 = setup(); const p = await done(s2.poll('air')); await s2.c.advance(25000); assert.equal(p.status, 204);
  const w2 = await done(s2.whip({ attempt: 'attempt-0002' })); await s2.c.advance(8000); assert.equal(w2.status, 504);
  const next = await done(s2.poll('air', 0)); assert.equal(next.writableEnded, false, 'no offer and no stop are waiting'); assert.equal(s2.view().queue.length, 0);
});

test('a phone that left before the answer came makes the answer 410 CLIENT_GONE', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const w = await done(s.whip({ attempt: 'attempt-0001' })); await page.pump();
  assert.deepEqual([s.view().link.phase, s.view().link.waiting, s.view().program.parked], ['pending', true, true], 'the operator sees a waiting phone and a parked poll');
  w.leave();
  assert.equal(s.view().link.waiting, false);
  const a = await done(s.answer('air', 'attempt-0001')); assert.equal(a.status, 410); assert.deepEqual(a.json, { error: 'CLIENT_GONE' });
  assert.equal(w.status, 0, 'nothing was written to the phone that left');
  assert.equal(s.view().link.state, 'idle'); assert.equal(s.view().link.lastError, 'CLIENT_GONE'); assert.equal(s.c.pending, 1, 'its timer is gone; only the parked poll is left');
  assert.deepEqual((await done(s.answer('air', 'attempt-0001'))).json, { error: 'STALE_ATTEMPT' });
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0001' }))).json, { error: 'STALE_ATTEMPT' }, 'the same attempt cannot be started again');
});

test('an offer from another paired phone replaces a waiting one: the first gets 409 REPLACED', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const first = await done(s.whip({ attempt: 'attempt-000a', client: 'client-000a', session: PHONE_A })); await page.pump(); page.take();
  const second = await done(s.whip({ attempt: 'attempt-000b', client: 'client-000b', session: PHONE_B }));
  assert.equal(first.status, 409); assert.deepEqual(first.json, { error: 'REPLACED' }); assert.equal(second.writableEnded, false);
  await page.pump(); const got = page.take();
  assert.deepEqual(got.map(m => [m.type, m.attempt, m.reason]), [['stop', 'attempt-000a', 'replaced'], ['offer', 'attempt-000b', undefined]], 'the page had seen the first offer: it is told to drop it BEFORE the new one');
  assert.equal(got[1].client.label, 'Second phone');
  assert.deepEqual((await done(s.answer('air', 'attempt-000a'))).json, { error: 'STALE_ATTEMPT' });
  assert.equal((await done(s.answer('air', 'attempt-000b'))).status, 200); assert.equal(second.status, 201);
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-000a', session: PHONE_A }))).json, { error: 'REPLACED' }, 'asking again gives the stored result');
});

test('another client is refused with LINK_REPLACED while the link was connected in the last 10 s; takeover wins; the same client may always re-offer', async () => {
  const s = setup(), page = programPage(s, 'air');
  await connect(s, page, { attempt: 'attempt-0001', client: 'client-0001' }); page.take();
  const other = await done(s.whip({ attempt: 'attempt-0002', client: 'client-0002' }));
  assert.equal(other.status, 409); assert.deepEqual(other.json, { error: 'LINK_REPLACED' }); assert.equal(s.view().link.state, 'connected', 'the link in use is untouched');
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0002' }))).json, { error: 'LINK_REPLACED' }, 'a request with no client id is another client too');
  // "bring it back here": the same request with the takeover header
  const taken = await done(s.whip({ attempt: 'attempt-0002', client: 'client-0002', takeover: true })); assert.equal(taken.writableEnded, false);
  await page.pump(); assert.deepEqual(page.take().map(m => [m.type, m.attempt, m.reason]), [['stop', 'attempt-0001', 'replaced'], ['offer', 'attempt-0002', undefined]]);
  assert.equal((await done(s.status({ client: 'client-0001' }))).json.link.mine, false, 'the first device sees that the link is no longer its own');
  assert.equal((await done(s.answer('air', 'attempt-0002'))).status, 200); assert.equal(taken.status, 201);
  assert.equal((await done(s.report('air', 'attempt-0002', 'connected'))).status, 200);
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0003', client: 'client-0001' }))).json, { error: 'LINK_REPLACED' }, 'and its automatic retry is refused');
  // the client that holds the link replaces its own attempt freely (recovery: a new attempt on a new connection)
  const again = await done(s.whip({ attempt: 'attempt-0004', client: 'client-0002' })); assert.equal(again.writableEnded, false);
  await page.pump(); assert.deepEqual(page.take().map(m => [m.type, m.attempt, m.reason]), [['stop', 'attempt-0002', 'replaced'], ['offer', 'attempt-0004', undefined]]);
  assert.equal((await done(s.answer('air', 'attempt-0004'))).status, 200); assert.equal((await done(s.report('air', 'attempt-0004', 'connected'))).status, 200);
  // a link the program has not called "connected" for 10 s is no longer held
  assert.equal((await done(s.report('air', 'attempt-0004', 'stalled'))).status, 200);
  await s.c.advance(HELD_MS - 1); await page.pump(); await done(s.status({ client: 'client-0002', attempt: 'attempt-0004' })); // (the holder's page is alive: it asks for its status)
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0005', client: 'client-0001' }))).json, { error: 'LINK_REPLACED' });
  await s.c.advance(1); await page.pump();
  const free = await done(s.whip({ attempt: 'attempt-0005', client: 'client-0001' })); assert.equal(free.writableEnded, false);
});

test('the same X-Link-Attempt again returns the stored result and never a second offer', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const w = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' })); await page.pump(); page.take();
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' }))).json, { error: 'OFFER_IN_FLIGHT' }, 'still waiting: the second copy is turned away, the first keeps waiting');
  assert.equal((await done(s.answer('air', 'attempt-0001'))).status, 200); assert.equal(w.status, 201);
  const repeat = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' }));
  assert.equal(repeat.status, 201); assert.equal(repeat.text, ANSWER); assert.equal(repeat.headers.location, '/api/link/whip/attempt-0001');
  await page.pump(); assert.deepEqual(page.take(), [], 'the page is not asked again');
  const thief = await done(s.whip({ attempt: 'attempt-0001', session: PHONE_B })); assert.equal(thief.status, 409); assert.deepEqual(thief.json, { error: 'STALE_ATTEMPT' }); assert.ok(!thief.text.includes('the-answer'), 'another session never gets the stored answer');
  assert.equal((await done(s.stop('attempt-0001'))).status, 200);
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' }))).json, { error: 'STALE_ATTEMPT' }, 'the answer of an ended link is not handed out again');
  // a timed-out attempt answers 504 again, at once
  const slow = await done(s.whip({ attempt: 'attempt-0002', client: 'client-0001' })); await s.c.advance(8000); assert.equal(slow.status, 504);
  const again = await done(s.whip({ attempt: 'attempt-0002', client: 'client-0001' })); assert.equal(again.status, 504); assert.deepEqual(again.json, { error: 'PROGRAM_TIMEOUT' });
  // without the header the hub names the attempt itself (plain WHIP)
  await page.pump(); page.take();
  const plain = await done(s.whip({ client: 'client-0001' })); await page.pump();
  const named = page.take().find(m => m.type === 'offer').attempt; assert.match(named, /^[0-9a-f-]{36}$/);
  assert.equal((await done(s.answer('air', named))).status, 200); assert.equal(plain.headers.location, '/api/link/whip/' + named);
  assert.deepEqual((await done(s.whip({ headers: { 'x-link-attempt': 'short' } }))).json, { error: 'ATTEMPT_INVALID' });
});

test('one offer in flight and ten offers a minute per identity', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const first = await done(s.whip({ attempt: 'attempt-0000' }));
  const second = await done(s.whip({ attempt: 'attempt-00xx' })); assert.equal(second.status, 429); assert.deepEqual(second.json, { error: 'OFFER_IN_FLIGHT' }); assert.equal(first.writableEnded, false);
  assert.equal((await done(s.stop('attempt-0000'))).status, 200); assert.deepEqual(first.json, { error: 'STALE_ATTEMPT' }, 'stopping a waiting attempt releases its request');
  for (let i = 1; i < OFFERS_PER_MINUTE; i++) { await page.pump(); const w = await done(s.whip({ attempt: 'attempt-000' + i })); assert.equal(w.writableEnded, false, 'offer ' + (i + 1)); await done(s.stop('attempt-000' + i)); }
  await page.pump();
  const eleventh = await done(s.whip({ attempt: 'attempt-0010' })); assert.equal(eleventh.status, 429); assert.deepEqual(eleventh.json, { error: 'OFFER_RATE_LIMIT' });
  const neighbour = await done(s.whip({ attempt: 'attempt-00b1', session: PHONE_B })); assert.equal(neighbour.writableEnded, false, 'another identity has its own count');
  await done(s.stop('attempt-00b1', { session: PHONE_B }));
  await s.c.advance(59999); await page.pump(); assert.equal((await done(s.whip({ attempt: 'attempt-0011' }))).status, 429);
  await s.c.advance(1); await page.pump();
  const later = await done(s.whip({ attempt: 'attempt-0012' })); assert.equal(later.writableEnded, false, 'a minute later the count is free again');
});

test('a link is also held while the page reports "loading" for it, and from a takeover for 10 s; "lost" and "stalled" never hold it', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  // phone A is linked while the program engine still loads: the page names the attempt and says "loading", never "connected"
  const a = await done(s.whip({ attempt: 'attempt-000a', client: 'client-000a', session: PHONE_A })); await page.pump(); page.take();
  assert.equal((await done(s.answer('air', 'attempt-000a'))).status, 200); assert.equal(a.status, 201);
  assert.equal((await done(s.report('air', 'attempt-000a', 'loading'))).status, 200); assert.equal(s.view().link.state, 'negotiating');
  const b = await done(s.whip({ attempt: 'attempt-000b', client: 'client-000b', session: PHONE_B }));
  assert.deepEqual([b.status, b.json], [409, { error: 'LINK_REPLACED' }], 'another phone needs the takeover header although the page never said "connected"');
  // B presses "bring it back here": from that moment B holds the link, before the page has said a word about B's attempt
  const taken = await done(s.whip({ attempt: 'attempt-000c', client: 'client-000b', session: PHONE_B, takeover: true })); assert.equal(taken.writableEnded, false);
  const retry = await done(s.whip({ attempt: 'attempt-000d', client: 'client-000a', session: PHONE_A }));
  assert.deepEqual([retry.status, retry.json], [409, { error: 'LINK_REPLACED' }], 'the displaced phone\'s automatic offer does not take a waiting takeover back'); assert.equal(taken.writableEnded, false);
  await page.pump(); page.take(); assert.equal((await done(s.answer('air', 'attempt-000c'))).status, 200); assert.equal(taken.status, 201);
  assert.equal((await done(s.report('air', 'attempt-000c', 'loading'))).status, 200);
  await s.c.advance(HELD_MS - 1); assert.equal((await done(s.report('air', 'attempt-000c', 'loading'))).status, 200); // 10 s after the takeover: only the "loading" reports hold it now
  await s.c.advance(HELD_MS - 1);
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-000e', client: 'client-000a', session: PHONE_A }))).json, { error: 'LINK_REPLACED' }, 'the page still holds B\'s connection while it loads');
  assert.equal(s.logged.filter(e => e.type === 'replaced').length, 1, 'the link changed hands once, not back and forth');
  // a holder the page reports as lost or stalled is not protected: 10 s after its last good report anybody may offer
  assert.equal((await done(s.report('air', 'attempt-000c', 'lost'))).status, 200);
  await s.c.advance(HELD_MS - 1); await page.pump(); assert.equal((await done(s.report('air', 'attempt-000c', 'stalled'))).status, 200);
  await s.c.advance(1); await page.pump();
  const free = await done(s.whip({ attempt: 'attempt-000f', client: 'client-000a', session: PHONE_A })); assert.equal(free.writableEnded, false, 'a dead holder can be replaced without the button');
  // a takeover whose phone hung up while it waited holds nothing
  await page.pump(); page.take(); await done(s.stop('attempt-000f', { session: PHONE_A })); await page.pump();
  const gone = await done(s.whip({ attempt: 'attempt-000g', client: 'client-000b', session: PHONE_B, takeover: true })); gone.leave(); await s.c.settle();
  const next = await done(s.whip({ attempt: 'attempt-000h', client: 'client-000a', session: PHONE_A })); assert.equal(next.writableEnded, false);
});

test('an offer whose phone hung up while it waited does not block that phone\'s next offer', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const cut = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' })); await page.pump();
  assert.deepEqual(page.take().map(m => [m.type, m.attempt]), [['offer', 'attempt-0001']]);
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0002', client: 'client-0001' }))).json, { error: 'OFFER_IN_FLIGHT' }, 'while the first request is still open: one offer in flight');
  cut.leave(); await s.c.settle(); // the phone\'s network dropped: nobody waits for that answer any more
  const again = await done(s.whip({ attempt: 'attempt-0003', client: 'client-0001' })); assert.equal(again.writableEnded, false, 'the next offer is taken at once, not after the dead one timed out');
  assert.equal(cut.headersSent, false, 'nothing is written to the request that is gone');
  await page.pump();
  assert.deepEqual(page.take().map(m => [m.type, m.attempt, m.reason]), [['stop', 'attempt-0001', 'replaced'], ['offer', 'attempt-0003', undefined]], 'the page is told to drop the dead attempt before it gets the new offer');
  assert.deepEqual((await done(s.answer('air', 'attempt-0001'))).json, { error: 'STALE_ATTEMPT' });
  assert.equal((await done(s.answer('air', 'attempt-0003'))).status, 200); assert.equal(again.status, 201);
  assert.equal(s.c.pending, 1, 'only the parked poll is left: the dead attempt\'s timer went with it');
});

test('the same paired phone with a new page needs no takeover once its old page has gone quiet; a page that is alive keeps the link', async () => {
  const s = setup(), page = programPage(s, 'air');
  await connect(s, page, { attempt: 'attempt-0001', client: 'client-0001' }); page.take();
  // the old page lives: it asks for its status every second. A second tab of the same phone is another client.
  await s.c.advance(1000); await page.pump(); await done(s.status({ client: 'client-0001', attempt: 'attempt-0001' })); await done(s.report('air', 'attempt-0001', 'connected'));
  await s.c.advance(HOLDER_SILENT_MS - 1); await page.pump();
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0002', client: 'client-0002' }))).json, { error: 'LINK_REPLACED' }, 'heard from the holder under 3 s ago');
  // the browser was killed (no bye): nothing more from client-0001. She opens the page again and taps, well inside the 10 s
  await s.c.advance(1); await done(s.report('air', 'attempt-0001', 'connected'));
  const other = await done(s.whip({ attempt: 'attempt-0003', client: 'client-0003', session: PHONE_B }));
  assert.deepEqual(other.json, { error: 'LINK_REPLACED' }, 'another paired phone still needs the button');
  const back = await done(s.whip({ attempt: 'attempt-0004', client: 'client-0004' })); assert.equal(back.writableEnded, false, 'her own new page does not');
  await page.pump(); assert.deepEqual(page.take().map(m => [m.type, m.attempt, m.reason]), [['stop', 'attempt-0001', 'replaced'], ['offer', 'attempt-0004', undefined]]);
  // LINK_DEV: every local caller shares one identity, so only the client id tells two pages apart
  const d = setup({ env: { LINK_DEV: '1' } }), dpage = programPage(d, 'air'); await dpage.pump();
  const local = (attempt, client) => send(d.hub, 'POST', '/api/link/whip', { local: true, body: OFFER, headers: { host: '127.0.0.1:8801', 'content-type': 'application/sdp', 'x-link-client': client, 'x-link-attempt': attempt } });
  const first = await done(local('attempt-0001', 'client-0001')); await dpage.pump(); dpage.take();
  assert.equal((await done(d.answer('air', 'attempt-0001'))).status, 200); assert.equal(first.status, 201); assert.equal((await done(d.report('air', 'attempt-0001', 'connected'))).status, 200);
  await d.c.advance(HOLDER_SILENT_MS + 2000); await dpage.pump();
  assert.deepEqual((await done(local('attempt-0002', 'client-0002'))).json, { error: 'LINK_REPLACED' }, 'in development mode a quiet holder is still another client');
});

test('two windows opened with the same page id are two pages: the newer one with takeover=1 wins and the older one stops for good', async () => {
  const s = setup(), poll = (inst, after = 0, takeover = 1) => s.page('GET', `poll?program=air&inst=${inst}&after=${after}${takeover ? '&takeover=1' : ''}`);
  const first = await done(poll('load-0001')); assert.equal(first.writableEnded, false);
  const again = await done(poll('load-0001')); assert.equal(first.status, 204, 'the same window polling again only replaces its own poll'); assert.equal(again.writableEnded, false);
  // a link on window 1
  const w = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' })); assert.equal(again.status, 200);
  const state = (inst, attempt, word) => s.page('POST', 'state', { json: { program: 'air', inst, attempt, state: word, showing: 'slate', stats: GOOD_STATS, hidden: false, audio: {}, path: null } });
  assert.equal((await done(s.page('POST', 'answer', { json: { program: 'air', inst: 'load-0001', attempt: 'attempt-0001', sdp: ANSWER } }))).status, 200); assert.equal(w.status, 201);
  assert.equal((await done(state('load-0001', 'attempt-0001', 'connected'))).status, 200); assert.equal(s.view().link.state, 'connected');
  const parked = await done(poll('load-0001', again.json.seq));
  // a second window with the same address but no takeover is simply busy, and can neither report nor answer nor say bye for the first
  assert.deepEqual((await done(poll('load-0002', 0, 0))).json, { error: 'PROGRAM_BUSY' }); assert.equal(parked.writableEnded, false);
  assert.deepEqual((await done(state('load-0002', null, 'idle'))).json, { error: 'PROGRAM_BUSY' }); assert.equal(s.view().link.state, 'connected', 'its "idle" does not end the first window\'s link');
  assert.deepEqual((await done(s.page('POST', 'answer', { json: { program: 'air', inst: 'load-0002', attempt: 'attempt-0001', sdp: ANSWER } }))).json, { error: 'STALE_ATTEMPT' });
  assert.equal((await done(s.page('POST', 'bye?program=air&inst=load-0002'))).status, 200); assert.equal(s.view().program.online, true, 'and closing it releases nothing');
  // the launcher's address carries takeover=1: the second window takes the slot, the first is told to stop for good, the link is over at once
  const taker = await done(poll('load-0002')); assert.equal(taker.writableEnded, false);
  assert.deepEqual([parked.status, parked.json], [410, { error: 'PROGRAM_SUPERSEDED' }]);
  assert.deepEqual([s.view().link.state, s.view().link.lastError], ['lost', 'PROGRAM_SUPERSEDED']);
  assert.deepEqual((await done(state('load-0001', 'attempt-0001', 'connected'))).json, { error: 'PROGRAM_BUSY' }, 'the older window no longer reports');
  // the older window had no poll open when it was displaced (it was between two polls): it is told on its next one, even with takeover=1
  const third = await done(poll('load-0003')); assert.equal(taker.status, 410); assert.equal(third.writableEnded, false);
  await s.c.advance(25000); assert.equal(third.status, 204);
  const fourth = await done(poll('load-0004')); assert.equal(fourth.writableEnded, false);
  assert.deepEqual((await done(poll('load-0003'))).json, { error: 'PROGRAM_SUPERSEDED' }); assert.equal(fourth.writableEnded, false, 'and the newest window keeps the slot');
  for (const bad of ['a b', 'x'.repeat(41), '<i>']) assert.deepEqual((await done(s.page('GET', 'poll?program=air&inst=' + encodeURIComponent(bad)))).json, { error: 'PROGRAM_INVALID' });
  // a page that sends no inst (an older page) is known by its page id alone, as before
  await done(s.page('POST', 'bye?program=air&inst=load-0004'));
  const old = await done(s.poll('air')), old2 = await done(s.poll('air')); assert.equal(old.status, 204); assert.equal(old2.writableEnded, false);
});

test('status gives numbers within bounds and fixed words only: nothing the program page says reaches a phone as text', async () => {
  const s = setup({ air: () => ({ known: 1, live: 'yes', secret: 'x' }) }), page = programPage(s, 'air');
  const idle = (await done(s.status())).json;
  assert.deepEqual(idle, { version: '1.3.0', serverTime: T0, iceServers: [], program: { online: false, ready: false, throttled: false }, link: { state: 'idle', mine: false, since: T0, echoAgeMs: null, stats: { w: 0, h: 0, fps: 0, kbps: 0, rttMs: 0, lossPct: 0 }, audio: { wanted: false, playing: false, level: 0 }, path: null, lastError: null }, air: { known: true, live: true } });
  await page.pump();
  assert.equal((await done(s.report('air', null, 'loading', { stats: {}, audio: {} }))).status, 200);
  assert.deepEqual((await done(s.status())).json.program, { online: true, ready: false, throttled: false }, '"loading" is not ready, and a page that reports no frame rate is not called throttled');
  const w = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' })); await page.pump();
  assert.equal((await done(s.status({ client: 'client-0001' }))).json.link.state, 'negotiating');
  await done(s.answer('air', 'attempt-0001')); assert.equal(w.status, 201);
  const hostile = { showing: '<b>', hidden: 'no', lastError: 'rm -rf /', secret: 'TOP-SECRET', sdp: OFFER, stats: { w: 1e12, h: -5, fps: 'fast', kbps: 2500.4, rttMs: Infinity, lossPct: 250, rafHz: 144.44, vw: 736, vh: 1319, dpr: 1.25, evil: '<script>alert(1)</script>' }, audio: { wanted: 'true', playing: true, level: 7, sink: '<img src=x onerror=1> CABLE Input (VB-Audio)' }, path: { local: '<script>', remote: 'host', protocol: 'udp' } };
  assert.equal((await done(s.report('air', 'attempt-0001', 'connected', hostile))).status, 200);
  const mine = (await done(s.status({ client: 'client-0001' }))).json;
  assert.deepEqual(mine.link, { state: 'connected', mine: true, since: T0, echoAgeMs: 0, stats: { w: 8192, h: 0, fps: 0, kbps: 2500, rttMs: 0, lossPct: 100 }, audio: { wanted: false, playing: true, level: 1 }, path: null, lastError: null });
  assert.deepEqual(mine.program, { online: true, ready: true, throttled: false });
  for (const text of [JSON.stringify(mine), JSON.stringify(s.view())]) for (const leak of ['TOP-SECRET', 'v=0', 'script', '<', 'rm -rf', KEY]) assert.ok(!text.includes(leak), 'no "' + leak + '" in what others may read');
  assert.ok(!JSON.stringify(mine).includes('attempt-0001'), 'a phone is never shown an attempt id'); assert.ok(!JSON.stringify(mine).includes('CABLE'), 'nor the name of the sound device');
  assert.equal(s.view().link.audio.sink, 'img srcx onerror1 CABLE Input VB-Audio', 'the operator sees it, cut to 40 plain characters'); assert.equal(s.view().program.stats.dpr, 1.25); assert.equal(s.view().link.attempt, 'attempt-');
  // mine: by the client id of the page load, or by naming the attempt
  assert.equal((await done(s.status({ client: 'client-0002' }))).json.link.mine, false);
  assert.equal((await done(s.status({ attempt: 'attempt-0001' }))).json.link.mine, true);
  assert.equal((await done(s.status({ attempt: 'attempt-0002' }))).json.link.mine, false);
  assert.equal((await done(s.status())).json.link.mine, false);
  // the age of the program's last word about this link, and the two "throttled" signs
  await s.c.advance(1500); assert.equal((await done(s.status({ client: 'client-0001' }))).json.link.echoAgeMs, 1500);
  assert.equal((await done(s.report('air', 'attempt-0001', 'connected', { path: { local: 'host', remote: 'relay', protocol: 'tcp' }, stats: { ...GOOD_STATS, rafHz: 4 } }))).status, 200);
  const slow = (await done(s.status({ client: 'client-0001' }))).json; assert.equal(slow.program.throttled, true); assert.deepEqual(slow.link.path, { local: 'host', remote: 'relay', protocol: 'tcp' }); assert.equal(slow.link.echoAgeMs, 0); assert.equal(slow.link.stats.fps, 30);
  assert.equal((await done(s.report('air', 'attempt-0001', 'connected', { hidden: true }))).status, 200); assert.equal((await done(s.status())).json.program.throttled, true);
  assert.equal((await done(s.report('air', 'attempt-0001', 'connected'))).status, 200); assert.equal((await done(s.status())).json.program.throttled, false);
  assert.deepEqual((await done(s.report('air', 'attempt-0001', 'dancing'))).json, { error: 'STATE_INVALID' });
  // a broken air() never breaks the answer
  const broken = setup({ air: () => { throw new Error('boom'); } }); assert.deepEqual((await done(broken.status())).json.air, { known: false, live: false });
});

test('DELETE and /bye stop the link, both idempotent; an unknown or foreign attempt is 404; the program is told once', async () => {
  const s = setup(), page = programPage(s, 'air');
  await connect(s, page, { attempt: 'attempt-0001', client: 'client-0001' }); page.take();
  assert.deepEqual((await done(s.stop('attempt-9999'))).json, { error: 'ATTEMPT_UNKNOWN' });
  const foreign = await done(s.stop('attempt-0001', { session: PHONE_B })); assert.equal(foreign.status, 404); assert.deepEqual(foreign.json, { error: 'ATTEMPT_UNKNOWN' });
  assert.equal(s.view().link.state, 'connected');
  const stopped = await done(s.stop('attempt-0001')); assert.equal(stopped.status, 200); assert.deepEqual(stopped.json, { ok: true });
  await page.pump(); assert.deepEqual(page.take().map(m => ({ ...m, seq: 0 })), [{ seq: 0, type: 'stop', attempt: 'attempt-0001', reason: 'client_stop' }]);
  const view = (await done(s.status({ client: 'client-0001' }))).json.link; assert.equal(view.state, 'idle'); assert.equal(view.mine, false); assert.equal(view.lastError, null);
  assert.deepEqual((await done(s.stop('attempt-0001'))).json, { ok: true }); assert.deepEqual((await done(s.stop('attempt-0001', { bye: true }))).json, { ok: true });
  await page.pump(); assert.deepEqual(page.take(), [], 'no second stop');
  // the pagehide form, and a wrong method
  await connect(s, page, { attempt: 'attempt-0002', client: 'client-0001' }); page.take();
  assert.deepEqual((await done(s.stop('attempt-0002', { bye: true }))).json, { ok: true }); await page.pump(); assert.equal(page.take()[0].reason, 'client_stop');
  assert.equal((await done(s.phone('GET', 'whip/attempt-0002'))).status, 405); assert.equal((await done(s.phone('DELETE', 'whip/attempt-0002/bye'))).status, 405); assert.equal((await done(s.phone('PUT', 'status'))).status, 405);
  // stopping an OLD attempt while a newer one is the link changes nothing (the phone closes the old connection after the swap)
  await connect(s, page, { attempt: 'attempt-0003', client: 'client-0001' }); await connect(s, page, { attempt: 'attempt-0004', client: 'client-0001' }); page.take();
  assert.deepEqual((await done(s.stop('attempt-0003'))).json, { ok: true }); await page.pump(); assert.deepEqual(page.take(), [], 'the program is never told to stop an attempt older than the one it holds');
  assert.equal(s.view().link.state, 'connected');
});

test('the phone\'s own report reaches the program only when camera, microphone or visibility changed; its words are cut to a plain alphabet', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const w = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' })); await page.pump(); page.take();
  // reported while the offer still waits: kept, and handed to the page right after the answer
  assert.deepEqual((await done(s.tell('attempt-0001', { video: 'muted', audio: 'live', visible: true }))).json, { ok: true });
  await page.pump(); assert.deepEqual(page.take(), []);
  await done(s.answer('air', 'attempt-0001')); assert.equal(w.status, 201); await page.pump();
  assert.deepEqual(page.take().map(m => ({ ...m, seq: 0 })), [{ seq: 0, type: 'capture', attempt: 'attempt-0001', video: 'muted', audio: 'live', visible: true }]);
  await done(s.tell('attempt-0001', { video: 'muted', audio: 'live', visible: true, stats: { w: 720, h: 1280, fps: 29.97, kbps: 2400, rttMs: 3.21, codec: 'video/H264', encoder: 'ExternalEncoder (c2.exynos.h264.encoder) <x>', limit: 'cpu', junk: 'x' } }));
  await page.pump(); assert.deepEqual(page.take(), [], 'the same again is not a change');
  assert.deepEqual(s.view().link.capture, { video: 'muted', audio: 'live', visible: true, at: T0, stats: { w: 720, h: 1280, fps: 30, kbps: 2400, rttMs: 3.2, codec: 'video/H264', encoder: 'ExternalEncoder c2.exynos.h264.encoder x', limit: 'cpu' } });
  await done(s.tell('attempt-0001', { video: 'live', audio: 'ended', visible: false, evil: '<script>' })); await page.pump();
  assert.deepEqual(page.take().map(m => [m.type, m.video, m.audio, m.visible]), [['capture', 'live', 'ended', false]]);
  await done(s.tell('attempt-0001', { video: 'exploded', visible: 'maybe' })); await page.pump(); assert.deepEqual(page.take(), [], 'unknown words change nothing');
  // not the current attempt, or not the owner: accepted and ignored
  assert.deepEqual((await done(s.tell('attempt-9999', { video: 'ended' }))).json, { ok: true });
  assert.deepEqual((await done(s.tell('attempt-0001', { video: 'ended' }, { session: PHONE_B }))).json, { ok: true });
  await page.pump(); assert.deepEqual(page.take(), []); assert.equal(s.view().link.capture.video, 'live');
  // a hidden page that flips many times while the program is not polling leaves one message, the latest
  page.open.leave(); page.open = null; await s.c.settle();
  for (let i = 0; i < 30; i++) await done(s.tell('attempt-0001', { visible: i % 2 === 0 }));
  assert.equal(s.view().queue.length, 1); await page.pump(); assert.deepEqual(page.take().map(m => m.visible), [false]);
});

test('soft state: after a gateway restart the hub adopts the link the program page reports, and the phone claims it by naming the attempt', async () => {
  const s = setup(), page = programPage(s, 'air');
  const early = await done(s.report('air', 'attempt-old1', 'connected')); assert.equal(early.status, 409); assert.deepEqual(early.json, { error: 'PROGRAM_BUSY' });
  assert.equal(s.view().link.state, 'idle', 'a page that does not hold the slot (it has not polled yet) reports nothing');
  await page.pump();
  await done(s.report('air', 'attempt-old0', 'answering')); assert.equal(s.view().link.state, 'idle', 'an unfinished negotiation is not adopted');
  assert.equal((await done(s.report('air', 'attempt-old1', 'connected'))).status, 200);
  assert.equal(s.view().link.state, 'connected'); assert.equal(s.view().link.adopted, true); assert.equal(s.logged.at(-1).type, 'adopted');
  const stranger = (await done(s.status({ client: 'client-0009' }))).json.link; assert.equal(stranger.mine, false); assert.equal(stranger.state, 'connected'); assert.equal(stranger.stats.w, 720);
  const owner = (await done(s.status({ client: 'client-0001', attempt: 'attempt-old1' }))).json.link; assert.equal(owner.mine, true);
  assert.equal((await done(s.status({ client: 'client-0001' }))).json.link.mine, true, 'from then on its client id is enough');
  assert.deepEqual((await done(s.whip({ attempt: 'attempt-0002', client: 'client-0009' }))).json, { error: 'LINK_REPLACED' }, 'and another device needs takeover');
  assert.deepEqual((await done(s.stop('attempt-old1', { session: PHONE_B }))).json, { error: 'ATTEMPT_UNKNOWN' });
  assert.deepEqual((await done(s.stop('attempt-old1'))).json, { ok: true }); await page.pump(); assert.deepEqual(page.take().map(m => [m.type, m.attempt, m.reason]), [['stop', 'attempt-old1', 'client_stop']]);
  await done(s.report('air', 'attempt-old1', 'connected')); assert.equal(s.view().link.state, 'idle', 'a stopped link is not adopted back while the page still shows it');
  // an adopted link that nobody claimed does not lock the phone out
  const s2 = setup(), page2 = programPage(s2, 'air'); await page2.pump(); await done(s2.report('air', 'attempt-old2', 'stalled')); assert.equal(s2.view().link.state, 'stalled');
  const w = await done(s2.whip({ attempt: 'attempt-0003', client: 'client-0001' })); assert.equal(w.writableEnded, false);
  await page2.pump(); assert.deepEqual(page2.take().map(m => [m.type, m.attempt]), [['stop', 'attempt-old2'], ['offer', 'attempt-0003']]);
});

test('the link is lost when the page stops holding it, reports it lost, loses the slot or says bye', async () => {
  // a reloaded page reports no attempt: lost, but not from a report that is merely older than the answer
  const s = setup(), page = programPage(s, 'air');
  await page.pump(); const w = await done(s.whip({ attempt: 'attempt-0001', client: 'client-0001' })); await page.pump(); page.take();
  await done(s.report('air', null, 'idle')); assert.equal(s.view().link.state, 'negotiating', 'before the answer the page cannot know the attempt');
  await done(s.answer('air', 'attempt-0001')); assert.equal(w.status, 201);
  await s.c.advance(DISOWN_GRACE_MS - 1); await page.pump(); await done(s.report('air', null, 'idle')); assert.equal(s.view().link.state, 'negotiating');
  await s.c.advance(5000); await page.pump(); await done(s.report('air', 'attempt-0001', 'loading')); assert.equal(s.view().link.state, 'negotiating', 'a page that names the attempt holds it, also while its engine is still loading');
  assert.equal((await done(s.status())).json.program.ready, false);
  await done(s.report('air', 'attempt-0001', 'connected')); assert.equal(s.view().link.state, 'connected');
  await done(s.report('air', null, 'loading'));
  let link = (await done(s.status({ client: 'client-0001', attempt: 'attempt-0001' }))).json.link;
  assert.deepEqual([link.state, link.mine, link.lastError, link.since], ['lost', false, 'STALE_ATTEMPT', s.c.now()]);
  // "lost" from the page means no picture for 3 s: it is shown, but the page still holds the connection and may bring it back
  await connect(s, page, { attempt: 'attempt-0002', client: 'client-0001' }); assert.equal(s.view().link.lastError, null, 'a connected link clears the last error');
  await done(s.report('air', 'attempt-0002', 'stalled')); await done(s.report('air', 'attempt-0002', 'lost'));
  link = (await done(s.status({ client: 'client-0001' }))).json.link; assert.deepEqual([link.state, link.mine, link.lastError], ['lost', true, null]);
  await done(s.report('air', 'attempt-0002', 'connected')); assert.equal(s.view().link.state, 'connected'); assert.deepEqual(s.logged.slice(-3).map(e => e.type), ['stalled', 'lost', 'resumed']);
  // the page gives the link up for a reason from the fixed list, says so for a while, then names no attempt: only then is the link over
  await done(s.report('air', 'attempt-0002', 'lost', { lastError: 'STREAM_REJECTED' })); await done(s.report('air', 'attempt-0002', 'lost', { lastError: 'made up by the page' }));
  link = s.view().link; assert.deepEqual([link.state, link.lastError, link.attempt], ['lost', 'STREAM_REJECTED', 'attempt-']);
  await s.c.advance(DISOWN_GRACE_MS); await page.pump(); await done(s.report('air', null, 'idle'));
  link = (await done(s.status({ client: 'client-0001' }))).json.link; assert.deepEqual([link.state, link.mine, link.lastError], ['lost', false, 'STREAM_REJECTED']);
  await done(s.report('air', null, 'idle')); assert.equal(s.view().link.state, 'lost', 'it stays "lost" until a new attempt or a stop');
  for (const [i, code] of ['SDP_INVALID', 'ANSWER_FAILED', 'CONNECT_TIMEOUT', 'CONNECTION_FAILED'].entries()) { // the page's own reasons are on the list too
    await connect(s, page, { attempt: 'attempt-030' + i, client: 'client-0001' });
    await done(s.report('air', 'attempt-030' + i, 'lost', { lastError: code })); assert.equal(s.view().link.lastError, code); await s.c.advance(7000);
  }
  // the page stops polling: 10 s later the slot is free and the link is lost
  await connect(s, page, { attempt: 'attempt-0003', client: 'client-0001' }); page.take();
  page.open.leave(); page.open = null; await s.c.settle();
  await s.c.advance(LEASE_MS - 1); assert.equal(s.view().link.state, 'connected'); assert.equal(s.view().program.online, false);
  await s.c.advance(1); link = s.view().link; assert.deepEqual([link.state, link.lastError], ['lost', 'PROGRAM_OFFLINE']); assert.equal(s.view().lease, null);
  assert.equal((await done(s.report('air', 'attempt-0003', 'connected'))).status, 409, 'and its reports are refused until it polls again');
  // bye: at once
  const s2 = setup(), page2 = programPage(s2, 'air');
  await connect(s2, page2, { attempt: 'attempt-0004', client: 'client-0001' }); page2.take();
  assert.deepEqual((await done(s2.page('POST', 'bye?program=tab'))).json, { ok: true }); assert.equal(s2.view().program.online, true, 'a bye for another page id changes nothing');
  const bye = await done(s2.page('POST', 'bye?program=air', { headers: { 'x-link-program-key': '' } })); assert.equal(bye.status, 200, 'no key is needed for bye (sendBeacon cannot send one)');
  assert.equal(page2.open.status, 204); assert.equal(s2.view().program.online, false); assert.equal(s2.view().lease, null);
  assert.deepEqual([s2.view().link.state, s2.view().link.lastError], ['lost', 'PROGRAM_OFFLINE']);
  assert.deepEqual((await done(s2.whip({ attempt: 'attempt-0005', client: 'client-0001' }))).json, { error: 'PROGRAM_OFFLINE' });
  // takeover by another page: the link the old page held is lost too, and the waiting offer goes to the new page
  const s3 = setup(), old = programPage(s3, 'air'), fresh = programPage(s3, 'tab', { takeover: 1 });
  await connect(s3, old, { attempt: 'attempt-0006', client: 'client-0001' });
  await fresh.pump(); assert.deepEqual(old.open.json, { error: 'PROGRAM_SUPERSEDED' }); assert.deepEqual([s3.view().link.state, s3.view().link.lastError], ['lost', 'PROGRAM_SUPERSEDED']);
  const w3 = await done(s3.whip({ attempt: 'attempt-0007', client: 'client-0001' })); await fresh.pump();
  assert.deepEqual(fresh.take().map(m => [m.type, m.attempt]), [['offer', 'attempt-0007']], 'the new page is not told about the old page\'s connections');
  assert.equal((await done(s3.answer('tab', 'attempt-0007'))).status, 200); assert.equal(w3.status, 201);
});

test('a waiting offer survives a page reload with bye: the next page gets it and can still answer', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const w = await done(s.whip({ attempt: 'attempt-0001' })); await page.pump(); page.take();
  await done(s.page('POST', 'bye?program=air')); assert.equal(w.writableEnded, false, 'the phone keeps waiting');
  await s.c.advance(2000);
  const reborn = programPage(s, 'air'); await reborn.pump(); assert.deepEqual(reborn.take().map(m => [m.type, m.attempt]), [['offer', 'attempt-0001']]);
  assert.equal((await done(s.answer('air', 'attempt-0001'))).status, 200); assert.equal(w.status, 201);
});

test('close() answers every waiting request and clears every timer', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  const w = await done(s.whip({ attempt: 'attempt-0001' })); await page.pump(); page.take();
  assert.equal(s.c.pending, 2, 'one parked poll and one waiting phone');
  s.hub.close(); s.hub.close();
  assert.equal(page.open.status, 204); assert.equal(page.open.headers.connection, 'close');
  assert.equal(w.status, 503); assert.deepEqual(w.json, { error: 'PROGRAM_OFFLINE' }); assert.equal(w.headers.connection, 'close');
  assert.equal(s.c.pending, 0); assert.equal(s.view().program.online, false); assert.equal(s.view().link.state, 'idle');
  assert.deepEqual(s.logged.at(-1).detail, { released: 2 });
  for (const r of [s.status(), s.whip({ attempt: 'attempt-0002' }), s.poll('air'), s.answer('air', 'attempt-0001')]) { await r.handled; assert.equal(r.status, 503); assert.deepEqual(r.json, { error: 'LINK_CLOSED' }); assert.equal(r.headers.connection, 'close'); }
  assert.equal(s.c.pending, 0);
  const quiet = setup(); quiet.hub.close(); assert.deepEqual(quiet.logged, [], 'closing an idle hub writes nothing');
});

test('phone routes need a paired session (or the local computer with LINK_DEV=1) and refuse foreign origins before reading anything', async () => {
  const s = setup(), dev = setup({ env: { LINK_DEV: '1' } });
  for (const [method, route] of [['GET', 'status'], ['POST', 'whip'], ['POST', 'state'], ['DELETE', 'whip/attempt-0001'], ['POST', 'whip/attempt-0001/bye']]) {
    const remote = await done(send(s.hub, method, '/api/link/' + route, { body: OFFER, headers: { 'content-type': 'application/sdp' } }));
    assert.equal(remote.status, 401, method + ' ' + route); assert.deepEqual(remote.json, { error: 'PAIRING_REQUIRED' }); assert.equal(remote.req.readableFlowing, null, 'the body was not read');
    assert.equal((await done(send(s.hub, method, '/api/link/' + route, { local: true, headers: { host: '127.0.0.1:8801' } }))).status, 401, 'the local computer is not a phone without LINK_DEV');
  }
  assert.equal((await done(send(dev.hub, 'GET', '/api/link/status', { local: true, headers: { host: '127.0.0.1:8801' } }))).status, 200);
  assert.equal((await done(send(dev.hub, 'GET', '/api/link/status'))).status, 401, 'LINK_DEV opens nothing for a remote caller');
  assert.equal((await done(s.status())).status, 200);
  // origins: the gateway's own rule, applied here because these routes are answered before it
  const post = headers => s.phone('POST', 'whip', { body: OFFER, headers: { 'content-type': 'application/sdp', ...headers } });
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'http://phone.example:81' }, { 'sec-fetch-site': 'cross-site' }, { origin: ORIGIN }, { origin: 'http://localhost:8800' }]) {
    const r = await done(post(headers)); assert.equal(r.status, 403, JSON.stringify(headers)); assert.deepEqual(r.json, { error: 'ORIGIN_REJECTED' }); assert.equal(r.req.readableFlowing, null);
  }
  assert.equal((await done(post({ origin: 'http://phone.example' }))).status, 503, 'its own origin passes (and then there is no program)');
  assert.equal((await done(s.stop('attempt-0001'))).status, 404); assert.equal((await done(s.phone('DELETE', 'whip/attempt-0001', { headers: { origin: 'https://evil.example' } }))).status, 403);
  const tunnel = setup({ publicUrl: () => 'https://studio.example' });
  assert.equal((await done(tunnel.phone('POST', 'whip', { body: OFFER, headers: { 'content-type': 'application/sdp', host: '127.0.0.1:8801', origin: 'https://studio.example' } }))).status, 503, 'the public address of the gateway is its own origin too');
  // the program page's origin may not act as a phone, not even to read
  for (const origin of [ORIGIN, 'http://localhost:8800']) { const r = await done(s.phone('GET', 'status', { headers: { origin } })); assert.equal(r.status, 403); assert.deepEqual(r.json, { error: 'ORIGIN_REJECTED' }); }
  assert.equal((await done(s.phone('GET', 'status', { headers: { origin: 'https://evil.example' } }))).status, 200, 'a GET is not origin-checked, as everywhere in the gateway, and carries no CORS header');
  for (const r of [await done(s.status()), await done(post({ origin: 'https://evil.example' }))]) assert.equal(Object.keys(r.headers).some(k => k.startsWith('access-control-')), false);
  // not ours: OPTIONS (the gateway answers 405) and unknown paths
  for (const [method, route] of [['OPTIONS', '/api/link/status'], ['OPTIONS', '/api/link/whip'], ['OPTIONS', '/api/link/ops'], ['GET', '/api/link/nothing'], ['GET', '/api/link/whip/x'], ['GET', '/api/mobile/session'], ['GET', '/api/link/']]) {
    const r = send(s.hub, method, route, { paired: PHONE_A, headers: { origin: ORIGIN } }); assert.equal(await r.handled, false, method + ' ' + route); assert.equal(r.headersSent, false);
  }
});

test('program routes need a local request, the program page\'s exact origin and the key; CORS exists for that origin only', async () => {
  const s = setup();
  const poll = (headers, extra = {}) => send(s.hub, 'GET', '/api/link/program/poll?program=air', { local: true, ...extra, headers: { host: '127.0.0.1:8801', origin: ORIGIN, 'x-link-program-key': KEY, ...headers } });
  const forwarded = await done(poll({}, { local: false })); assert.equal(forwarded.status, 403); assert.deepEqual(forwarded.json, { error: 'LOCAL_SETUP_ONLY' }); assert.equal(forwarded.headers['access-control-allow-origin'], undefined);
  for (const origin of [undefined, 'https://evil.example', 'http://127.0.0.1:8801', 'http://127.0.0.1:88000', 'https://127.0.0.1:8800', 'http://127.0.0.1:8800/', 'null']) {
    const r = await done(poll({ origin })); assert.equal(r.status, 403, String(origin)); assert.deepEqual(r.json, { error: 'PROGRAM_ORIGIN_REQUIRED' }); assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  for (const key of [undefined, '', 'wrong', KEY.slice(0, -1), KEY + 'x', KEY.replace('u', 'U'), 'x'.repeat(KEY.length)]) {
    const r = await done(poll({ 'x-link-program-key': key })); assert.equal(r.status, 403, String(key)); assert.deepEqual(r.json, { error: 'PROGRAM_KEY_REQUIRED' });
    assert.equal(r.headers['access-control-allow-origin'], ORIGIN, 'the page can read why'); assert.equal(r.headers.vary, 'Origin');
  }
  assert.equal(s.view().lease, null, 'none of them touched the slot');
  for (const origin of [ORIGIN, 'http://localhost:8800']) {
    const ok = await done(poll({ origin })); assert.equal(ok.writableEnded, false);
    const st = await done(s.page('POST', 'state', { headers: { origin }, json: { program: 'air', attempt: null, state: 'idle' } }));
    assert.equal(st.status, 200); assert.equal(st.headers['access-control-allow-origin'], origin); assert.equal(st.headers.vary, 'Origin'); assert.equal(st.headers['access-control-allow-credentials'], undefined);
  }
  await s.c.advance(25000);
  assert.equal(s.view().lease.pageId, 'air');
  // preflight: 204 for the two origins from this computer, otherwise not ours (the gateway's 405)
  for (const origin of [ORIGIN, 'http://localhost:8800']) {
    const pre = await done(send(s.hub, 'OPTIONS', '/api/link/program/answer', { local: true, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-link-program-key' } }));
    assert.equal(pre.status, 204); assert.equal(pre.text, '');
    assert.deepEqual(pre.headers, { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'Content-Type, X-Link-Program-Key', 'access-control-max-age': '600' });
  }
  for (const [origin, local] of [['https://evil.example', true], [undefined, true], [ORIGIN, false]]) { const r = send(s.hub, 'OPTIONS', '/api/link/program/poll', { local, headers: { origin } }); assert.equal(await r.handled, false); assert.equal(r.headersSent, false); }
  // unknown program route and wrong method, after the checks
  assert.deepEqual((await done(s.page('GET', 'nothing'))).json, { error: 'NOT_FOUND' }); assert.equal((await done(s.page('POST', 'poll?program=air'))).status, 405); assert.equal((await done(s.page('GET', 'bye?program=air'))).status, 405);
  assert.deepEqual((await done(s.page('GET', 'bye?program=air', { headers: { 'x-link-program-key': '' } }))).json, { error: 'PROGRAM_KEY_REQUIRED' }, 'only POST bye is exempt from the key');
  // LINK_DEV: no key, but still local and still the origin
  const dev = setup({ env: { LINK_DEV: '1' }, programKey: undefined });
  const open = await done(send(dev.hub, 'GET', '/api/link/program/poll?program=air', { local: true, headers: { origin: ORIGIN } })); assert.equal(open.writableEnded, false);
  assert.deepEqual((await done(send(dev.hub, 'GET', '/api/link/program/poll?program=air', { local: true }))).json, { error: 'PROGRAM_ORIGIN_REQUIRED' });
  assert.deepEqual((await done(send(dev.hub, 'GET', '/api/link/program/poll?program=air', { headers: { origin: ORIGIN } }))).json, { error: 'LOCAL_SETUP_ONLY' });
  // no key configured, or a toy one, and not dev: nobody passes
  for (const programKey of [undefined, '', 'short']) {
    const shut = createCamLink({ upstreamPort: 8800, programKey });
    assert.deepEqual((await done(send(shut, 'GET', '/api/link/program/poll?program=air', { local: true, headers: { origin: ORIGIN, 'x-link-program-key': programKey ?? '' } }))).json, { error: 'PROGRAM_KEY_REQUIRED' });
  }
  // the operator's view: this computer only
  assert.deepEqual((await done(send(s.hub, 'GET', '/api/link/ops', { paired: PHONE_A }))).json, { error: 'LOCAL_SETUP_ONLY' });
  const ops = await done(send(s.hub, 'GET', '/api/link/ops', { local: true })); assert.equal(ops.status, 200); assert.equal(ops.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(Object.keys(ops.json).sort(), ['air', 'build', 'dev', 'events', 'iceServers', 'lease', 'link', 'program', 'queue', 'serverTime', 'version']);
  assert.deepEqual(ops.json.build, { version: '1.3.0', root: 'X:/unit-test-root', startedAt: T0 }); assert.equal(ops.json.dev, false);
  assert.equal((await done(send(s.hub, 'POST', '/api/link/ops', { local: true }))).status, 405);
});

test('bodies: the right type, within the cap, and never read before the caller is known', async () => {
  const s = setup(), page = programPage(s, 'air'); await page.pump();
  assert.deepEqual((await done(s.whip({ headers: { 'content-type': 'application/json' } }))).json, { error: 'SDP_REQUIRED' });
  const declared = await done(s.whip({ headers: { 'content-length': '70000' } })); assert.equal(declared.status, 413); assert.deepEqual(declared.json, { error: 'BODY_TOO_LARGE' }); assert.equal(declared.req.readableFlowing, null, 'refused from its declared length alone');
  const streamed = await done(s.whip({ sdp: 'v=0\r\n' + 'a=x:' + 'y'.repeat(100) + '\r\n'.repeat(1) + 'z'.repeat(70000) })); assert.equal(streamed.status, 413); assert.deepEqual(streamed.json, { error: 'BODY_TOO_LARGE' });
  for (const bad of ['', 'hello', 'v=1' + OFFER.slice(3), OFFER.slice(0, 150), OFFER + 'm=audio 9 X 0\r\n'.repeat(3), OFFER + 'a=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n'.repeat(41), 'v=0\r\n' + 'a=fill:' + 'x'.repeat(60000)]) assert.deepEqual((await done(s.whip({ sdp: bad }))).json, { error: 'SDP_INVALID' });
  assert.equal(validSdp(OFFER + 'm=audio 9 X 0\r\n'.repeat(2) + 'a=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n'.repeat(40)), true, '3 media sections and 40 candidates are the limit, inclusive');
  assert.equal(validSdp('v=0\r\n' + 'a=fill:' + 'x'.repeat(59980)), true); assert.equal(validSdp(null), false); assert.equal(validSdp({ length: 300 }), false);
  await page.pump(); assert.deepEqual(page.take(), [], 'no refused offer reached the page');
  // JSON routes
  assert.deepEqual((await done(s.phone('POST', 'state', { body: '{}', headers: { 'content-type': 'text/plain' } }))).json, { error: 'JSON_REQUIRED' });
  assert.deepEqual((await done(s.phone('POST', 'state', { body: '{broken', headers: { 'content-type': 'application/json' } }))).json, { error: 'INVALID_JSON' });
  assert.deepEqual((await done(s.phone('POST', 'state', { body: '[1,2]', headers: { 'content-type': 'application/json; charset=utf-8' } }))).json, { error: 'INVALID_JSON' });
  const fat = await done(s.tell('attempt-0001', { pad: 'x'.repeat(2100) })); assert.equal(fat.status, 413); assert.deepEqual(fat.json, { error: 'BODY_TOO_LARGE' });
  assert.deepEqual((await done(s.page('POST', 'state', { json: { program: 'air', attempt: null, state: 'idle', pad: 'x'.repeat(2100) } }))).json, { error: 'BODY_TOO_LARGE' });
  assert.deepEqual((await done(s.page('POST', 'state', { body: 'x', headers: { 'content-type': 'application/sdp' } }))).json, { error: 'JSON_REQUIRED' });
  assert.deepEqual((await done(s.page('POST', 'answer', { json: { program: 'air', attempt: 'attempt-0001', sdp: 'v=0\r\n' + 'x'.repeat(70000) } }))).json, { error: 'BODY_TOO_LARGE' });
  const big = 'v=0\r\n' + 'a=fill:' + 'x'.repeat(50000);
  const w = await done(s.whip({ attempt: 'attempt-0001', sdp: big })); await page.pump(); assert.equal(page.take()[0].sdp, big, 'a 50 KB offer goes through whole');
  assert.equal((await done(s.answer('air', 'attempt-0001', big))).status, 200); assert.equal(w.text, big, 'and so does a 50 KB answer');
  // a program request is checked before its body is read
  const unread = await done(s.page('POST', 'answer', { json: { program: 'air', attempt: 'attempt-0001', sdp: ANSWER }, headers: { 'x-link-program-key': 'wrong' } })); assert.equal(unread.status, 403); assert.equal(unread.req.readableFlowing, null);
});

test('LINK_ICE_SERVERS: a valid list is handed to both sides, anything else is an empty list and one log line', async () => {
  assert.deepEqual(parseIceServers(undefined), { iceServers: [], invalid: false }); assert.deepEqual(parseIceServers(''), { iceServers: [], invalid: false }); assert.deepEqual(parseIceServers('  '), { iceServers: [], invalid: false }); assert.deepEqual(parseIceServers('[]'), { iceServers: [], invalid: false });
  assert.deepEqual(parseIceServers('[{"urls":"stun:stun.example.org:3478"},{"urls":["turn:turn.example.org:3478?transport=udp","turns:turn.example.org:5349?transport=tcp"],"username":"u","credential":"c","extra":1}]'),
    { iceServers: [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349?transport=tcp'], username: 'u', credential: 'c' }], invalid: false });
  for (const bad of ['not json', '{}', '"stun:x"', '[1]', '[null]', '[{}]', '[{"urls":[]}]', '[{"urls":"http://evil.example"}]', '[{"urls":"stun:EXAMPLE.org"}]', '[{"urls":"stun:a.example:123456"}]', '[{"urls":"turn:a.example?transport=sctp"}]', '[{"urls":"stun:a.example javascript:alert(1)"}]', '[{"urls":["stun:a.example",5]}]', '[{"urls":"stun:a.example","username":5}]', '[{"urls":"stun:a.example"},{"urls":"x"}]', JSON.stringify(Array(9).fill({ urls: 'stun:a.example' }))])
    assert.deepEqual(parseIceServers(bad), { iceServers: [], invalid: true }, bad);
  const list = '[{"urls":"stun:stun.example.org:3478"}]', s = setup({ env: { LINK_ICE_SERVERS: list } }), page = programPage(s, 'air'); await page.pump();
  assert.deepEqual((await done(s.status())).json.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
  await done(s.whip({ attempt: 'attempt-0001' })); await page.pump(); assert.deepEqual(page.take()[0].iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
  assert.deepEqual(s.logged.filter(e => e.type === 'ice_servers_invalid'), []);
  const broken = setup({ env: { LINK_ICE_SERVERS: '[{"urls":"http://secret-host.example/turn"}]' } });
  assert.deepEqual((await done(broken.status())).json.iceServers, []); assert.deepEqual(broken.logged, [{ at: T0, type: 'ice_servers_invalid', detail: {} }], 'one line, without the value');
});

test('the hub remembers its last 50 events, and no event carries an SDP, a key or an address', async () => {
  const s = setup(), page = programPage(s, 'air');
  for (let i = 0; i < 15; i++) { await connect(s, page, { attempt: 'attempt-10' + String(i).padStart(2, '0'), client: 'client-0001' }); await done(s.stop('attempt-10' + String(i).padStart(2, '0'))); await s.c.advance(7000); }
  assert.ok(s.logged.length > EVENTS_MAX); assert.equal(s.view().events.length, EVENTS_MAX); assert.deepEqual(s.view().events, s.logged.slice(-EVENTS_MAX), 'the ring holds exactly the newest of what was logged');
  for (const event of s.logged) { assert.deepEqual(Object.keys(event), ['at', 'type', 'detail']); assert.equal(typeof event.at, 'number'); const line = JSON.stringify(event); for (const leak of ['v=0', 'the-offer', 'the-answer', KEY, '127.0.0.1', 'phone-a']) assert.ok(!line.includes(leak), line); assert.ok(line.length < 200, line); }
  assert.deepEqual([...new Set(s.logged.map(e => e.type))].sort(), ['answer', 'connected', 'offer', 'program_lease', 'stop']);
  assert.deepEqual(s.logged.find(e => e.type === 'offer').detail, { attempt: 'attempt-', client: 'Test phone', takeover: false }, 'an attempt is named by its first 8 characters only');
  const noisy = setup({ log: () => { throw new Error('disk full'); } }); assert.equal((await done(noisy.poll('air'))).writableEnded, false, 'a broken log never breaks the link');
});

test('the queue for the program never grows past 20 messages', async () => {
  const s = setup();
  for (let i = 0; i < 26; i++) {
    const id = 'attempt-20' + String(i).padStart(2, '0');
    await done(s.poll('air', 0)); // a page that never acknowledges anything
    const w = await done(s.whip({ attempt: id, client: 'client-0001' })); assert.equal(w.writableEnded, false, id);
    assert.equal((await done(s.answer('air', id))).status, 200); assert.equal((await done(s.stop(id))).status, 200);
    await s.c.advance(6500);
  }
  assert.equal(s.view().queue.length, QUEUE_MAX); assert.ok(s.logged.some(e => e.type === 'queue_overflow'));
  const oldest = await done(s.poll('air', 0)); assert.equal(oldest.json.type, 'stop'); assert.equal(oldest.json.attempt, 'attempt-2006', 'the oldest ones were dropped');
});

test('the program key: LINK_PROGRAM_KEY wins; otherwise 24 random bytes are kept in runtime/link-program.key and reused; link.log gets one JSON line per event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanna-link-key-')), file = path.join(root, 'runtime', 'link-program.key');
  try {
    assert.equal(linkProgramKey({ env: { LINK_PROGRAM_KEY: '  from-the-environment-0123456789  ' }, root }), 'from-the-environment-0123456789'); assert.equal(fs.existsSync(file), false, 'no file when the key comes from the environment');
    const made = linkProgramKey({ env: {}, root }); assert.match(made, /^[0-9a-f]{48}$/); assert.equal(fs.readFileSync(file, 'utf8'), made);
    assert.equal(linkProgramKey({ env: { LINK_PROGRAM_KEY: '' }, root }), made, 'a restart keeps the key, so an open program page stays valid');
    fs.writeFileSync(file, 'garbage'); const fresh = linkProgramKey({ root }); assert.match(fresh, /^[0-9a-f]{48}$/); assert.notEqual(fresh, made); assert.equal(fs.readFileSync(file, 'utf8'), fresh);
    const write = linkFileLog(root); write({ at: 1, type: 'one', detail: {} }); write({ at: 2, type: 'two', detail: { n: 2 } });
    assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'link.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse), [{ at: 1, type: 'one', detail: {} }, { at: 2, type: 'two', detail: { n: 2 } }]);
    const small = linkFileLog(root, { maxBytes: 10 }); small({ at: 3, type: 'three', detail: {} });
    assert.equal(fs.readFileSync(path.join(root, 'runtime', 'link.log'), 'utf8'), '{"at":3,"type":"three","detail":{}}\n', 'a full file is set aside once'); assert.ok(fs.existsSync(path.join(root, 'runtime', 'link.log.1')));
    // the gateway's way of building the hub: this root's key and log, and the key is in nothing the hub shows
    const hub = createGatewayCamLink({ env: {}, root, upstreamPort: 8800, version: '1.3.0' });
    const poll = key => send(hub, 'GET', '/api/link/program/poll?program=air', { local: true, headers: { origin: ORIGIN, 'x-link-program-key': key } });
    assert.deepEqual((await done(poll(made))).json, { error: 'PROGRAM_KEY_REQUIRED' }); const parked = await done(poll(fresh)); assert.equal(parked.writableEnded, false);
    assert.ok(!JSON.stringify(hub.snapshot()).includes(fresh)); hub.close(); assert.equal(parked.status, 204);
    const log = fs.readFileSync(path.join(root, 'runtime', 'link.log'), 'utf8'); assert.match(log, /"type":"program_lease"/); assert.ok(!log.includes(fresh));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- part 2: through the gateway, over HTTP ---------

const REMOTE = { host: 'phone.example', 'cf-connecting-ip': '203.0.113.5' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const { port } = probe.address(); await new Promise(r => probe.close(r)); return port; }
// one HTTP request; .done resolves with the answer, .req lets a test walk away from it
function request(port, route, { method = 'GET', headers = {}, body, json, chunked = false, agent } = {}) {
  const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : body === undefined ? null : Buffer.from(body);
  let req;
  const answered = new Promise((resolve, reject) => {
    req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent, headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(payload && !chunked ? { 'Content-Length': payload.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let parsed; try { parsed = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json: parsed }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  return { done: answered, req };
}
// a gateway on a temp workspace root with a pretend studio server behind it (only /health is ever asked)
async function gateway(t, { env = {}, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanna-link-'));
  const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ liveEffects: 0, templates: 0 })); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const port = await freePort(), upstreamPort = upstream.address().port;
  const app = createMobileGateway({ port, upstreamPort, workspaceRoot: root, clientKey: 'private-client-test', apiKey: 'private-api-test', env, workspaceOptions: { tools: { ffmpeg: 'not-used', installed: false } }, ...options });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  const seen = [];
  const g = { app, root, port, upstreamPort, seen, origin: 'http://127.0.0.1:' + upstreamPort, own: 'http://127.0.0.1:' + port };
  g.open = (route, o) => { const r = request(port, route, o); r.done = r.done.then(answer => { seen.push(answer); return answer; }); return r; };
  g.call = (route, o) => g.open(route, o).done;
  g.key = () => fs.readFileSync(path.join(root, 'runtime', 'link-program.key'), 'utf8');
  g.program = (route, o = {}) => g.open('/api/link/program/' + route, { ...o, headers: { origin: g.origin, 'x-link-program-key': o.key ?? g.key(), ...o.headers } });
  g.pair = async (label = 'Test phone') => {
    const issued = (await g.call('/api/mobile/pairing-code', { method: 'POST' })).json;
    const paired = await g.call('/api/mobile/pair', { method: 'POST', json: { code: issued.code, label }, headers: REMOTE }); assert.equal(paired.status, 200);
    return { ...REMOTE, cookie: paired.headers['set-cookie'][0].split(';')[0] };
  };
  g.ops = async () => (await request(port, '/api/link/ops').done).json;
  g.until = async (check, what) => { for (let i = 0; i < 500; i++) { if (check(await g.ops())) return; await sleep(10); } assert.fail('never happened: ' + what); };
  g.parked = () => g.until(o => o.program.parked === true, 'a parked poll'); // instead of sleeping and hoping the poll has arrived
  g.log = () => { try { return fs.readFileSync(path.join(root, 'runtime', 'link.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  g.close = () => new Promise(r => app.server.close(r));
  t.after(async () => { await g.close(); await new Promise(r => upstream.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  return g;
}

test('over HTTP: who may call what, and CORS for the program page only', async t => {
  const g = await gateway(t, { linkOptions: { pollMs: 120 } }), key = g.key(); assert.match(key, /^[0-9a-f]{48}$/);
  // phone routes
  for (const [method, route] of [['GET', '/api/link/status'], ['POST', '/api/link/whip'], ['POST', '/api/link/state'], ['DELETE', '/api/link/whip/attempt-0001'], ['POST', '/api/link/whip/attempt-0001/bye']]) {
    const remote = await g.call(route, { method, headers: { ...REMOTE, 'content-type': 'application/sdp' }, body: method === 'GET' || method === 'DELETE' ? undefined : OFFER });
    assert.equal(remote.status, 401, method + ' ' + route); assert.deepEqual(remote.json, { error: 'PAIRING_REQUIRED' });
    const local = await g.call(route, { method }); assert.equal(local.status, 401, 'the local computer without LINK_DEV: ' + method + ' ' + route); assert.deepEqual(local.json, { error: 'PAIRING_REQUIRED' });
  }
  const phone = await g.pair();
  const status = await g.call('/api/link/status', { headers: phone }); assert.equal(status.status, 200); assert.equal(status.json.version, '1.3.0'); assert.equal(status.json.link.state, 'idle'); assert.equal(status.headers['cache-control'], 'no-store');
  assert.deepEqual((await g.call('/api/link/whip', { method: 'POST', headers: { ...phone, 'content-type': 'application/sdp', origin: 'https://evil.example' }, body: OFFER })).json, { error: 'ORIGIN_REJECTED' });
  assert.deepEqual((await g.call('/api/link/status', { headers: { ...phone, origin: g.origin } })).json, { error: 'ORIGIN_REJECTED' }, 'the program page\'s origin is not a phone');
  assert.deepEqual((await g.call('/api/link/whip', { method: 'POST', headers: { ...phone, 'content-type': 'application/sdp', origin: 'https://phone.example' }, body: OFFER })).json, { error: 'PROGRAM_OFFLINE' }, 'its own origin is accepted');
  // program routes
  const poll = '/api/link/program/poll?program=air';
  for (const [headers, code] of [
    [{ origin: g.origin, 'x-link-program-key': key, 'x-forwarded-for': '203.0.113.9' }, 'LOCAL_SETUP_ONLY'], [{ origin: g.origin, 'x-link-program-key': key, 'cf-connecting-ip': '203.0.113.9' }, 'LOCAL_SETUP_ONLY'],
    [{ origin: g.origin, 'x-link-program-key': key, host: 'evil.example' }, 'LOCAL_SETUP_ONLY'], [{ origin: g.origin, 'x-link-program-key': key, host: '127.0.0.1:' + g.upstreamPort }, 'LOCAL_SETUP_ONLY'],
    [{ ...phone, origin: g.origin, 'x-link-program-key': key }, 'LOCAL_SETUP_ONLY'],
    [{ 'x-link-program-key': key }, 'PROGRAM_ORIGIN_REQUIRED'], [{ origin: 'https://evil.example', 'x-link-program-key': key }, 'PROGRAM_ORIGIN_REQUIRED'], [{ origin: g.own, 'x-link-program-key': key }, 'PROGRAM_ORIGIN_REQUIRED'],
    [{ origin: g.origin }, 'PROGRAM_KEY_REQUIRED'], [{ origin: g.origin, 'x-link-program-key': 'x'.repeat(48) }, 'PROGRAM_KEY_REQUIRED'], [{ origin: g.origin, 'x-link-program-key': key + '0' }, 'PROGRAM_KEY_REQUIRED'],
  ]) {
    const r = await g.call(poll, { headers }); assert.equal(r.status, 403, JSON.stringify(headers).replace(key, '<key>')); assert.deepEqual(r.json, { error: code });
    assert.equal(r.headers['access-control-allow-origin'], code === 'PROGRAM_KEY_REQUIRED' ? g.origin : undefined);
  }
  assert.equal((await g.call('/api/link/ops')).json.lease, null, 'no refused request took the slot');
  for (const origin of [g.origin, 'http://localhost:' + g.upstreamPort]) {
    const ok = await g.call(poll, { headers: { origin, 'x-link-program-key': key } });
    assert.equal(ok.status, 204); assert.equal(ok.headers['access-control-allow-origin'], origin); assert.equal(ok.headers.vary, 'Origin'); assert.equal(ok.headers['access-control-allow-credentials'], undefined);
    const viaLocalhost = await g.call(poll, { headers: { origin, 'x-link-program-key': key, host: 'localhost:' + g.port } }); assert.equal(viaLocalhost.status, 204);
  }
  // preflight
  for (const origin of [g.origin, 'http://localhost:' + g.upstreamPort]) {
    const pre = await g.call('/api/link/program/answer', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-link-program-key' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers['access-control-allow-origin'], origin); assert.equal(pre.headers['access-control-allow-methods'], 'GET, POST');
    assert.equal(pre.headers['access-control-allow-headers'], 'Content-Type, X-Link-Program-Key'); assert.equal(pre.headers['access-control-max-age'], '600'); assert.equal(pre.headers.vary, 'Origin'); assert.equal(pre.headers['access-control-allow-credentials'], undefined);
  }
  for (const [route, headers] of [['/api/link/program/poll', { origin: 'https://evil.example' }], ['/api/link/program/poll', {}], ['/api/link/program/poll', { origin: g.origin, 'x-forwarded-for': '203.0.113.9' }], ['/api/link/status', { origin: g.origin }], ['/api/link/whip', { origin: g.origin }], ['/api/link/ops', { origin: g.origin }], ['/api/mobile/session', { origin: g.origin }], ['/api/workspace/overview', { origin: g.origin }], ['/cam/', { origin: g.origin }], ['/mobile/', { origin: g.origin }]]) {
    const r = await g.call(route, { method: 'OPTIONS', headers }); assert.equal(r.status, 405, 'OPTIONS ' + route + ' ' + JSON.stringify(headers)); assert.equal(Object.keys(r.headers).some(k => k.startsWith('access-control-')), false);
  }
  // no other route gains a CORS header, whatever origin asks
  for (const route of ['/api/mobile/session', '/api/link/ops', '/api/link/status', '/mobile/', '/cam/', '/api/workspace/overview', '/api/nothing']) {
    const r = await g.call(route, { headers: { origin: g.origin } }); assert.equal(Object.keys(r.headers).some(k => k.startsWith('access-control-')), false, route);
  }
  assert.deepEqual((await g.call('/api/mobile/pair', { method: 'POST', json: { code: '00000000' }, headers: { ...REMOTE, origin: 'https://evil.example' } })).json, { error: 'ORIGIN_REJECTED' }, 'the gateway\'s own origin rule is where it was');
  assert.equal((await g.call('/api/link/nothing', { headers: REMOTE })).status, 401); assert.equal((await g.call('/api/link/nothing')).status, 404);
  // the operator's view
  assert.deepEqual((await g.call('/api/link/ops', { headers: phone })).json, { error: 'LOCAL_SETUP_ONLY' });
  const ops = await g.call('/api/link/ops'); assert.equal(ops.status, 200); assert.deepEqual(Object.keys(ops.json.build).sort(), ['root', 'startedAt', 'version']); assert.equal(ops.json.build.root, g.root); assert.equal(ops.json.build.version, '1.3.0');
  assert.equal(ops.json.lease.pageId, 'air'); assert.ok(ops.json.events.length >= 1); assert.deepEqual(ops.json.air, { known: false, live: false });
  // the session payload carries the same build identity, and the version moved in every place
  const session = (await g.call('/api/mobile/session')).json; assert.equal(session.version, '1.3.0'); assert.deepEqual(session.build, { root: g.root, startedAt: ops.json.build.startedAt });
  assert.equal((await g.call('/api/workspace/config')).json.version, '1.3.0'); assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, '1.3.0');
  // air: only what the TikTok event connection really knows
  g.app.workspace.live.state.status = 'connected'; assert.deepEqual((await g.call('/api/link/status', { headers: phone })).json.air, { known: true, live: true });
  g.app.workspace.live.state.status = 'ended'; assert.deepEqual((await g.call('/api/link/status', { headers: phone })).json.air, { known: true, live: false });
  g.app.workspace.live.state.status = 'error'; assert.deepEqual((await g.call('/api/link/status', { headers: phone })).json.air, { known: false, live: false });
  g.app.workspace.live.state.status = 'disconnected';
  for (const answer of g.seen) assert.ok(!(answer.text + JSON.stringify(answer.headers)).includes(key), 'the program key is in no answer');
});

test('over HTTP: a paired phone offers, the program page answers, both see the link, the phone stops', async t => {
  const g = await gateway(t), key = g.key(), phone = await g.pair('Galaxy');
  const client = 'c1c1c1c1-0000-4000-8000-000000000001', attempt = 'a1a1a1a1-0000-4000-8000-000000000001';
  const first = g.program('poll?program=air&after=0&takeover=1');
  await g.parked(); assert.equal((await g.call('/api/link/status', { headers: phone })).json.program.online, true);
  const whip = g.open('/api/link/whip', { method: 'POST', body: OFFER, headers: { ...phone, 'content-type': 'application/sdp', 'x-link-client': client, 'x-link-attempt': attempt, origin: 'https://phone.example', 'sec-fetch-site': 'same-origin' } });
  const offer = await first.done; assert.equal(offer.status, 200); assert.equal(offer.headers['access-control-allow-origin'], g.origin);
  assert.deepEqual({ ...offer.json, seq: 0 }, { seq: 0, type: 'offer', attempt, sdp: OFFER, iceServers: [], client: { label: 'Galaxy' } });
  const parked = g.program('poll?program=air&after=' + offer.json.seq);
  assert.equal((await g.call('/api/link/status?attempt=' + attempt, { headers: { ...phone, 'x-link-client': client } })).json.link.state, 'negotiating');
  const answered = await g.program('answer', { method: 'POST', json: { program: 'air', attempt, sdp: ANSWER } }).done; assert.equal(answered.status, 200); assert.deepEqual(answered.json, { ok: true });
  const created = await whip.done; assert.equal(created.status, 201); assert.equal(created.headers['content-type'], 'application/sdp'); assert.equal(created.headers.location, '/api/link/whip/' + attempt); assert.equal(created.text, ANSWER);
  assert.equal(created.headers['access-control-allow-origin'], undefined); assert.equal(created.headers['cache-control'], 'no-store');
  assert.deepEqual((await g.program('state', { method: 'POST', json: { program: 'air', attempt, state: 'connected', showing: 'webrtc', stats: GOOD_STATS, hidden: false, audio: { wanted: true, playing: true, level: 0.3, sink: 'CABLE Input' }, path: { local: 'host', remote: 'prflx', protocol: 'udp' } } }).done).json, { ok: true });
  const live = (await g.call('/api/link/status?attempt=' + attempt, { headers: { ...phone, 'x-link-client': client } })).json;
  assert.deepEqual(live.program, { online: true, ready: true, throttled: false });
  assert.deepEqual({ ...live.link, since: 0, echoAgeMs: 0 }, { state: 'connected', mine: true, since: 0, echoAgeMs: 0, stats: { w: 720, h: 1280, fps: 30, kbps: 1800, rttMs: 4, lossPct: 0 }, audio: { wanted: true, playing: true, level: 0.3 }, path: { local: 'host', remote: 'prflx', protocol: 'udp' }, lastError: null });
  assert.ok(live.link.echoAgeMs >= 0 && live.link.echoAgeMs < 5000); assert.ok(!JSON.stringify(live).includes(attempt));
  // the phone tells that its page is hidden; the parked poll delivers it
  assert.deepEqual((await g.call('/api/link/state', { method: 'POST', headers: { ...phone, 'x-link-client': client }, json: { attempt, video: 'muted', audio: 'live', visible: false, stats: { w: 720, h: 1280, fps: 30, kbps: 2400, rttMs: 3, codec: 'video/H264', encoder: 'MediaCodec', limit: 'none' } } })).json, { ok: true });
  const capture = await parked.done; assert.deepEqual({ ...capture.json, seq: 0 }, { seq: 0, type: 'capture', attempt, video: 'muted', audio: 'live', visible: false });
  const ops = (await g.call('/api/link/ops')).json; assert.equal(ops.link.client.label, 'Galaxy'); assert.equal(ops.link.capture.stats.codec, 'video/H264'); assert.equal(ops.link.audio.sink, 'CABLE Input'); assert.equal(ops.program.stats.vw, 736); assert.equal(ops.program.pageId, 'air');
  // stop from the phone: the program is told, the link is idle
  const waiting = g.program('poll?program=air&after=' + capture.json.seq);
  assert.deepEqual((await g.call('/api/link/whip/' + attempt, { method: 'DELETE', headers: { ...phone, origin: 'https://phone.example' } })).json, { ok: true });
  assert.deepEqual({ ...(await waiting.done).json, seq: 0 }, { seq: 0, type: 'stop', attempt, reason: 'client_stop' });
  assert.equal((await g.call('/api/link/status', { headers: { ...phone, 'x-link-client': client } })).json.link.state, 'idle');
  assert.deepEqual((await g.call('/api/link/whip/' + attempt + '/bye', { method: 'POST', headers: phone, body: 'bye' })).json, { ok: true });
  assert.deepEqual((await g.call('/api/link/whip/' + attempt, { method: 'DELETE', headers: (await g.pair('Other')) })).json, { error: 'ATTEMPT_UNKNOWN' });
  // bye from the program page needs no key, and the slot is free at once
  assert.deepEqual((await g.open('/api/link/program/bye?program=air', { method: 'POST', body: '', headers: { origin: g.origin, 'content-type': 'text/plain;charset=UTF-8' } }).done).json, { ok: true });
  assert.equal((await g.call('/api/link/ops')).json.lease, null);
  // what was written and what was shown
  const log = g.log(); assert.deepEqual(log.map(e => e.type), ['program_lease', 'offer', 'answer', 'connected', 'capture', 'stop', 'program_bye']);
  const written = fs.readFileSync(path.join(g.root, 'runtime', 'link.log'), 'utf8'); for (const leak of [key, 'v=0', 'the-offer', 'the-answer', attempt, client, 'wm_sid', phone.cookie.split('=')[1]]) assert.ok(!written.includes(leak), 'not in link.log: ' + leak.slice(0, 12));
  for (const answer of g.seen) { const all = answer.text + JSON.stringify(answer.headers); for (const secret of [key, 'private-client-test', 'private-api-test']) assert.ok(!all.includes(secret), 'no secret in any answer'); }
});

test('over HTTP with LINK_DEV=1: this computer may act as the phone, and the program page needs no key', async t => {
  const g = await gateway(t, { env: { LINK_DEV: '1', LINK_PROGRAM_KEY: 'configured-program-key-0123456789', LINK_ICE_SERVERS: '[{"urls":"stun:stun.example.org:3478"}]' } });
  assert.equal(fs.existsSync(path.join(g.root, 'runtime', 'link-program.key')), false, 'a key from the settings is not written to disk');
  const status = await g.call('/api/link/status'); assert.equal(status.status, 200); assert.deepEqual(status.json.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
  assert.equal((await g.call('/api/link/status', { headers: REMOTE })).status, 401, 'a remote caller still needs pairing');
  const poll = g.open('/api/link/program/poll?program=dev-page', { headers: { origin: g.origin } });
  assert.deepEqual((await g.call('/api/link/program/poll?program=dev-page')).json, { error: 'PROGRAM_ORIGIN_REQUIRED' }, 'the origin is still required');
  await g.parked();
  const whip = g.open('/api/link/whip', { method: 'POST', body: OFFER, headers: { 'content-type': 'application/sdp', origin: g.own } });
  const offer = await poll.done; assert.equal(offer.json.type, 'offer'); assert.equal(offer.json.client.label, 'local'); assert.deepEqual(offer.json.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
  assert.deepEqual((await g.open('/api/link/program/answer', { method: 'POST', json: { program: 'dev-page', attempt: offer.json.attempt, sdp: ANSWER }, headers: { origin: g.origin } }).done).json, { ok: true });
  const created = await whip.done; assert.equal(created.status, 201); assert.equal(created.headers.location, '/api/link/whip/' + offer.json.attempt);
  assert.deepEqual((await g.call('/api/link/whip', { method: 'POST', body: OFFER, headers: { 'content-type': 'application/sdp', origin: g.origin } })).json, { error: 'ORIGIN_REJECTED' }, 'even in dev the program page\'s origin cannot offer');
  assert.equal((await g.call('/api/link/ops')).json.dev, true);
  for (const answer of g.seen) assert.ok(!(answer.text + JSON.stringify(answer.headers)).includes('configured-program-key'));
});

test('over HTTP: an oversize body is 413 whether it says its size or not, a wrong type is 415, and nothing of it reaches the page', async t => {
  const g = await gateway(t), phone = await g.pair(), sdpHeaders = { ...phone, 'content-type': 'application/sdp' };
  const poll = g.program('poll?program=air'); await g.parked();
  const huge = 'v=0\r\n' + 'a=fill:' + 'x'.repeat(70000);
  const declared = await g.call('/api/link/whip', { method: 'POST', body: huge, headers: sdpHeaders }); assert.equal(declared.status, 413); assert.deepEqual(declared.json, { error: 'BODY_TOO_LARGE' });
  const streamed = await g.call('/api/link/whip', { method: 'POST', body: huge, chunked: true, headers: sdpHeaders }); assert.equal(streamed.status, 413); assert.deepEqual(streamed.json, { error: 'BODY_TOO_LARGE' });
  assert.deepEqual((await g.call('/api/link/whip', { method: 'POST', body: 'v=0\r\n' + 'a=fill:' + 'x'.repeat(62000), headers: sdpHeaders })).json, { error: 'SDP_INVALID' }, 'under the byte cap but over 60000 characters');
  assert.deepEqual((await g.call('/api/link/whip', { method: 'POST', json: { sdp: OFFER }, headers: phone })).json, { error: 'SDP_REQUIRED' });
  assert.deepEqual((await g.call('/api/link/state', { method: 'POST', body: OFFER, headers: sdpHeaders })).json, { error: 'JSON_REQUIRED' });
  assert.deepEqual((await g.call('/api/link/state', { method: 'POST', json: { attempt: 'attempt-0001', pad: 'x'.repeat(3000) }, headers: phone })).json, { error: 'BODY_TOO_LARGE' });
  assert.deepEqual((await g.program('state', { method: 'POST', json: { program: 'air', state: 'idle', pad: 'x'.repeat(3000) } }).done).json, { error: 'BODY_TOO_LARGE' });
  assert.deepEqual((await g.program('answer', { method: 'POST', body: '{broken', headers: { 'content-type': 'application/json' } }).done).json, { error: 'INVALID_JSON' });
  assert.deepEqual((await g.program('answer', { method: 'POST', json: { program: 'air', attempt: 'attempt-0001', sdp: huge } }).done).json, { error: 'BODY_TOO_LARGE' });
  const big = 'v=0\r\n' + 'a=fill:' + 'x'.repeat(50000);
  const whip = g.open('/api/link/whip', { method: 'POST', body: big, headers: { ...sdpHeaders, 'x-link-attempt': 'attempt-0001' } });
  const offer = await poll.done; assert.equal(offer.json.sdp, big, 'the first thing the page receives is the one valid offer, whole');
  assert.equal((await g.program('answer', { method: 'POST', json: { program: 'air', attempt: 'attempt-0001', sdp: big } }).done).status, 200); assert.equal((await whip.done).text, big);
});

test('over HTTP: timeouts, a phone that hung up, and a server that closes at once with requests still waiting', async t => {
  const g = await gateway(t, { linkOptions: { pollMs: 200, answerMs: 300 } }), phone = await g.pair(), sdpHeaders = { ...phone, 'content-type': 'application/sdp' };
  const started = Date.now();
  const empty = await g.program('poll?program=air').done; assert.equal(empty.status, 204); assert.equal(empty.text, ''); assert.ok(Date.now() - started >= 150, 'the poll waited');
  const slow = await g.call('/api/link/whip', { method: 'POST', body: OFFER, headers: { ...sdpHeaders, 'x-link-attempt': 'attempt-0001' } }); assert.equal(slow.status, 504); assert.deepEqual(slow.json, { error: 'PROGRAM_TIMEOUT' });
  const again = Date.now(); assert.deepEqual((await g.call('/api/link/whip', { method: 'POST', body: OFFER, headers: { ...sdpHeaders, 'x-link-attempt': 'attempt-0001' } })).json, { error: 'PROGRAM_TIMEOUT' }, 'the same attempt again: the stored result');
  assert.ok(Date.now() - again < 250, 'and at once, without waiting a second time');
  assert.equal((await g.call('/api/link/ops')).json.link.lastError, 'PROGRAM_TIMEOUT');
  // the phone hangs up while its offer waits: the answer is refused with 410
  const patient = await gateway(t), phone2 = await patient.pair();
  const poll = patient.program('poll?program=air'); await patient.parked();
  const whip = patient.open('/api/link/whip', { method: 'POST', body: OFFER, agent: false, headers: { ...phone2, 'content-type': 'application/sdp', 'x-link-attempt': 'attempt-0003' } }); whip.done.catch(() => {});
  assert.equal((await poll.done).json.attempt, 'attempt-0003');
  await patient.until(o => o.link.waiting === true, 'the phone waits for the answer');
  whip.req.destroy();
  await patient.until(o => o.link.phase === 'pending' && o.link.waiting === false, 'the hub saw the phone hang up');
  const gone = await patient.program('answer', { method: 'POST', json: { program: 'air', attempt: 'attempt-0003', sdp: ANSWER } }).done; assert.equal(gone.status, 410); assert.deepEqual(gone.json, { error: 'CLIENT_GONE' });
  // close with a parked poll and a waiting phone: both are answered and the server is closed in well under the 8 s / 25 s waits
  const first = patient.program('poll?program=air'); await patient.parked();
  const waiting = patient.open('/api/link/whip', { method: 'POST', body: OFFER, headers: { ...phone2, 'content-type': 'application/sdp', 'x-link-attempt': 'attempt-0004' } });
  const offer = await first.done; const parked = patient.program('poll?program=air&after=' + offer.json.seq);
  await patient.until(o => o.program.parked === true && o.link.waiting === true, 'a parked poll and a waiting phone');
  const closing = Date.now(); await patient.close(); const took = Date.now() - closing;
  assert.equal((await parked.done).status, 204); const released = await waiting.done; assert.equal(released.status, 503); assert.deepEqual(released.json, { error: 'PROGRAM_OFFLINE' });
  assert.ok(took < 3000, 'closed in ' + took + ' ms');
});

test('over HTTP: /cam/ serves its five files with the strict policy, and the operator page to this computer only', async t => {
  const camDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanna-cam-'));
  for (const [name, text] of [['index.html', '<!doctype html><title>cam</title>'], ['cam-link.js', 'export const x=1;'], ['cam.css', 'body{}'], ['ops.html', '<!doctype html><title>ops</title>'], ['secret.html', 'never served'], ['.env', 'NEVER=1']]) fs.writeFileSync(path.join(camDir, name), text);
  const g = await gateway(t, { camDir }); t.after(() => fs.rmSync(camDir, { recursive: true, force: true }));
  const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  for (const [route, type, text] of [['/cam/', 'text/html; charset=utf-8', '<!doctype html><title>cam</title>'], ['/cam/index.html', 'text/html; charset=utf-8', '<!doctype html><title>cam</title>'], ['/cam/?debug=1', 'text/html; charset=utf-8', '<!doctype html><title>cam</title>'], ['/cam/cam-link.js', 'text/javascript; charset=utf-8', 'export const x=1;'], ['/cam/cam.css', 'text/css; charset=utf-8', 'body{}']]) {
    const r = await g.call(route, { headers: REMOTE }); assert.equal(r.status, 200, route); assert.equal(r.text, text); assert.equal(r.headers['content-type'], type);
    assert.equal(r.headers['content-security-policy'], CSP); assert.equal(r.headers['permissions-policy'], 'camera=(self), microphone=(self), screen-wake-lock=(self), display-capture=()');
    assert.equal(r.headers['cache-control'], 'no-cache'); assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['service-worker-allowed'], undefined); assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  const bare = await g.call('/cam?voice=1', { headers: REMOTE }); assert.equal(bare.status, 302); assert.equal(bare.headers.location, '/cam/?voice=1');
  assert.equal((await g.call('/cam', { headers: REMOTE })).headers.location, '/cam/');
  for (const route of ['/cam/secret.html', '/cam/.env', '/cam/nothing.js', '/cam/..%2fmobile-gateway.mjs', '/cam/..%2f..%2fpackage.json', '/cam/index.html/', '/cam/sw.js', '/cam/manifest.webmanifest', '/cam/%69ndex.htm']) assert.equal((await g.call(route, { headers: REMOTE })).status, 404, route);
  const climbed = await g.call('/cam/%2e%2e/package.json', { headers: REMOTE }); assert.equal(climbed.status, 401, 'a path that climbs out of /cam/ is just another private route'); assert.ok(!climbed.text.includes('wanna-fx-mobile'));
  assert.equal((await g.call('/cam/ops.js')).status, 404, 'a listed file that is not on disk yet is 404');
  for (const route of ['/cam/ops', '/cam/ops/', '/cam/ops.html', '/cam/ops.js']) { const r = await g.call(route, { headers: REMOTE }); assert.equal(r.status, 403, route); assert.deepEqual(r.json, { error: 'LOCAL_SETUP_ONLY' }); }
  for (const route of ['/cam/ops', '/cam/ops/', '/cam/ops.html']) { const r = await g.call(route); assert.equal(r.status, 200, route); assert.equal(r.text, '<!doctype html><title>ops</title>'); assert.equal(r.headers['content-security-policy'], CSP); }
  // the other pages keep their own policy
  const mobile = await g.call('/mobile/', { headers: REMOTE }); assert.equal(mobile.headers['permissions-policy'], 'camera=(self), microphone=(self), display-capture=(self)'); assert.match(mobile.headers['content-security-policy'], /frame-ancestors 'self'/);
  // and the real folder: whatever of the five files exists is served, nothing else
  const real = await gateway(t);
  for (const name of ['index.html', 'cam-link.js', 'cam.css', 'ops.html', 'ops.js']) {
    const exists = fs.existsSync(new URL('../public/cam/' + name, import.meta.url)), r = await real.call('/cam/' + name);
    assert.equal(r.status, exists ? 200 : 404, name); if (exists) assert.equal(r.headers['content-security-policy'], CSP);
  }
});
