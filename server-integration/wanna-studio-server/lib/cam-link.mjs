// CAM LINK hub: the signalling relay between the creator's phone (the capture page at /cam/) and the "program page"
// (Chrome on this computer, /fx/?src=live). Media never passes through here: the phone posts ONE SDP offer, the program
// page long-polls for it and posts ONE SDP answer, and the two browsers then talk peer-to-peer over WebRTC.
//
// createCamLink() is an explicit state machine, in memory, with injected now/timers and no I/O except the injected
// log function. The file helpers at the bottom (program key, runtime/link.log) are the gateway's side of it.
//
// Phone-facing routes (identity = the paired session, or the loopback "local-desktop" only with LINK_DEV=1; no CORS):
//   GET    /api/link/status?attempt=<id>     what the program reports about the link (numbers and fixed words only)
//   POST   /api/link/whip                    application/sdp in; parks up to answerMs; 201 + Location + application/sdp out
//   DELETE /api/link/whip/<attemptId>        stop (idempotent)        POST /api/link/whip/<attemptId>/bye   the same, for pagehide
//   POST   /api/link/state                   {attempt, video, audio, visible, stats}
// Program-facing routes (a local request + Origin http://127.0.0.1|localhost:<upstreamPort> + X-Link-Program-Key; CORS for
// those two origins only):
//   GET    /api/link/program/poll?program=<pageId>&inst=<load id>&after=<seq>&takeover=0|1     long poll: the oldest message after <seq>
//   POST   /api/link/program/answer          {program, inst, attempt, sdp}
//   POST   /api/link/program/state           {program, inst, attempt|null, state, showing, stats, hidden, audio, path, lastError}
//   POST   /api/link/program/bye?program=&inst=   releases the lease at once (no key: sendBeacon cannot send one)
// Operator route (a local request):  GET /api/link/ops
//
// Rules worth knowing before changing anything here:
// - One program page owns the slot (a lease by pageId + inst, kept alive by polling). Another page gets 409 PROGRAM_BUSY, or
//   takes the lease with takeover=1, and then the old page is told 410 PROGRAM_SUPERSEDED and must stop for good. "inst" is a
//   random value per page LOAD: two windows opened with the same address (the launcher always writes program=air) are two
//   pages, not one page polling twice. A page that sends no inst is known by its pageId alone, as before.
// - Messages to the program are an ordered queue with a growing seq; "after" acknowledges stop/capture messages. An offer
//   is NOT consumed by delivery or by an acknowledgement: a reloaded page (after=0) gets it again until it is answered,
//   replaced, timed out or 10 s old.
// - One link at a time ("current attempt"). A new accepted offer replaces it; the program is told to stop whatever it was
//   told about, always BEFORE the newer offer in the queue, and never about an attempt older than the one it holds.
// - The program is the source of truth: while it names the attempt in its state reports it holds that link, and its word
//   moves the link between negotiating / connected / stalled / lost ("lost" = no picture for 3 s; the same connection may
//   come back). The link is over when the page names another attempt or none, loses the slot, or the phone stops or
//   replaces it. After a gateway restart the hub adopts the attempt the page reports as connected.
// - Nothing here writes SDP, keys or cookies to the log, and nothing the program reports reaches a phone as free text.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LEASE_MS = 10000;        // a program page keeps the slot this long after its last poll ended
export const ONLINE_GRACE_MS = 3000;  // "online" = a poll is parked, or the lease holder's last poll ended less than this ago
export const OFFER_TTL_MS = 10000;    // an unanswered offer is handed out for at most this long
export const HELD_MS = 10000;         // another client needs X-Link-Takeover while the link was held this recently: reported connected, reported
                                      // by a page that is still loading its engine, or taken with X-Link-Takeover itself
export const HOLDER_SILENT_MS = 3000; // the same paired phone with a new page (a new X-Link-Client) needs no takeover once the page that held
                                      // the link has not been heard from for this long (it asks for its status every second while it lives)
export const DISOWN_GRACE_MS = 2000;  // a program report naming another attempt this soon after the answer is just an older report
export const SUPERSEDED_MS = 10000;   // how long a displaced page that had no parked poll is remembered (to tell it 410 once)
export const QUEUE_MAX = 20;
export const EVENTS_MAX = 50;
export const OFFERS_PER_MINUTE = 10;
export const ATTEMPTS_KEPT = 16;      // ended attempts remembered, so a repeated request or a late DELETE is still recognised
export const SDP_MAX_BYTES = 65536;
export const STATE_MAX_BYTES = 2048;
export const PROGRAM_KEY_MIN = 16;    // a shorter LINK_PROGRAM_KEY is refused outright (every keyed program route answers 403)

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;   // attempt id and client id (a UUID fits)
const PAGE_RE = /^[A-Za-z0-9_-]{1,40}$/; // program page id
const ICE_URL_RE = /^(stun|turns?):[a-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/;
const LINK_STATES = ['loading', 'idle', 'answering', 'connected', 'stalled', 'lost'];
const TRACK_STATES = ['live', 'muted', 'ended'];
const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'];
const PROTOCOLS = ['udp', 'tcp'];
// the only words that may appear as link.lastError: the hub's own codes, and what the program page (fx/link-receiver.js)
// says when it gives a link up. Anything else the page reports becomes null.
const ERROR_CODES = new Set(['PROGRAM_OFFLINE', 'PROGRAM_TIMEOUT', 'PROGRAM_SUPERSEDED', 'LINK_REPLACED', 'REPLACED', 'STALE_ATTEMPT', 'CLIENT_GONE', 'STREAM_REJECTED', 'SDP_INVALID', 'ANSWER_FAILED', 'CONNECT_TIMEOUT', 'CONNECTION_FAILED']);
// [upper bound, decimals] for every number the program / the phone may report; anything else becomes 0
const PROGRAM_STATS = { w: [8192, 0], h: [8192, 0], fps: [240, 1], framesDecoded: [1e9, 0], freezeCount: [1e6, 0], jitterMs: [60000, 1], kbps: [100000, 0], rttMs: [60000, 1], lossPct: [100, 1], rafHz: [1000, 1], drawHz: [1000, 1], pcCreated: [1e6, 0], vw: [16384, 0], vh: [16384, 0], dpr: [16, 2] };
const PHONE_STATS = { w: [8192, 0], h: [8192, 0], fps: [240, 1], kbps: [100000, 0], rttMs: [60000, 1] };
const STATUS_STATS = ['w', 'h', 'fps', 'kbps', 'rttMs', 'lossPct'];
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const CAPTURE_DEFAULT = { video: 'live', audio: 'live', visible: true };

const fail = (code, status = 400) => Object.assign(new Error(code), { status });
const num = (v, max, digits = 0) => { if (typeof v !== 'number' || !Number.isFinite(v)) return 0; const f = 10 ** digits; return Math.round(Math.max(0, Math.min(max, v)) * f) / f; };
const word = (v, max = 40) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9 ._/-]/g, '').slice(0, max) : '');
const label = v => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
const idOrNull = v => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const short = id => String(id).slice(0, 8); // enough to follow one attempt through the log, not enough to act on it
const mediaType = req => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
const jsonResult = (status, data) => ({ status, headers: JSON_HEADERS, body: JSON.stringify(data) });

