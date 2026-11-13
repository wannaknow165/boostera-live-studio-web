// CAM LINK v1 — the pure half of the program-page receiver (fx/link-receiver.js, ?src=live).
// Everything here is a plain function over plain values: no DOM, no window, no timers, nothing read at load. That is what
// lets `node --test test/link-core.test.mjs` import this file directly (same pattern as fx/stage-url.js).
//
// What lives here: the numbers of the design (sizes, time limits), how the page reads its link options, where the gateway
// is, the cover-fit rectangle of the normaliser, the "is the feed fresh / hold / black" decision, the gather-done rule,
// the SDP sanity check, the size guard, the reading of getStats(), the shape of the state echo, and what a poll reply means.

// ---------- the numbers ----------
export const NORM_W = 720, NORM_H = 1280;       // the one size the engine ever sees (9:16), whatever the phone sends
export const DRAW_MIN_MS = 31;                  // the receiver's loop draws at most every 31 ms (about 30 a second on any display)
export const STATS_MS = 500;                    // getStats() timer: it also ticks when rendering is throttled
export const FRESH_MS = 1500;                   // the feed is fresh while framesDecoded rose within this time
export const SLATE_MS = 3000;                   // the last frame is held for a gap shorter than this; after it: black
export const SLATE_REPAINT_MS = 250;            // the black slate is painted again this often, so the engine's input never dries up
export const CAPTURE_SLATE_MS = 3000;           // the phone said "camera not live / page hidden": black after this, even if packets flow
export const GATHER_QUIET_MS = 300, GATHER_CAP_MS = 2000;
export const ANSWER_DEADLINE_MS = 12000;        // an offer is 10 s old at most on the hub: an answer later than this is of no use
export const CONNECT_MS = 10000;                // not connected this long after answering -> close, report lost
export const POLL_TIMEOUT_MS = 35000;           // the hub parks a poll for 25 s; a poll older than this is dead
export const LEASE_PARKED_MS = 1000;            // a poll that was not refused within a second is parked: the program slot is ours
export const RETRY_PARKED_MS = 200;             // …and after failed polls the same is assumed this soon, so the echo that lets a restarted hub adopt
                                                // the running link leaves at once (a refusal from a gateway on this computer arrives within milliseconds)
export const BUSY_RETRY_MS = 5000, DENIED_RETRY_MS = 5000;
export const FAST_EMPTY_MS = 1000, FAST_EMPTY_WAIT_MS = 500, REPEAT_WAIT_MS = 250; // never spin on a hub that answers at once
export const ECHO_LIVE_MS = 1000, ECHO_IDLE_MS = 5000, ECHO_MIN_GAP_MS = 250, ECHO_TIMEOUT_MS = 3000;
export const LOST_LINGER_MS = 3000;             // after a link it gave up, the page still names that attempt as "lost" this long (so the
                                                // hub gets the reason for THAT attempt), then says "idle" with no attempt: the link is over
export const MAX_PIXELS = 1280 * 720 * 1.2;     // a bigger stream is refused
export const CHURN_MAX = 5, CHURN_WINDOW_MS = 10000; // more size changes than this in the window: refused
export const MAX_CANDIDATES = 40, MAX_M_LINES = 3, SDP_MIN = 200, SDP_MAX = 60000; // the hub's own SDP limits (spec section 4)
export const MAX_ADELAY_MS = 2000, MAX_JB_MS = 4000;
export const HEAD_START_MS = 4500;              // the page waits this long for a phone's offer before it loads the engine (see link-receiver.js);
                                                // a phone that found the program offline looks again every 3 s and then needs about half a second to offer
export const HEAD_START_EXTRA_MS = 2500;        // …and this much longer for an offer that is being answered at that moment
export const KEY_STORE = 'cam-link-program-key'; // sessionStorage: the program key of this tab, so a reload (whose address has no #pk= any more) still has it