// An SDP is accepted as: a string of 200..60000 characters that starts with "v=0", at most 3 media sections and at
// most 40 candidate lines. Nothing else about it is interpreted here.
export function validSdp(sdp) {
  if (typeof sdp !== 'string' || sdp.length < 200 || sdp.length > 60000 || !sdp.startsWith('v=0')) return false;
  let media = 0, candidates = 0;
  for (const line of sdp.split(/\r?\n/)) { if (line.startsWith('m=')) media++; else if (line.startsWith('a=candidate:')) candidates++; }
  return media <= 3 && candidates <= 40;
}

// LINK_ICE_SERVERS: a JSON array of RTCIceServer. Empty or missing -> [] (host candidates only). Any problem (broken
// JSON, an address that is not stun:/turn:/turns:, a wrong type) -> [] and invalid:true; never a partial list.
export function parseIceServers(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return { iceServers: [], invalid: false };
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(list) || list.length > 8) throw fail('ICE');
    const iceServers = list.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('ICE');
      const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
      if (!urls.length || urls.length > 8 || urls.some(u => typeof u !== 'string' || !ICE_URL_RE.test(u))) throw fail('ICE');
      const server = { urls: [...urls] };
      for (const key of ['username', 'credential']) if (item[key] !== undefined) { if (typeof item[key] !== 'string' || item[key].length > 256) throw fail('ICE'); server[key] = item[key]; }
      return server;
    });
    return { iceServers, invalid: false };
  } catch { return { iceServers: [], invalid: true }; }
}