// ---------- clamp helpers ----------
// A number from a number or a numeric string, held inside [lo, hi]; anything else (null, '', 'abc', NaN, Infinity, objects) -> dflt.
export function clampNum(v, lo, hi, dflt = lo) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
export function clampInt(v, lo, hi, dflt = lo) { return Math.round(clampNum(v, lo, hi, dflt)); }
export function clampFixed(v, lo, hi, digits = 1, dflt = lo) { const p = 10 ** digits; return Math.round(clampNum(v, lo, hi, dflt) * p) / p; }
export const hz = (count, ms) => (ms > 0 && count > 0 ? Math.round(count * 10000 / ms) / 10 : 0); // events per second, one decimal
// 500, 1000, 1000… The gateway is on this computer, so asking once a second costs nothing, and a restarted gateway must hear
// from this page (poll, then echo) before the phone's 3 s of "this link is not mine" run out.
export const backoffMs = fails => Math.min(1000, 500 * 2 ** Math.min(10, Math.max(0, (fails | 0) - 1)));

// An error code as the hub writes them (UPPER_SNAKE), or null. Nothing free-form ever leaves the page as a "code".
export const upperSnake = v => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(v) ? v : null);
const ATTEMPT_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const validAttempt = v => (typeof v === 'string' && ATTEMPT_RE.test(v) ? v : null);

// ---------- link options (the query string of the program page) ----------
// mirror=1|0 (default 1) · audio=1 (default off) · sink=<output label part> · adelay=<ms> · jb=<ms> · takeover=1 ·
// program=<pageId> · gw=<gateway base>. `search` is a query string or a URLSearchParams.
export function linkOptions(search) {
  const q = search && typeof search.get === 'function' ? search : new URLSearchParams(typeof search === 'string' ? search : '');
  const sink = String(q.get('sink') || '').trim().slice(0, 100);
  return {
    mirror: q.get('mirror') !== '0',
    audio: q.get('audio') === '1',
    sink: sink || null,
    adelayMs: clampInt(q.get('adelay'), 0, MAX_ADELAY_MS, 0),
    jbMs: clampInt(q.get('jb'), 0, MAX_JB_MS, 0),
    takeover: q.get('takeover') === '1',
    program: q.get('program') || '',
    gw: q.get('gw') || '',
    clean: !!q.get('clean'),
  };
}

// The page id the hub knows this page by: 1..40 characters of [A-Za-z0-9_-]. A given one is cleaned; none -> a random one per load.
export function pageIdFrom(raw, random = '') {
  const clean = v => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return clean(raw).slice(0, 40) || ('p-' + (clean(random).slice(0, 32) || '0'));
}

// The program key travels in the fragment (#pk=…): a fragment never reaches a server and survives the /clean/program redirect.
// -> { key, rest, found }: `rest` is the fragment without every pk= part ('' or '#…'); a key that could not travel as an HTTP
// header value (a space at either end, control or non-ASCII characters, longer than 256) is dropped (key '') but is still
// removed from the address.
export function readProgramKey(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const parts = raw ? raw.split('&') : [], mine = parts.filter(p => p.startsWith('pk='));
  if (!mine.length) return { key: '', rest: raw ? '#' + raw : '', found: false };
  let key = mine[0].slice(3); try { key = decodeURIComponent(key); } catch { /* not percent-encoded: taken as written */ }
  const rest = parts.filter(p => !p.startsWith('pk=')).join('&');
  return { key: key.length <= 256 && /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(key) ? key : '', rest: rest ? '#' + rest : '', found: true };
}

// ---------- where the gateway is ----------
// Default: the page's own hostname (so the call stays same-site) and the page's port + 1: 8800 -> 8801, 8810 -> 8811,
// 18880 -> 18881. A page without a port in its address gets the gateway's own default, 8801.
export function defaultGatewayBase({ protocol = 'http:', hostname = '127.0.0.1', port = '' } = {}) {
  const next = /^\d{1,5}$/.test(String(port)) ? Number(port) + 1 : 0;
  return `${protocol === 'https:' ? 'https:' : 'http:'}//${hostname || '127.0.0.1'}:${next >= 2 && next <= 65535 ? next : 8801}`;
}
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// ?gw=<base> wins over the default, but only an http(s) address on this computer (loopback) or on the page's own host:
// the program key is sent to this address, so a link must not be able to point it at another machine.
// -> { base, from: 'param' | 'default', rejected?: why }
export function gatewayBase(gw, loc = {}) {
  const dflt = defaultGatewayBase(loc), no = rejected => ({ base: dflt, from: 'default', rejected });
  if (typeof gw !== 'string' || !gw.trim()) return { base: dflt, from: 'default' };
  let u; try { u = new URL(gw.trim()); } catch { return no('not_a_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return no('protocol');
  if (u.username || u.password) return no('credentials');
  if (!LOOPBACK.has(u.hostname) && !(loc.hostname && u.hostname === loc.hostname)) return no('foreign_host');
  return { base: u.origin + u.pathname.replace(/\/+$/, ''), from: 'param' };
}

// ---------- the normaliser's rectangle ----------
// Cover-fit: the largest centred part of the source that has the destination's shape fills the whole destination, so a
// landscape frame is cropped (never letterboxed, never stretched). mirror -> the canvas transform that flips it left-right.
// -> null for a source without a size, else { sx, sy, sw, sh, dw, dh, mirror, transform:[a,b,c,d,e,f] } for
//    ctx.setTransform(...transform); ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh)
export function coverFit(srcW, srcH, dstW = NORM_W, dstH = NORM_H, mirror = false) {
  if (!(srcW > 0) || !(srcH > 0) || !(dstW > 0) || !(dstH > 0) || ![srcW, srcH, dstW, dstH].every(Number.isFinite)) return null;
  const scale = Math.max(dstW / srcW, dstH / srcH), sw = dstW / scale, sh = dstH / scale;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, dw: dstW, dh: dstH, mirror: !!mirror, transform: mirror ? [-1, 0, 0, 1, dstW, 0] : [1, 0, 0, 1, 0, 0] };
}
// Where a source pixel lands on the destination under that fit (tests, diagnostics).
export function mapPoint(fit, x, y) {
  const dx = (x - fit.sx) * fit.dw / fit.sw, dy = (y - fit.sy) * fit.dh / fit.sh;
  return { x: fit.transform[0] * dx + fit.transform[4], y: dy };
}

// ---------- is the feed fresh? ----------
// The proof of a living feed is the decoder's own counter: framesDecoded of the inbound video stream, read from getStats()
// on a timer (it keeps counting when the window is covered and rendering is throttled).
export const newFreshness = () => ({ frames: null, riseAt: null });
// Note one reading. A counter that went DOWN is a new stream (it restarted from zero): frames decoded on it count as a rise.
export function noteFrames(f, framesDecoded, now) {
  if (typeof framesDecoded !== 'number' || !Number.isFinite(framesDecoded) || framesDecoded < 0) return false;
  const rose = f.frames == null ? framesDecoded > 0 : framesDecoded > f.frames || (framesDecoded < f.frames && framesDecoded > 0);
  f.frames = framesDecoded; if (rose) f.riseAt = now;
  return rose;
}
// What the normaliser paints now:
//   'live'  — blit the received picture (the counter rose within freshMs)
//   'hold'  — keep the last frame (a gap shorter than slateMs)
//   'slate' — black (a longer gap, or never a frame; or the phone reported its camera not live / its page hidden
//             captureSlateMs ago — then even if packets still flow)
export function feedDecision({ now, riseAt = null, captureBadSince = null, freshMs = FRESH_MS, slateMs = SLATE_MS, captureSlateMs = CAPTURE_SLATE_MS }) {
  if (captureBadSince != null && now - captureBadSince >= captureSlateMs) return { mode: 'slate', why: 'capture' };
  if (riseAt == null) return { mode: 'slate', why: 'no_frames' };
  const gap = now - riseAt;
  if (gap <= freshMs) return { mode: 'live', why: null };
  if (gap < slateMs) return { mode: 'hold', why: 'gap' };
  return { mode: 'slate', why: 'no_frames' };
}
// The moment the freshness rules are judged at. The counter is only known as of the last reading (seenAt). When the
// page itself was held up (a long task: no reading and no draw for seconds), the clock ran on while nobody looked, and the
// first draw after it must not take that for a silent feed (a black flash, a false "lost"). So the judgement never runs
// ahead of the last reading by more than one reading period and a bit; the next reading settles what really happened.
// No reading yet (no link, or a link that just started) -> the real time.
export const judgeAt = (now, seenAt, aheadMs = STATS_MS + 250) => (seenAt == null ? now : Math.min(now, seenAt + aheadMs));
// The one word the page reports to the hub.
//   loading   — the engine is not ready yet (whatever the link does)
//   idle      — no link
//   answering — an offer is being answered / the connection is coming up / connected but the first frame is still on its way
//   connected — frames arrive and are shown
//   stalled   — the last frame is held (a short gap), or the phone itself reported its camera away (she left the page,
//               a call came in): the link is fine and the phone brings the camera back by itself
//   lost      — a link exists but no frame for slateMs and no word from the phone why: the slate is shown;
//               also, for LOST_LINGER_MS, a link the page itself has just given up (the reason is in lastError)
export function linkState({ engineReady, hasPc, connectedAt = null, firstFrameAt = null, mode, captureAway = false, lostLinger = false, now, slateMs = SLATE_MS }) {
  if (!engineReady) return 'loading';
  if (!hasPc) return lostLinger ? 'lost' : 'idle';
  if (connectedAt == null) return 'answering';
  if (firstFrameAt == null) return now - connectedAt < slateMs ? 'answering' : 'lost';
  if (mode === 'live') return 'connected';
  if (mode === 'hold' || captureAway) return 'stalled';
  return 'lost';
}

// ---------- a stream the receiver refuses ----------
// Bigger than 1280x720x1.2 pixels, or changing size more than 5 times in 10 s (the first size is not a change).
export const newSizeGuard = () => ({ w: 0, h: 0, changes: [] });
export function noteSize(g, w, h, now, { maxPixels = MAX_PIXELS, churnMax = CHURN_MAX, windowMs = CHURN_WINDOW_MS } = {}) {
  if (!(w > 0) || !(h > 0)) return 'ok';
  if (w * h > maxPixels) return 'too_large';
  if (g.w && (g.w !== w || g.h !== h)) g.changes.push(now);
  g.w = w; g.h = h;
  g.changes = g.changes.filter(t => now - t < windowMs);
  return g.changes.length > churnMax ? 'churn' : 'ok';
}

// ---------- when the answer may be sent (no trickle: the candidates travel inside the SDP) ----------
// The first of: gathering complete · at least one host candidate and quietMs without a new candidate · capMs.
// -> { done, why: 'complete' | 'quiet' | 'cap' | null, waitMs: when to look again }
export function gatherDecision({ complete = false, hostSeen = false, sinceCandidateMs = 0, elapsedMs = 0, quietMs = GATHER_QUIET_MS, capMs = GATHER_CAP_MS } = {}) {
  if (complete) return { done: true, why: 'complete', waitMs: 0 };
  if (hostSeen && sinceCandidateMs >= quietMs) return { done: true, why: 'quiet', waitMs: 0 };
  if (elapsedMs >= capMs) return { done: true, why: 'cap', waitMs: 0 };
  return { done: false, why: null, waitMs: Math.max(1, Math.min(capMs - elapsedMs, hostSeen ? quietMs - sinceCandidateMs : Infinity)) };
}
// An RTCIceCandidate (or its candidate line) of type host. With mDNS the address is a .local name; the type is still host.
export function isHostCandidate(c) {
  if (!c) return false;
  if (typeof c === 'object' && typeof c.type === 'string' && c.type) return c.type === 'host';
  return / typ host(\s|$)/.test(typeof c === 'string' ? c : String(c.candidate || ''));
}

// ---------- SDP ----------
// The hub's rule (spec section 4) plus "at least one m= line": a string of 200..60000 characters starting with v=0,
// at most 3 m= lines and at most 40 a=candidate: lines. -> null when fine, else a short reason (never a part of the SDP).
export function sdpProblem(sdp) {
  if (typeof sdp !== 'string') return 'not_a_string';
  if (sdp.length < SDP_MIN || sdp.length > SDP_MAX) return 'length';
  if (!sdp.startsWith('v=0')) return 'no_v0';
  let m = 0, c = 0;
  for (const line of sdp.split(/\r?\n/)) { if (line.startsWith('m=')) m++; else if (line.startsWith('a=candidate:')) c++; }
  if (m < 1) return 'no_m_line';
  if (m > MAX_M_LINES) return 'too_many_m_lines';
  if (c > MAX_CANDIDATES) return 'too_many_candidates';
  return null;
}
// Our own answer must pass the same rule. A computer with many network adapters can gather more than 40 candidates:
// then the extra ones are left out of what we SEND (TCP ones first: the phone cannot dial them anyway; then the last ones).
// The connection itself still knows all of them, and the phone learns a missing address from the first check that arrives.
export function capCandidates(sdp, max = MAX_CANDIDATES) {
  if (typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n', lines = sdp.split(eol), at = [];
  lines.forEach((line, i) => { if (line.startsWith('a=candidate:')) at.push(i); });
  let over = at.length - max; if (over <= 0) return sdp;
  const drop = new Set(), tcp = i => String(lines[i].split(' ')[2] || '').toLowerCase() === 'tcp';
  for (const i of [...at].reverse()) { if (!over) break; if (tcp(i)) { drop.add(i); over--; } }
  for (const i of [...at].reverse()) { if (!over) break; if (!drop.has(i)) { drop.add(i); over--; } }
  return lines.filter((_, i) => !drop.has(i)).join(eol);
}

// ---------- ICE servers that came with the offer (already checked by the hub; checked again before they reach the browser) ----------
const ICE_URL = /^(stun|turns?):[a-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/;
export function cleanIceServers(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list.slice(0, 8) : []) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && ICE_URL.test(u)).slice(0, 4);
    if (!urls.length) continue;
    const one = { urls };
    if (typeof s.username === 'string' && s.username.length <= 256) one.username = s.username;
    if (typeof s.credential === 'string' && s.credential.length <= 256) one.credential = s.credential;
    out.push(one);
  }
  return out;
}