// Reads a request body without ever destroying the request (a destroyed request takes its socket along, and the
// answer with it): an oversize body is refused from its Content-Length when there is one, otherwise as soon as the
// stream passes the cap, and the rest is left to drain.
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) { reject(fail('BODY_TOO_LARGE', 413)); return; }
    const chunks = []; let size = 0, done = false;
    const finish = (error, value) => { if (done) return; done = true; req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('close', onClose); if (error) reject(error); else resolve(value); };
    const onData = part => { size += part.length; if (size > max) { finish(fail('BODY_TOO_LARGE', 413)); req.resume(); return; } chunks.push(part); };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = () => finish(fail('REQUEST_ABORTED', 400));
    const onClose = () => finish(fail('REQUEST_ABORTED', 400));
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('close', onClose);
  });
}
async function readJson(req, max) {
  if (mediaType(req) !== 'application/json') throw fail('JSON_REQUIRED', 415);
  const raw = await readBody(req, max);
  let value; try { value = JSON.parse(raw.toString('utf8')); } catch { throw fail('INVALID_JSON', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_JSON', 400);
  return value;
}

// The hub. env: LINK_DEV, LINK_ICE_SERVERS (read from this object only) · upstreamPort: the studio server's port, which
// makes the two program origins · root, version: shown as the build identity · now, timers: the clock (tests hand in a
// fake one) · pollMs / answerMs: how long a poll / a phone's offer may wait · log(event): gets every event {at,type,detail}
// · air(): {known, live} from the TikTok event connection · programKey: the secret of the program page · publicUrl():
// the gateway's public https origin, '' when it has none · port: the gateway's own port (whether a request is local is
// decided by the gateway and arrives as ctx.local, so the hub itself does not use it).
// Returns { handle(req, res, url, ctx = {local, paired}), close(), snapshot(), build }.
export function createCamLink({ env = {}, port, upstreamPort, root, version, now = Date.now, timers = { setTimeout, clearTimeout }, pollMs = 25000, answerMs = 8000, log = () => {}, air = () => ({ known: false, live: false }), programKey, publicUrl = () => '' } = {}) {
  const dev = String(env.LINK_DEV ?? '').trim() === '1';
  const key = typeof programKey === 'string' ? programKey : '';
  const programOrigins = ['http://127.0.0.1:' + upstreamPort, 'http://localhost:' + upstreamPort];
  const startedAt = now();
  const build = Object.freeze({ version, root, startedAt });
  const ice = parseIceServers(env.LINK_ICE_SERVERS), iceServers = ice.iceServers;

  let closed = false;
  let seq = startedAt;             // message numbers continue above every number an earlier gateway run handed out
  const queue = [];                // messages for the program, oldest first: {seq, at, sent, type, ...}
  let lease = null;                // {pageId, inst, since, lastSeenAt}: the program page (one load of it) that owns the slot
  let waiter = null;               // {rq, pageId, after, timer}: the one parked poll
  let lastPollEndAt = -Infinity;
  let echo = null;                 // the lease holder's last state report, sanitised
  const attempts = new Map();      // attempt id -> record, the current one and the last few ended ones
  let current = null;              // the attempt that is the link right now (pending or answered), or null
  const link = { state: 'idle', since: startedAt, lastError: null };
  const offerTimes = new Map();    // identity -> times of its accepted offers in the last minute
  const superseded = new Map();    // pageId/inst -> when it was displaced without a parked poll to tell it
  const busyNoted = new Set(), quietNotes = new Map();
  const events = [];

  const later = (fn, ms) => { const handle = timers.setTimeout(fn, ms); if (typeof handle?.unref === 'function') handle.unref(); return handle; };
  const cancel = handle => { if (handle) timers.clearTimeout(handle); };

  function note(type, detail = {}) {
    const event = { at: now(), type, detail };
    events.push(event); if (events.length > EVENTS_MAX) events.shift();
    try { log(event); } catch { /* a broken log never breaks the link */ }
  }
  // the same thing again within 5 s (a page retrying, a phone hammering) is written once
  function noteQuiet(type, detail = {}) {
    const k = type + JSON.stringify(detail), t = now();
    if (t - (quietNotes.get(k) ?? -Infinity) < 5000) return;
    if (quietNotes.size > 64) quietNotes.clear();
    quietNotes.set(k, t); note(type, detail);
  }

  // ---- answers --------------------------------------------------------------------------------------------------
  function send(rq, result) {
    const { res } = rq; if (res.headersSent || res.writableEnded) return true;
    try { res.writeHead(result.status, { ...result.headers, ...rq.headers, ...(closed ? { Connection: 'close' } : {}) }); res.end(result.body); } catch { /* the socket is gone */ }
    return true;
  }
  const reply = (rq, status, data) => send(rq, jsonResult(status, data));
  const empty = rq => send(rq, { status: 204, headers: { 'Cache-Control': 'no-store' }, body: undefined });

  // ---- the link ---------------------------------------------------------------------------------------------------
  function setLink(state) { if (link.state !== state) { link.state = state; link.since = now(); } }
  function removeOffer(id) { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type === 'offer' && queue[i].attempt === id) queue.splice(i, 1); }
  // a parked phone request gets its final answer; the answer is kept so the same X-Link-Attempt can ask again
  function settle(a, result) {
    cancel(a.timer); a.timer = null; a.result = result;
    const rq = a.parked; a.parked = null;
    if (rq && !a.clientGone) send(rq, result);
  }
  function endCurrent(how) {
    const a = current; if (!a) return null;
    current = null; a.phase = 'ended'; a.endedAs = how; a.endedAt = now();
    cancel(a.timer); a.timer = null; a.parked = null; a.offerSdp = null; a.answerSdp = null;
    if (a.result?.status === 201) a.result = null; // the answer of an ended link is never handed out again
    removeOffer(a.id);
    return a;
  }
  const owns = (a, identity) => !a.identity || a.identity === identity.id;
  // an adopted attempt (after a gateway restart) has no owner until a phone shows that it knows its id
  function claim(a, identity, clientId) { if (!a.identity) a.identity = identity.id; if (!a.clientId && clientId) a.clientId = clientId; }
  const heard = (a, clientId, t) => { if (a && clientId !== null && a.clientId === clientId) a.clientSeenAt = t; }; // the page that holds the link is alive

  // ---- the queue ----------------------------------------------------------------------------------------------------
  function push(message) {
    queue.push({ seq: ++seq, ...message, at: now(), sent: false });
    if (queue.length > QUEUE_MAX) { const i = queue.findIndex(m => m.type !== 'offer'); queue.splice(i < 0 ? 0 : i, 1); noteQuiet('queue_overflow'); } // the oldest stop/capture goes, never the offer
    pump();
  }
  function pushCapture(a) {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type === 'capture' && queue[i].attempt === a.id && !queue[i].sent) queue.splice(i, 1);
    push({ type: 'capture', attempt: a.id, video: a.capture.video, audio: a.capture.audio, visible: a.capture.visible });
  }
  function nextFor(after, t) {
    for (const m of queue) { if (m.seq <= after) continue; if (m.type === 'offer' && t - m.at >= OFFER_TTL_MS) continue; return m; }
    return null;
  }
  function deliver(rq, m, t) {
    lastPollEndAt = t; if (lease) lease.lastSeenAt = t;
    m.sent = true; if (m.type === 'offer') { const a = attempts.get(m.attempt); if (a) a.delivered = true; }
    const { at, sent, ...wire } = m;
    reply(rq, 200, wire);
  }
  function pump() {
    if (!waiter) return;
    const t = now(), m = nextFor(waiter.after, t); if (!m) return;
    const w = waiter; waiter = null; cancel(w.timer); deliver(w.rq, m, t);
  }

  // ---- the program slot ---------------------------------------------------------------------------------------------
  const online = t => !closed && Boolean(lease) && (Boolean(waiter) || t - lastPollEndAt < ONLINE_GRACE_MS);
  const instOf = v => (typeof v === 'string' ? v : '');
  const holds = (pageId, inst) => Boolean(lease) && lease.pageId === pageId && lease.inst === inst; // the page, and this load of it
  function dropLease(reason) {
    const old = lease; if (!old) return;
    if (waiter) { const w = waiter; waiter = null; cancel(w.timer); if (reason === 'takeover') reply(w.rq, 410, { error: 'PROGRAM_SUPERSEDED' }); else empty(w.rq); }
    else if (reason === 'takeover') superseded.set(old.pageId + '/' + old.inst, now());
    lease = null; echo = null; lastPollEndAt = -Infinity; busyNoted.clear();
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type !== 'offer') queue.splice(i, 1); // they were about that page's connections
    if (current?.phase === 'answered') { // the page that held the connection is gone; a pending offer stays for the next page
      const a = endCurrent('lost'); setLink('lost'); link.lastError = reason === 'takeover' ? 'PROGRAM_SUPERSEDED' : 'PROGRAM_OFFLINE';
      note('lost', { attempt: short(a.id), error: link.lastError });
    }
    note(reason === 'takeover' ? 'program_superseded' : reason === 'bye' ? 'program_bye' : 'program_lost', { program: old.pageId });
  }
  // time-based changes are applied when somebody asks (no background timer): lease expiry and the small bounded maps
  function refresh() {
    const t = now();
    if (lease && !waiter && t - lease.lastSeenAt >= LEASE_MS) dropLease('expired');
    for (const [pageId, at] of superseded) if (t - at >= SUPERSEDED_MS) superseded.delete(pageId);
    for (const [who, stamps] of offerTimes) { while (stamps.length && t - stamps[0] >= 60000) stamps.shift(); if (!stamps.length) offerTimes.delete(who); }
    let ended = 0; for (const a of attempts.values()) if (a.phase === 'ended') ended++;
    for (const [id, a] of attempts) { if (ended <= ATTEMPTS_KEPT) break; if (a.phase === 'ended') { attempts.delete(id); ended--; } }
    return t;
  }

  // ---- program routes ---------------------------------------------------------------------------------------------
  function poll(rq) {
    const q = rq.url.searchParams, pageId = q.get('program') || '', inst = q.get('inst') || '', who = pageId + '/' + inst;
    if (!PAGE_RE.test(pageId) || (inst && !PAGE_RE.test(inst))) return reply(rq, 400, { error: 'PROGRAM_INVALID' });
    const t = refresh(), takeover = q.get('takeover') === '1';
    let after = Number(q.get('after') || 0); if (!Number.isFinite(after) || after < 0 || after > seq) after = 0;
    if (superseded.has(who) && !holds(pageId, inst)) { superseded.delete(who); return reply(rq, 410, { error: 'PROGRAM_SUPERSEDED' }); }
    if (lease && !holds(pageId, inst)) { // another page, or another window that was opened with the same page id
      if (!takeover) { if (!busyNoted.has(who)) { if (busyNoted.size > 32) busyNoted.clear(); busyNoted.add(who); note('program_busy', { program: pageId, holder: lease.pageId }); } return reply(rq, 409, { error: 'PROGRAM_BUSY' }); }
      dropLease('takeover');
    }
    if (!lease) { lease = { pageId, inst, since: t, lastSeenAt: t }; lastPollEndAt = -Infinity; note('program_lease', { program: pageId, takeover }); }
    else { lease.lastSeenAt = t; if (waiter) { const w = waiter; waiter = null; cancel(w.timer); empty(w.rq); } } // the page's own older poll
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type !== 'offer' && queue[i].seq <= after) queue.splice(i, 1); // acknowledged
    const m = nextFor(after, t);
    if (m) { deliver(rq, m, t); return true; }
    const w = { rq, pageId, after, timer: null };
    const ended = () => { if (waiter !== w) return false; waiter = null; cancel(w.timer); lastPollEndAt = now(); if (lease) lease.lastSeenAt = lastPollEndAt; return true; };
    w.timer = later(() => { if (ended()) empty(rq); }, pollMs);
    rq.res.on('close', ended); // the page went away (reload, crash) while its poll was parked
    waiter = w; return true;
  }

  async function answer(rq) {
    const b = await readJson(rq.req, SDP_MAX_BYTES);
    if (typeof b.program !== 'string' || !PAGE_RE.test(b.program)) return reply(rq, 400, { error: 'PROGRAM_INVALID' });
    if (!idOrNull(b.attempt)) return reply(rq, 400, { error: 'ATTEMPT_INVALID' });
    if (!validSdp(b.sdp)) return reply(rq, 400, { error: 'SDP_INVALID' });
    const t = refresh(), a = attempts.get(b.attempt), holder = holds(b.program, instOf(b.inst));
    if (holder && a && a === current && a.phase === 'answered' && a.answerSdp === b.sdp) return reply(rq, 200, { ok: true, repeated: true });
    if (!holder || !a || a !== current || a.phase !== 'pending') { noteQuiet('answer_refused', { attempt: short(b.attempt), code: 'STALE_ATTEMPT' }); return reply(rq, 409, { error: 'STALE_ATTEMPT' }); }
    const parked = a.parked?.res;
    if (a.clientGone || !parked || parked.destroyed || parked.socket?.destroyed) { // the phone is no longer waiting for this answer
      endCurrent('client_gone'); setLink('idle'); link.lastError = 'CLIENT_GONE';
      note('answer_refused', { attempt: short(a.id), code: 'CLIENT_GONE' });
      return reply(rq, 410, { error: 'CLIENT_GONE' });
    }
    a.phase = 'answered'; a.answerSdp = b.sdp; a.answeredAt = t; a.offerSdp = null; removeOffer(a.id);
    settle(a, { status: 201, headers: { 'Content-Type': 'application/sdp', Location: '/api/link/whip/' + a.id, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: b.sdp });
    if (a.capture.video !== 'live' || a.capture.audio !== 'live' || !a.capture.visible) pushCapture(a); // what the phone reported while it waited
    note('answer', { attempt: short(a.id), ms: t - a.createdAt });
    return reply(rq, 200, { ok: true });
  }

  function programReport(b, t) {
    const s = b.stats && typeof b.stats === 'object' ? b.stats : {}, au = b.audio && typeof b.audio === 'object' ? b.audio : {}, p = b.path && typeof b.path === 'object' ? b.path : null;
    const stats = {}; for (const [k, [max, digits]] of Object.entries(PROGRAM_STATS)) stats[k] = num(s[k], max, digits);
    return {
      at: t, attempt: idOrNull(b.attempt), state: b.state, showing: b.showing === 'webrtc' ? 'webrtc' : 'slate', hidden: b.hidden === true,
      rafKnown: typeof s.rafHz === 'number' && Number.isFinite(s.rafHz), stats,
      audio: { wanted: au.wanted === true, playing: au.playing === true, level: num(au.level, 1, 3), sink: word(au.sink) },
      path: p && CANDIDATE_TYPES.includes(p.local) && CANDIDATE_TYPES.includes(p.remote) && PROTOCOLS.includes(p.protocol) ? { local: p.local, remote: p.remote, protocol: p.protocol } : null,
      lastError: ERROR_CODES.has(b.lastError) ? b.lastError : null,
    };
  }
  function loseCurrent(error) { const a = endCurrent('lost'); setLink('lost'); link.lastError = error; note('lost', { attempt: short(a.id), error }); }
  function applyEcho(e, t) {
    const a = current;
    if (a && e.attempt === a.id) { // the page names our attempt: it still holds it, whatever else it says
      a.lastEchoAt = t; a.echo = e;
      if (a.phase !== 'answered') return; // still waiting for the answer: nothing to conclude yet
      if (e.state === 'connected') {
        a.lastConnectedAt = t; link.lastError = null;
        if (!a.connectedAt) { a.connectedAt = t; note('connected', { attempt: short(a.id), ms: t - a.answeredAt }); }
        else if (link.state !== 'connected') noteQuiet('resumed', { attempt: short(a.id) });
        setLink('connected');
      } else if (e.state === 'stalled' || e.state === 'lost') { // no fresh picture on the page (held frame / slate); the same connection may come back
        if (e.lastError) link.lastError = e.lastError;
        if (link.state !== e.state) noteQuiet(e.state, { attempt: short(a.id), ...(e.lastError ? { error: e.lastError } : {}) }); // a picture that flickers is written once per 5 s
        setLink(e.state);
      } else if (e.state === 'loading') a.lastHeldAt = t; // the page holds the connection while its engine still starts (20 to 60 s after a load)
      return; // "answering", or "loading" while the engine still starts: negotiating, as far as a phone is concerned
    }
    if (a) { // the page names another attempt, or none: it no longer holds the one it answered (it was reloaded, or it gave up)
      if (a.phase !== 'answered' || t - a.answeredAt < DISOWN_GRACE_MS) return;
      loseCurrent(e.lastError ?? link.lastError ?? 'STALE_ATTEMPT');
    }
    // no link here, and the page shows a live connection this hub has never heard of: the gateway was restarted
    if (e.attempt && !attempts.has(e.attempt) && (e.state === 'connected' || e.state === 'stalled')) {
      current = { id: e.attempt, identity: null, clientId: null, label: '', createdAt: t, phase: 'answered', endedAs: null, endedAt: null, offerSdp: null, delivered: true, parked: null, clientGone: false, timer: null, result: null, answerSdp: null, answeredAt: t, connectedAt: t, lastConnectedAt: e.state === 'connected' ? t : null, lastHeldAt: null, takeoverAt: null, clientSeenAt: t, lastEchoAt: t, echo: e, adopted: true, capture: { ...CAPTURE_DEFAULT }, captureAt: null, captureStats: null };
      attempts.set(e.attempt, current); setLink(e.state); link.lastError = null;
      note('adopted', { attempt: short(e.attempt), state: e.state });
    }
  }
  async function programState(rq) {
    const b = await readJson(rq.req, STATE_MAX_BYTES);
    if (typeof b.program !== 'string' || !PAGE_RE.test(b.program)) return reply(rq, 400, { error: 'PROGRAM_INVALID' });
    if (!LINK_STATES.includes(b.state)) return reply(rq, 400, { error: 'STATE_INVALID' });
    const t = refresh();
    if (!holds(b.program, instOf(b.inst))) return reply(rq, 409, { error: 'PROGRAM_BUSY' }); // only the page that holds the lease (by polling) reports
    echo = programReport(b, t); applyEcho(echo, t);
    return reply(rq, 200, { ok: true });
  }

  function bye(rq) {
    const pageId = rq.url.searchParams.get('program') || '', inst = rq.url.searchParams.get('inst') || '';
    refresh();
    if (holds(pageId, inst)) dropLease('bye'); // (a window that was superseded, or never held the slot, releases nothing by closing)
    return reply(rq, 200, { ok: true });
  }

  function keyMatches(req) {
    const given = Buffer.from(String(req.headers['x-link-program-key'] ?? '')), wanted = Buffer.from(key);
    return wanted.length >= PROGRAM_KEY_MIN && given.length === wanted.length && crypto.timingSafeEqual(given, wanted); // no key, or a toy one: nobody passes
  }
  async function program(rq, route) {
    const { req, ctx } = rq, origin = req.headers.origin, allowed = programOrigins.includes(origin);
    if (req.method === 'OPTIONS') { // a preflight is answered for the two program origins only; anything else stays the gateway's 405
      if (!ctx.local || !allowed) return false;
      return send(rq, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Link-Program-Key', 'Access-Control-Max-Age': '600' }, body: undefined });
    }
    if (!ctx.local) return reply(rq, 403, { error: 'LOCAL_SETUP_ONLY' });
    if (!allowed) return reply(rq, 403, { error: 'PROGRAM_ORIGIN_REQUIRED' });
    rq.headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }; // on every answer from here on, errors included
    const isBye = route === 'bye' && req.method === 'POST';
    if (!dev && !isBye && !keyMatches(req)) return reply(rq, 403, { error: 'PROGRAM_KEY_REQUIRED' });
    if (closed) return reply(rq, 503, { error: 'LINK_CLOSED' });
    const wanted = { poll: 'GET', answer: 'POST', state: 'POST', bye: 'POST' }[route];
    if (!wanted) return reply(rq, 404, { error: 'NOT_FOUND' });
    if (req.method !== wanted) return reply(rq, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (route === 'poll') return poll(rq);
    if (route === 'answer') return answer(rq);
    if (route === 'state') return programState(rq);
    return bye(rq);
  }

  // ---- phone routes -----------------------------------------------------------------------------------------------
  // the gateway's own same-origin rule, repeated here because these routes are answered before it runs
  function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const o = req.headers.origin; if (!o) return true;
    try { const origin = new URL(o); return origin.host === req.headers.host || origin.origin === publicUrl(); } catch { return false; }
  }
  async function whip(rq, identity) {
    const { req } = rq;
    if (mediaType(req) !== 'application/sdp') return reply(rq, 415, { error: 'SDP_REQUIRED' });
    const sdp = (await readBody(req, SDP_MAX_BYTES)).toString('utf8');
    if (!validSdp(sdp)) return reply(rq, 400, { error: 'SDP_INVALID' });
    const given = req.headers['x-link-attempt'];
    if (given !== undefined && !idOrNull(given)) return reply(rq, 400, { error: 'ATTEMPT_INVALID' });
    const id = given ?? crypto.randomUUID(), clientId = idOrNull(req.headers['x-link-client']), takeover = req.headers['x-link-takeover'] === '1';
    const t = refresh(), known = attempts.get(id);
    if (known) { // the same attempt again: the stored answer, never a second offer
      if (known.identity !== identity.id) return reply(rq, 409, { error: 'STALE_ATTEMPT' });
      if (known.result) return send(rq, known.result);
      return known.phase === 'pending' ? reply(rq, 429, { error: 'OFFER_IN_FLIGHT' }) : reply(rq, 409, { error: 'STALE_ATTEMPT' });
    }
    if (!online(t)) { if (!current) link.lastError = 'PROGRAM_OFFLINE'; noteQuiet('offer_refused', { code: 'PROGRAM_OFFLINE' }); return reply(rq, 503, { error: 'PROGRAM_OFFLINE' }); }
    const previous = current;
    // "Held": the program page said "connected" for it, or said "loading" while holding it, or it was itself taken with the
    // takeover header (her tap on "bring it back here"), each within HELD_MS. "lost" and "stalled" reports do not count, so a
    // dead holder can always be replaced. A waiting offer counts only when it came with the takeover header and its phone
    // still waits.
    const heldAt = previous ? Math.max(previous.lastConnectedAt ?? -Infinity, previous.lastHeldAt ?? -Infinity, previous.takeoverAt ?? -Infinity) : -Infinity;
    // The same holder asking again: the same page (X-Link-Client), or - for a paired phone, where one session is one phone -
    // the same session from a new page once the old page has gone quiet (the browser was killed and its bye never arrived).
    // Under LINK_DEV every local caller shares one identity, so there only the client id counts.
    const sameHolder = previous && ((clientId !== null && previous.clientId === clientId)
      || (!dev && previous.identity !== null && previous.identity === identity.id && t - previous.clientSeenAt >= HOLDER_SILENT_MS));
    const heldByOther = previous && (previous.phase === 'answered' || (previous.takeoverAt !== null && !previous.clientGone)) && t - heldAt < HELD_MS
      && !sameHolder && !(previous.adopted && !previous.clientId);
    if (heldByOther && !takeover) { noteQuiet('offer_refused', { code: 'LINK_REPLACED' }); return reply(rq, 409, { error: 'LINK_REPLACED' }); }
    // one offer in flight per identity - unless the phone that waited for the earlier one has hung up (its network dropped):
    // nobody is left to receive that answer, so the new offer takes its place below
    if (previous?.phase === 'pending' && previous.identity === identity.id && !previous.clientGone) return reply(rq, 429, { error: 'OFFER_IN_FLIGHT' });
    const stamps = offerTimes.get(identity.id) || [];
    if (stamps.length >= OFFERS_PER_MINUTE) { noteQuiet('offer_refused', { code: 'OFFER_RATE_LIMIT' }); return reply(rq, 429, { error: 'OFFER_RATE_LIMIT' }); }
    stamps.push(t); offerTimes.set(identity.id, stamps);
    if (previous) { // one link at a time: tell the program to drop what it was told about, before the new offer
      const told = previous.phase === 'answered' || previous.delivered;
      if (previous.phase === 'pending') settle(previous, jsonResult(409, { error: 'REPLACED' }));
      endCurrent('replaced');
      if (told && lease) push({ type: 'stop', attempt: previous.id, reason: 'replaced' });
      note('replaced', { attempt: short(previous.id), by: short(id) });
    }
    const a = { id, identity: identity.id, clientId, label: identity.label, createdAt: t, phase: 'pending', endedAs: null, endedAt: null, offerSdp: sdp, delivered: false, parked: rq, clientGone: false, timer: null, result: null, answerSdp: null, answeredAt: null, connectedAt: null, lastConnectedAt: null, lastHeldAt: null, takeoverAt: takeover ? t : null, clientSeenAt: t, lastEchoAt: null, echo: null, adopted: false, capture: { ...CAPTURE_DEFAULT }, captureAt: null, captureStats: null };
    attempts.set(id, a); current = a; setLink('negotiating');
    rq.res.on('close', () => { if (!rq.res.writableEnded) a.clientGone = true; });
    a.timer = later(() => { // nobody answered in time
      a.timer = null; if (current !== a || a.phase !== 'pending') return;
      const told = a.delivered;
      settle(a, jsonResult(504, { error: 'PROGRAM_TIMEOUT' })); endCurrent('expired'); setLink('idle'); link.lastError = 'PROGRAM_TIMEOUT';
      if (told && lease) push({ type: 'stop', attempt: a.id, reason: 'expired' });
      note('timeout', { attempt: short(a.id), delivered: told });
    }, answerMs);
    note('offer', { attempt: short(id), client: a.label, takeover });
    push({ type: 'offer', attempt: id, sdp, iceServers, client: { label: a.label } });
    return true;
  }
  function stop(rq, identity, id) {
    refresh();
    const a = attempts.get(id);
    if (!a || !owns(a, identity)) return reply(rq, 404, { error: 'ATTEMPT_UNKNOWN' });
    if (a === current) {
      const told = a.phase === 'answered' || a.delivered;
      if (a.phase === 'pending') settle(a, jsonResult(409, { error: 'STALE_ATTEMPT' }));
      endCurrent('client_stop'); setLink('idle'); link.lastError = null;
      if (told && lease) push({ type: 'stop', attempt: id, reason: 'client_stop' });
      note('stop', { attempt: short(id), reason: 'client_stop' });
    }
    return reply(rq, 200, { ok: true }); // an attempt that already ended: nothing left to stop
  }
  async function captureState(rq, identity) {
    const b = await readJson(rq.req, STATE_MAX_BYTES);
    const t = refresh(), a = idOrNull(b.attempt) ? attempts.get(b.attempt) : null;
    if (a && a === current && owns(a, identity)) {
      claim(a, identity, idOrNull(rq.req.headers['x-link-client'])); heard(a, idOrNull(rq.req.headers['x-link-client']), t);
      const next = { video: TRACK_STATES.includes(b.video) ? b.video : a.capture.video, audio: TRACK_STATES.includes(b.audio) ? b.audio : a.capture.audio, visible: typeof b.visible === 'boolean' ? b.visible : a.capture.visible };
      const changed = next.video !== a.capture.video || next.audio !== a.capture.audio || next.visible !== a.capture.visible;
      const s = b.stats && typeof b.stats === 'object' ? b.stats : {}, stats = {};
      for (const [k, [max, digits]] of Object.entries(PHONE_STATS)) stats[k] = num(s[k], max, digits);
      for (const k of ['codec', 'encoder', 'limit']) stats[k] = word(s[k]);
      a.capture = next; a.captureAt = t; a.captureStats = stats;
      if (changed) { if (a.phase === 'answered' && lease) pushCapture(a); noteQuiet('capture', { attempt: short(a.id), ...next }); }
    }
    return reply(rq, 200, { ok: true });
  }

  // ---- what others may see ------------------------------------------------------------------------------------------
  function readAir() { try { const v = air(); return { known: Boolean(v?.known), live: Boolean(v?.live) }; } catch { return { known: false, live: false }; } }
  function view({ clientId = null, asked = null, ops = false } = {}) {
    const t = now(), a = current, e = a?.echo || null;
    const stats = {}; for (const k of STATUS_STATS) stats[k] = e ? e.stats[k] : 0;
    const out = {
      version, serverTime: t, iceServers,
      program: { online: online(t), ready: Boolean(echo) && echo.state !== 'loading', throttled: Boolean(echo) && (echo.hidden || (echo.rafKnown && echo.stats.rafHz < 10)) },
      link: {
        state: link.state, mine: Boolean(a) && ((clientId !== null && a.clientId === clientId) || (asked !== null && asked === a.id)), since: link.since,
        echoAgeMs: a && a.lastEchoAt !== null ? Math.max(0, t - a.lastEchoAt) : null, stats,
        audio: { wanted: (e || echo)?.audio.wanted === true, playing: e?.audio.playing === true, level: e ? e.audio.level : 0 },
        path: e?.path ? { ...e.path } : null, lastError: link.lastError,
      },
      air: readAir(),
    };
    if (!ops) return out;
    // the operator's view (loopback only): the same, plus what the page and the phone last reported and the hub's own record
    Object.assign(out.program, { pageId: lease?.pageId ?? null, parked: Boolean(waiter), state: echo?.state ?? null, showing: echo?.showing ?? null, hidden: echo?.hidden ?? false, attempt: echo?.attempt ? short(echo.attempt) : null, echoAgeMs: echo ? Math.max(0, t - echo.at) : null, stats: echo ? { ...echo.stats } : null, audio: echo ? { ...echo.audio } : null, path: echo?.path ? { ...echo.path } : null });
    Object.assign(out.link, { attempt: a ? short(a.id) : null, phase: a?.phase ?? null, waiting: Boolean(a && a.phase === 'pending' && a.parked && !a.clientGone), adopted: Boolean(a?.adopted), client: a ? { label: a.label } : null, capture: a ? { ...a.capture, at: a.captureAt, stats: a.captureStats ? { ...a.captureStats } : null } : null });
    out.link.audio.sink = e ? e.audio.sink : '';
    return { ...out, dev, build: { ...build }, lease: lease ? { pageId: lease.pageId, lastSeenAt: lease.lastSeenAt } : null, queue: { length: queue.length, seq }, events: events.map(ev => ({ at: ev.at, type: ev.type, detail: { ...ev.detail } })) };
  }

  const CAPTURE_ROUTE = /^\/api\/link\/(?:(status|state|whip)|whip\/([A-Za-z0-9_-]{8,64})(\/bye)?)$/;
  async function capture(rq, match) {
    const { req, ctx } = rq, [, name, attemptId, isBye] = match;
    if (req.method === 'OPTIONS') return false; // no CORS here: the gateway answers 405 as for every other route
    // these routes are answered before the gateway's own origin check, so they refuse a foreign origin themselves
    if (programOrigins.includes(req.headers.origin) || (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req))) return reply(rq, 403, { error: 'ORIGIN_REJECTED' });
    const identity = ctx.paired ? { id: String(ctx.paired.id), label: label(ctx.paired.label) } : dev && ctx.local ? { id: 'local-desktop', label: 'local' } : null;
    if (!identity) return reply(rq, 401, { error: 'PAIRING_REQUIRED' });
    if (closed) return reply(rq, 503, { error: 'LINK_CLOSED' });
    if (name === 'status' && req.method === 'GET') {
      const t = refresh(), clientId = idOrNull(req.headers['x-link-client']), asked = idOrNull(rq.url.searchParams.get('attempt'));
      if (current && asked === current.id && owns(current, identity)) claim(current, identity, clientId);
      if (current && owns(current, identity)) heard(current, clientId, t);
      return reply(rq, 200, view({ clientId, asked }));
    }
    if (name === 'whip' && req.method === 'POST') return whip(rq, identity);
    if (name === 'state' && req.method === 'POST') return captureState(rq, identity);
    if (attemptId && ((req.method === 'DELETE' && !isBye) || (req.method === 'POST' && isBye))) return stop(rq, identity, attemptId);
    return reply(rq, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  // Resolves true when the request was taken (answered now, or parked and answered later), false when it is not ours:
  // an unknown path, or an OPTIONS that deserves no CORS answer.
  async function handle(req, res, url, ctx = {}) {
    const p = url.pathname;
    if (!p.startsWith('/api/link/')) return false;
    const rq = { req, res, url, ctx, headers: {} };
    try {
      if (p.startsWith('/api/link/program/')) return await program(rq, p.slice('/api/link/program/'.length));
      if (p === '/api/link/ops') {
        if (req.method === 'OPTIONS') return false;
        if (!ctx.local) return reply(rq, 403, { error: 'LOCAL_SETUP_ONLY' });
        if (req.method !== 'GET') return reply(rq, 405, { error: 'METHOD_NOT_ALLOWED' });
        refresh(); return reply(rq, 200, view({ ops: true }));
      }
      const match = CAPTURE_ROUTE.exec(p);
      return match ? await capture(rq, match) : false;
    } catch (e) {
      if (!res.headersSent) reply(rq, e.status || 500, { error: e.status ? e.message : 'REQUEST_FAILED' });
      else try { res.end(); } catch { /* already gone */ }
      return true;
    }
  }

  // Answers every parked request (a poll with 204, a waiting phone with 503) and clears every timer, so the HTTP
  // server can close at once. From then on every answer carries "Connection: close" and the routes say 503.
  function close() {
    if (closed) return; closed = true;
    let released = 0;
    if (waiter) { const w = waiter; waiter = null; cancel(w.timer); empty(w.rq); released++; }
    for (const a of attempts.values()) { if (a.phase === 'pending' && a.parked) { settle(a, jsonResult(503, { error: 'PROGRAM_OFFLINE' })); released++; } cancel(a.timer); a.timer = null; }
    if (current) { endCurrent('closed'); setLink('idle'); }
    queue.length = 0;
    if (released) note('closed', { released });
  }

  if (ice.invalid) note('ice_servers_invalid'); // one line, without the value
  return { handle, close, snapshot() { refresh(); return view({ ops: true }); }, build };
}

// ---- the gateway's side: the two files under <root>/runtime (git ignores runtime/ and *.key) ----------------------------

// The program key: LINK_PROGRAM_KEY when it is set, otherwise 24 random bytes (hex) kept in runtime/link-program.key.
// An existing valid file is reused, so a program page that is already open still holds the right key after a gateway
// restart (that is what lets the hub adopt its running link). The launcher reads the same file. Never logged.
export function linkProgramKey({ env = {}, root } = {}) {
  const given = String(env.LINK_PROGRAM_KEY ?? '').trim();
  if (given) { if (given.length < PROGRAM_KEY_MIN) console.error('LINK_PROGRAM_KEY_TOO_SHORT'); return given; } // too short: the hub lets nobody in
  const dir = path.join(root, 'runtime'), file = path.join(dir, 'link-program.key');
  try { const saved = fs.readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{48}$/.test(saved)) return saved; } catch { /* not there yet */ }
  const fresh = crypto.randomBytes(24).toString('hex');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', fresh, { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
  catch (e) { console.error('LINK_PROGRAM_KEY_NOT_SAVED ' + (e.code || 'ERROR')); } // the key still works for this run; the launcher will not find it
  return fresh;
}

// One JSON line per hub event in runtime/link.log (events carry no SDP, keys or addresses). A file that passed 5 MB is
// set aside as link.log.1 (one generation is kept).
export function linkFileLog(root, { maxBytes = 5 * 1024 * 1024 } = {}) {
  const dir = path.join(root, 'runtime'), file = path.join(dir, 'link.log'); let ready = false;
  return event => {
    try {
      if (!ready) { fs.mkdirSync(dir, { recursive: true }); ready = true; }
      try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
      fs.appendFileSync(file, JSON.stringify(event) + '\n');
    } catch { ready = false; }
  };
}

// What mobile-gateway.mjs calls: the hub with the program key and the log file of this workspace root, unless given.
export function createGatewayCamLink({ env = {}, root, programKey, log, ...rest } = {}) {
  return createCamLink({ ...rest, env, root, programKey: programKey ?? linkProgramKey({ env, root }), log: log ?? linkFileLog(root) });
}