// ---------- what a poll reply means ----------
// A message of the hub's queue, cleaned. A known type with a broken body, or a type this page does not know, is still
// returned (type 'ignored') so that it gets acknowledged: asking for it again could never repair it. No usable seq -> null.
export function pollMessage(b) {
  if (!b || typeof b !== 'object') return null;
  const seq = typeof b.seq === 'number' ? b.seq : NaN; if (!Number.isSafeInteger(seq) || seq < 0) return null;
  const attempt = validAttempt(b.attempt), ignored = { seq, type: 'ignored' };
  if (b.type === 'offer') return attempt && typeof b.sdp === 'string' ? { seq, type: 'offer', attempt, sdp: b.sdp, iceServers: cleanIceServers(b.iceServers) } : ignored;
  if (b.type === 'stop') return attempt ? { seq, type: 'stop', attempt, reason: ['client_stop', 'replaced', 'expired'].includes(b.reason) ? b.reason : 'stop' } : ignored;
  if (b.type === 'capture') {
    const track = v => (v === 'muted' || v === 'ended' ? v : 'live'); // only an explicit "muted" / "ended" takes the picture away
    return attempt ? { seq, type: 'capture', attempt, video: track(b.video), audio: track(b.audio), visible: b.visible !== false } : ignored;
  }
  return ignored;
}
// A capture message that says the phone's camera is away: its video track is not live, or its page is hidden.
export const cameraAway = m => !!m && (m.video !== 'live' || m.visible === false);
// HTTP status (0 = no reply at all) + parsed body -> what the poll loop does next.
//   message    — 200 with a message          empty      — 204 (the wait ended, or our own newer poll replaced this one)
//   busy       — 409: another page holds the program slot: ask again every 5 s
//   superseded — 410: another page took the slot over: stop for good
//   denied     — 401 / 403: the gateway refuses this page (key, origin): ask again slowly
//   error      — anything else: ask again with a growing pause
export function pollOutcome(status, body) {
  const code = upperSnake(body && body.error);
  if (status === 200) { const message = pollMessage(body); return message ? { kind: 'message', message } : { kind: 'error', code: 'BAD_MESSAGE' }; }
  if (status === 204) return { kind: 'empty' };
  if (status === 409) return { kind: 'busy', code: code || 'PROGRAM_BUSY' };
  if (status === 410) return { kind: 'superseded', code: code || 'PROGRAM_SUPERSEDED' };
  if (status === 401 || status === 403) return { kind: 'denied', code: code || 'FORBIDDEN' };
  return { kind: 'error', code: code || (status ? 'HTTP_' + status : 'UNREACHABLE') };
}

// ---------- reading getStats() ----------
const CAND = new Set(['host', 'srflx', 'prflx', 'relay']), PROTO = new Set(['udp', 'tcp']);
const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
// { local, remote, protocol } with nothing but the candidate TYPES and the protocol (never an address), or null.
export function cleanPath(p) {
  if (!p || typeof p !== 'object') return null;
  const protocol = String(p.protocol || '').toLowerCase();
  return CAND.has(p.local) && CAND.has(p.remote) && PROTO.has(protocol) ? { local: p.local, remote: p.remote, protocol } : null;
}
export const ZERO_STATS = Object.freeze({ hasVideo: false, hasAudio: false, framesDecoded: 0, w: 0, h: 0, fps: 0, freezeCount: 0, jitterMs: 0, kbps: 0, lossPct: 0, rttMs: 0, level: 0, path: null });
// entries: the RTCStats objects of one report (an array). prev: the `next` of the reading before (or null). now: ms.
// Rates (kbps, fps, loss, audio level) are measured between two readings at least 200 ms apart; a reading that comes
// sooner keeps the rates of the one before and does not move the baseline.
export function summarizeStats(entries, prev, now) {
  let v = null, a = null, transport = null; const byId = new Map(), pairs = [];
  for (const s of Array.isArray(entries) ? entries : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.id != null) byId.set(s.id, s);
    const kind = s.kind || s.mediaType;
    if (s.type === 'inbound-rtp' && kind === 'video') { if (!v || fin(s.framesDecoded) > fin(v.framesDecoded)) v = s; }
    else if (s.type === 'inbound-rtp' && kind === 'audio') a = a || s;
    else if (s.type === 'transport') transport = transport || s;
    else if (s.type === 'candidate-pair') pairs.push(s);
  }
  const pair = (transport && byId.get(transport.selectedCandidatePairId)) || pairs.find(p => p.selected) || pairs.find(p => p.nominated && p.state === 'succeeded') || null;
  const local = pair && byId.get(pair.localCandidateId), remote = pair && byId.get(pair.remoteCandidateId);
  const path = cleanPath(local && remote ? { local: local.candidateType, remote: remote.candidateType, protocol: local.protocol || remote.protocol } : null);
  const cur = { at: now, bytes: fin(v && v.bytesReceived) + fin(a && a.bytesReceived), packets: fin(v && v.packetsReceived), lost: fin(v && v.packetsLost), frames: fin(v && v.framesDecoded), energy: fin(a && a.totalAudioEnergy), duration: fin(a && a.totalSamplesDuration) };
  let kbps = 0, fps = fin(v && v.framesPerSecond), lossPct = 0, level = fin(a && a.audioLevel), next = cur;
  const dt = prev ? now - prev.at : 0;
  if (prev && dt >= 200) {
    kbps = Math.max(0, (cur.bytes - prev.bytes) * 8 / dt);
    if (!(v && typeof v.framesPerSecond === 'number')) fps = Math.max(0, (cur.frames - prev.frames) * 1000 / dt);
    const dLost = cur.lost - prev.lost, dAll = cur.packets - prev.packets + dLost; lossPct = dAll > 0 ? Math.min(100, Math.max(0, dLost * 100 / dAll)) : 0;
    const dDur = cur.duration - prev.duration; if (dDur > 0) level = Math.max(level, Math.sqrt(Math.max(0, cur.energy - prev.energy) / dDur));
  } else if (prev) { kbps = fin(prev.kbps); lossPct = fin(prev.lossPct); level = Math.max(level, fin(prev.level)); if (!(v && typeof v.framesPerSecond === 'number')) fps = fin(prev.fps); next = prev; }
  level = Math.min(1, Math.max(0, level));
  if (next === cur) Object.assign(cur, { kbps, fps, lossPct, level });
  return { hasVideo: !!v, hasAudio: !!a, framesDecoded: cur.frames, w: fin(v && v.frameWidth), h: fin(v && v.frameHeight), fps, freezeCount: fin(v && v.freezeCount), jitterMs: fin(v && v.jitter) * 1000, kbps, lossPct, rttMs: fin(pair && pair.currentRoundTripTime) * 1000, level, path, next };
}

// ---------- audio output ----------
// The output device for ?sink=<part of its label> (case does not matter). Windows lists a device up to three times
// ("Default - X", "Communications - X", "X"): the device ITSELF is preferred over the two aliases, so the sound stays on it
// when somebody changes the default device later. No match -> null (the caller stays silent: fail closed).
// A browser that hides device names (no microphone permission for this page) gives empty labels and ids: no match.
export function pickSink(devices, want) {
  const w = String(want || '').trim().toLowerCase(); if (!w) return null;
  const outs = (Array.isArray(devices) ? devices : []).filter(d => d && d.kind === 'audiooutput' && d.deviceId && typeof d.label === 'string' && d.label.toLowerCase().includes(w));
  return outs.find(d => d.deviceId !== 'default' && d.deviceId !== 'communications') || outs[0] || null;
}
export const sinksHidden = devices => { const outs = (Array.isArray(devices) ? devices : []).filter(d => d && d.kind === 'audiooutput'); return outs.length > 0 && outs.every(d => !d.label); };
// What the echo says about the output: null (audio not wanted) · 'default' · 'no_sink' · the device's label, reduced to
// at most 40 characters of [A-Za-z0-9 ._/-].
export function sinkLabel(v) {
  if (v == null) return null;
  return String(v).replace(/[^A-Za-z0-9 ._/-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
}

// ---------- the state echo (POST /api/link/program/state, at most 2 KiB) ----------
// Only the keys of the spec, numbers clamped, words from fixed lists: whatever the page holds, nothing else can leave it here.
// (Two keys more than spec section 5 lists for this body: `lastError`, which the hub takes as the link's last error, and
// `inst`, the per-load value that tells two windows with the same page id apart.)
const STATES = new Set(['loading', 'idle', 'answering', 'connected', 'stalled', 'lost']);
export function stateBody({ program, inst = '', attempt = null, state, showing, stats = {}, hidden = false, audio = {}, path = null, lastError = null } = {}) {
  const s = stats || {}, a = audio || {};
  return {
    program: pageIdFrom(program, '0'),
    inst: String(inst ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
    attempt: validAttempt(attempt),
    state: STATES.has(state) ? state : 'idle',
    showing: showing === 'webrtc' ? 'webrtc' : 'slate',
    stats: {
      w: clampInt(s.w, 0, 8192, 0), h: clampInt(s.h, 0, 8192, 0), fps: clampFixed(s.fps, 0, 240, 1, 0),
      framesDecoded: clampInt(s.framesDecoded, 0, 1e12, 0), freezeCount: clampInt(s.freezeCount, 0, 1e9, 0),
      jitterMs: clampFixed(s.jitterMs, 0, 10000, 1, 0), kbps: clampInt(s.kbps, 0, 100000, 0), rttMs: clampFixed(s.rttMs, 0, 60000, 1, 0),
      lossPct: clampFixed(s.lossPct, 0, 100, 1, 0), rafHz: s.rafHz == null ? null : clampFixed(s.rafHz, 0, 1000, 1, 0), drawHz: s.drawHz == null ? null : clampFixed(s.drawHz, 0, 1000, 1, 0), // null = not measured yet (never "0 = throttled")
      pcCreated: clampInt(s.pcCreated, 0, 1e9, 0), vw: clampInt(s.vw, 0, 20000, 0), vh: clampInt(s.vh, 0, 20000, 0), dpr: clampFixed(s.dpr, 0, 16, 2, 0),
    },
    hidden: !!hidden,
    audio: { wanted: !!a.wanted, playing: !!a.playing, level: clampFixed(a.level, 0, 1, 3, 0), sink: sinkLabel(a.sink) },
    path: cleanPath(path),
    lastError: upperSnake(lastError),
  };
}
