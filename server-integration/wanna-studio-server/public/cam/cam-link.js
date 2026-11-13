// CAM LINK v1 — the phone side (spec section 8).
//
// One tap takes camera + microphone and sends them peer-to-peer (WebRTC) to the program page on the studio PC.
// The gateway only relays signalling:
//   GET    /api/link/status?attempt=<id>        iceServers, program online/ready/throttled, the program's echo, air
//   POST   /api/link/whip                       application/sdp offer -> 201 + application/sdp answer (WHIP-shaped)
//   POST   /api/link/state                      capture state + sender stats (JSON)
//   DELETE /api/link/whip/<attempt>             stop;  POST /api/link/whip/<attempt>/bye  on pagehide (keepalive)
//
// Framework-free ES module with NO DOM access at import. Everything environmental is injected into CamLink
// (fetch, PeerConnection, mediaDevices, RtpSender, now, timers, wakeLock, document, window), so
// test/cam-client.test.mjs drives the whole state machine with fakes under node --test.
// The page UI (mountCamPage) starts only when the script URL carries ?ui=1 — see the last line of this file.
//
// Ideas reused from the LAB's camera-uplink.mjs: H.264 preference by SORTING the capability list (never filtering),
// bounded ICE gathering, stale-attempt cleanup (an attempt that lost its turn closes itself and deletes its late
// resource) and dependency injection. Three rules this file must never break:
//   1. a failed control call (status/state: network, 401, 5xx) NEVER stops media;
//   2. recovery is make-before-break on a NEW RTCPeerConnection with a new attempt id (no ICE restart);
//   3. the pill says what the program page reports (its echo), not what connectionState says.

export const VERSION = '1.3.0';

export const TIMING = Object.freeze({
  retryDelaysMs: Object.freeze([0, 1000, 2000, 4000, 8000, 15000, 30000]), // attempt n of a streak waits this long (cap 30 s)
  gatherQuietMs: 300,        // gather-done: a host candidate seen and this long without a new candidate
  gatherMaxMs: 2000,         // gather-done: hard cap
  connectDeadlineMs: 10000,  // 'connected' within this long of setRemoteDescription(answer), else no_path
  offlinePollMs: 3000,       // program_offline: look again this often and re-offer when the program is online
  statusMs: 1000,            // heartbeat: GET status
  stateEveryTicks: 2,        // heartbeat: POST state every 2nd tick (2000 ms) and on every change
  disconnectGraceMs: 4000,   // 'disconnected' this long -> recover
  echoStaleMs: 5000,         // program echo older than this while the program is online -> recover
  flatMs: 5000,              // outbound bytesSent flat this long -> recover
  notMineGraceMs: 3000,      // status says "not mine" this long -> recover (a restarted gateway re-adopts within ~1 s)
  stableMs: 10000,           // a link that lived this long restarts the delays at 0
  muteGraceMs: 1000,         // a track muted this long while the page is visible -> re-acquire it
  reacquireMaxMs: 15000,     // cap for re-acquire retries
  controlLostMs: 3000,       // no good status for this long -> "no control link" pill (media keeps flowing)
  echoFreshMs: 3000,         // green pill only on an echo younger than this
  levelSeenMs: 5000,         // ...and an audio level seen within this long (when the program plays audio)
  airFreshMs: 5000,          // the "on air" badge needs a status this young
  whipTimeoutMs: 12000,      // the gateway parks the offer up to 8 s
  controlTimeoutMs: 4000,
});

export const LEVEL_SEEN_MIN = 0.001; // an audio level above this counts as "sound arrived" (digital silence is exactly 0)
const MIN_FPS = 15;
const KINDS = ['video', 'audio'];
const CODE = /^[A-Z0-9_]{1,40}$/;
const RESOURCE = /^\/api\/link\/whip\/[A-Za-z0-9_-]{1,100}$/;
const START_FROM = ['idle', 'stopped', 'denied', 'busy_camera', 'replaced', 'unpaired'];
const DENIED = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'];
const PATH_KIND = ['host', 'srflx', 'prflx', 'relay'], PATH_PROTO = ['udp', 'tcp'];
const LINK_STATES = ['idle', 'negotiating', 'connected', 'stalled', 'lost'];

// Every creator-facing string, exactly as written in the spec (Hebrew, addressed to a woman).
export const TEXT = Object.freeze({
  title: 'עלי לשידור',
  start: 'חברי מצלמה ומיקרופון',
  before: 'הטלפון יבקש אישור למצלמה ולמיקרופון',
  checklist: Object.freeze(['Wi‑Fi', 'מטען בכבל', 'נא לא להפריע', 'טלפון לאורך']),
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

// States that have no camera running show a card with this text (and one action).
export const NOTICE = Object.freeze({ denied: TEXT.denied, busy_camera: TEXT.busyCamera, replaced: TEXT.replaced, unpaired: TEXT.unpaired });

const fail = (code, extra) => Object.assign(new Error(code), { code }, extra);
// our own errors carry an UPPER_SNAKE string code; a DOMException's numeric legacy code is not one
const codeOf = (e, fallback) => (typeof e?.code === 'string' && CODE.test(e.code) ? e.code : fallback);
// 'NotAllowedError' -> 'NOT_ALLOWED_ERROR' (for the diagnostics panel)
const snake = name => String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '').toUpperCase().slice(0, 40);
const emit = (fn, ...args) => { try { fn?.(...args); } catch { /* a UI callback must never break the media state machine */ } };
const clampNum = (v, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(0, v)) : 0; };
const whole = (v, hi = 1e7) => Math.round(clampNum(v, hi));
// strings in POST /api/link/state: at most 40 chars from [A-Za-z0-9 ._/-]
const label = v => String(v ?? '').replace(/[^A-Za-z0-9 ._/-]+/g, ' ').replace(/ +/g, ' ').trim().slice(0, 40);

function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for the tests)
// ---------------------------------------------------------------------------------------------------------------

/** Embed-ready seam: the headers every request carries. Returns {} today (a bearer ticket later). */
export function linkHeaders() { return {}; }

export const videoConstraints = () => ({ facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
/** Default = natural room sound (no echo canceller / noise gate); voice = the call profile for noisy rooms (?voice=1). */
export const audioConstraints = voice => voice
  ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  : { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 };

/** The capability list with the wanted codec first. Sorted, never filtered (RTX/RED/FEC stay). null = the device does not list it. */
export function sortCodecs(codecs, want = 'h264') {
  const list = Array.isArray(codecs) ? codecs : [];
  const mime = want === 'vp8' ? 'video/vp8' : 'video/h264';
  const wanted = c => String(c?.mimeType || '').toLowerCase() === mime;
  const first = list.filter(wanted);
  if (!first.length) return null;
  // among H.264 entries: constrained baseline with packetization-mode=1 first (what every hardware encoder has)
  const baseline = c => /packetization-mode=1/.test(c.sdpFmtpLine || '') && /profile-level-id=42e0/i.test(c.sdpFmtpLine || '');
  const head = mime === 'video/h264' ? [...first.filter(baseline), ...first.filter(c => !baseline(c))] : first;
  return [...head, ...list.filter(c => !wanted(c))];
}

/** Adds x-google-start-bitrate to the fmtp of the negotiated video payload type (a new fmtp line if it has none). */
export function mungeAnswer(sdp, startKbps = 2000) {
  if (typeof sdp !== 'string' || !sdp) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n', lines = sdp.split(/\r?\n/);
  const start = lines.findIndex(l => /^m=video /.test(l));
  if (start < 0) return sdp;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('m='));
  if (end < 0) end = lines.length;
  const m = lines[start].split(' '); // m=video <port> <proto> <payload types…>
  if (m[1] === '0') return sdp; // rejected section
  const inSection = (prefix, from = start) => lines.findIndex((l, i) => i > from && i < end && l.startsWith(prefix));
  const codecName = pt => { const at = inSection('a=rtpmap:' + pt + ' '); return at < 0 ? '' : lines[at].slice(lines[at].indexOf(' ') + 1).split('/')[0].toLowerCase(); };
  // the answer lists what the receiver accepts in order: the first real codec (not a repair/FEC format) is the one we will send
  const pt = m.slice(3).find(p => { const n = codecName(p); return n && !['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(n); });
  if (!pt) return sdp;
  const param = 'x-google-start-bitrate=' + startKbps, fmtp = inSection('a=fmtp:' + pt + ' ');
  if (fmtp >= 0) { if (!/x-google-start-bitrate=/.test(lines[fmtp])) lines[fmtp] += ';' + param; }
  else lines.splice(inSection('a=rtpmap:' + pt + ' ') + 1, 0, 'a=fmtp:' + pt + ' ' + param);
  return lines.join(eol);
}

/** The hub takes at most 40 a=candidate lines. A phone never gets near that; if it does, TCP candidates go first, then the tail. */
export function limitCandidates(sdp, max = 40) {
  if (typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n', lines = sdp.split(/\r?\n/);
  const candidate = line => line.startsWith('a=candidate:');
  let over = lines.filter(candidate).length - max;
  if (over <= 0) return sdp;
  const drop = new Set();
  const take = test => { for (let i = lines.length - 1; i >= 0 && over > 0; i--) if (candidate(lines[i]) && !drop.has(i) && test(lines[i])) { drop.add(i); over--; } };
  take(line => / tcp /i.test(line));
  take(() => true);
  return lines.filter((_, i) => !drop.has(i)).join(eol);
}

function cleanIceServers(value) {
  if (!Array.isArray(value)) return [];
  const ok = u => typeof u === 'string' && /^(stun|turns?):[a-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/i.test(u);
  const out = [];
  for (const entry of value.slice(0, 4)) {
    const urls = (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls]).filter(ok);
    if (!urls.length) continue;
    const one = { urls };
    if (typeof entry.username === 'string') one.username = entry.username;
    if (typeof entry.credential === 'string') one.credential = entry.credential;
    out.push(one);
  }
  return out;
}

/** GET /api/link/status -> a strict shape: booleans, clamped numbers, enumerated strings. Nothing free-form survives. */
export function normalizeStatus(json) {
  const o = json && typeof json === 'object' ? json : {};
  const p = o.program || {}, l = o.link || {}, s = l.stats || {}, a = l.audio || {}, path = l.path, air = o.air || {};
  return {
    version: typeof o.version === 'string' ? label(o.version).slice(0, 20) : '',
    serverTime: clampNum(o.serverTime, 1e14),
    iceServers: cleanIceServers(o.iceServers),
    program: { online: p.online === true, ready: p.ready === true, throttled: p.throttled === true },
    link: {
      state: LINK_STATES.includes(l.state) ? l.state : 'idle',
      mine: l.mine === true,
      since: clampNum(l.since, 1e14),
      echoAgeMs: l.echoAgeMs === null || l.echoAgeMs === undefined ? null : clampNum(l.echoAgeMs, 1e9),
      stats: { w: whole(s.w, 1e5), h: whole(s.h, 1e5), fps: clampNum(s.fps, 1000), kbps: whole(s.kbps, 1e6), rttMs: whole(s.rttMs, 1e5), lossPct: clampNum(s.lossPct, 100) },
      audio: { wanted: a.wanted === true, playing: a.playing === true, level: clampNum(a.level, 1) },
      path: path && PATH_KIND.includes(path.local) && PATH_KIND.includes(path.remote) && PATH_PROTO.includes(path.protocol)
        ? { local: path.local, remote: path.remote, protocol: path.protocol } : null,
      lastError: typeof l.lastError === 'string' && CODE.test(l.lastError) ? l.lastError : null,
    },
    air: { known: air.known === true, live: air.live === true },
  };
}

/** One RTCStatsReport of the sender -> the few numbers the page and the hub care about. */
export function readStats(report) {
  const out = { outbound: 0, bytes: 0, w: 0, h: 0, fps: 0, limit: '', encoder: '', codec: '', rttMs: 0, lossPct: 0, path: null };
  if (!report?.forEach) return out;
  let video = null, pairId = null;
  const pairs = [];
  report.forEach(st => {
    const kind = st.kind || st.mediaType;
    if (st.type === 'outbound-rtp') {
      out.outbound++;
      out.bytes += Number(st.bytesSent) || 0;
      if (kind === 'video' && (!video || (st.bytesSent || 0) > (video.bytesSent || 0))) video = st;
    } else if (st.type === 'remote-inbound-rtp' && kind === 'video') {
      if (Number.isFinite(st.roundTripTime)) out.rttMs = Math.round(st.roundTripTime * 1000);
      if (Number.isFinite(st.fractionLost)) out.lossPct = Math.round(st.fractionLost * 1000) / 10;
    } else if (st.type === 'transport' && st.selectedCandidatePairId) pairId = st.selectedCandidatePairId;
    else if (st.type === 'candidate-pair') pairs.push(st);
  });
  if (video) {
    out.w = whole(video.frameWidth, 1e5); out.h = whole(video.frameHeight, 1e5); out.fps = whole(video.framesPerSecond, 1000);
    out.limit = label(video.qualityLimitationReason); out.encoder = label(video.encoderImplementation);
    out.codec = label(report.get?.(video.codecId)?.mimeType);
  }
  const pair = pairs.find(x => x.id === pairId) || pairs.find(x => x.selected) || pairs.find(x => x.nominated && x.state === 'succeeded');
  if (pair) {
    if (!out.rttMs && Number.isFinite(pair.currentRoundTripTime)) out.rttMs = Math.round(pair.currentRoundTripTime * 1000);
    const local = report.get?.(pair.localCandidateId), remote = report.get?.(pair.remoteCandidateId);
    if (local && remote && PATH_KIND.includes(local.candidateType) && PATH_KIND.includes(remote.candidateType)) {
      out.path = { local: local.candidateType, remote: remote.candidateType, protocol: PATH_PROTO.includes(local.protocol) ? local.protocol : 'udp' };
    }
  }
  return out;
}

/**
 * The truthful pill. Green only on what the PROGRAM reports: a fresh echo, enough frames and (when it plays audio)
 * sound that is playing with a level seen lately. tone: idle | busy | ok | warn | bad.
 */
export function derivePill({ state, status = null, control = 'ok', levelFresh = false, airFresh = true } = {}) {
  // the "on air" badge is a second, independent truth: TikTok is live (from the gateway's real event connection)
  const pill = (tone, text, sub = '') => ({ tone, text, sub, air: airFresh && status?.air?.live === true });
  switch (state) {
    case 'offering': case 'connecting': return pill('busy', TEXT.connecting);
    case 'recovering': case 'interrupted': return pill('warn', TEXT.reconnecting);
    case 'program_offline': return pill('warn', TEXT.programOffline);
    case 'no_path': return pill('bad', TEXT.noPath);
    case 'server_unreachable': return pill('bad', TEXT.serverUnreachable);
    case 'live': break;
    default: return pill('idle', '');
  }
  if (control !== 'ok' || !status) return pill('warn', TEXT.controlLost);
  if (status.program.throttled) return pill('warn', TEXT.throttled);
  const link = status.link;
  // "connected" is the program's own word: its engine is ready and frames are being shown (while it still loads, the
  // hub says "negotiating" although packets already arrive)
  const seen = link.state === 'connected' && link.mine && link.echoAgeMs !== null && link.echoAgeMs < TIMING.echoFreshMs && link.stats.fps >= MIN_FPS;
  if (!seen) return pill('busy', TEXT.connecting);
  if (!link.audio.wanted) return pill('ok', TEXT.seen, TEXT.audioOffTest);
  return link.audio.playing && levelFresh ? pill('ok', TEXT.seenHeard) : pill('warn', TEXT.seenNotHeard);
}

async function tuneSender(sender, kind) {
  try {
    if (!sender?.getParameters || !sender.setParameters) return;
    const p = sender.getParameters(); // get -> change -> set with no await in between (the transaction id is short-lived)
    if (!p.encodings?.length) p.encodings = [{}];
    if (kind === 'video') { p.encodings[0].maxBitrate = 2500000; p.encodings[0].maxFramerate = 30; p.degradationPreference = 'maintain-framerate'; }
    else p.encodings[0].maxBitrate = 96000;
    await sender.setParameters(p);
  } catch { /* tuning is optional: the link works without it, and it is applied again after the answer */ }
}

async function whipFailure(res) {
  let code = '';
  try { code = String((await res.json())?.error || ''); } catch { /* not JSON: a proxy error page */ }
  if (!CODE.test(code)) code = 'WHIP_HTTP_' + res.status;
  const kind = res.status === 401 ? 'unpaired'
    : res.status === 409 && (code === 'LINK_REPLACED' || code === 'REPLACED') ? 'replaced'
      : res.status === 503 && code === 'PROGRAM_OFFLINE' ? 'offline'
        : res.status === 504 && code === 'PROGRAM_TIMEOUT' ? 'timeout'
          : res.status >= 500 ? 'unreachable' : 'error';
  return fail(code, { kind });
}

// ---------------------------------------------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------------------------------------------
// state: idle -> acquiring -> offering -> connecting -> live -> (recovering | interrupted) -> live | stopped
//        plus program_offline, no_path, replaced, denied, busy_camera, server_unreachable and unpaired (401).
// A failure state is sticky while the retries run behind it, so she can read what is wrong.

export class CamLink {
  constructor(options = {}) {
    const g = globalThis, pick = (value, fallback) => (value !== undefined ? value : fallback);
    this.fetch = options.fetch || (typeof g.fetch === 'function' ? g.fetch.bind(g) : null);
    this.PeerConnection = pick(options.PeerConnection, g.RTCPeerConnection);
    this.mediaDevices = pick(options.mediaDevices, g.navigator?.mediaDevices);
    this.RtpSender = pick(options.RtpSender, g.RTCRtpSender);
    this.RtpReceiver = pick(options.RtpReceiver, g.RTCRtpReceiver);
    this.now = options.now || (() => Date.now());
    this.timers = options.timers || { setTimeout: (fn, ms) => g.setTimeout(fn, ms), clearTimeout: h => g.clearTimeout(h) };
    this.wakeLock = pick(options.wakeLock, g.navigator?.wakeLock);
    this.document = pick(options.document, g.document);
    this.window = pick(options.window, g.window);
    this.parent = options.parent || null; // window.parent when framed (embed-ready seam)
    this.headers = options.headers || linkHeaders;
    this.randomId = options.randomId || uuid;
    this.onState = options.onState;
    this.onPreview = options.onPreview;
    this.base = String(options.base || '');
    this.voice = options.voice === true;
    this.codec = options.codec === 'vp8' ? 'vp8' : 'h264';

    this.clientId = this.randomId(); // X-Link-Client: one per page load
    this.phase = 'idle';
    this.error = null;
    this.halted = true; // nothing runs until a tap
    this.epoch = 0;
    this.stream = null;
    this.tracks = { video: null, audio: null };
    this.unwatch = { video: null, audio: null };
    this.mutedSince = { video: null, audio: null };
    this.micMuted = false;
    this.current = null; // the connected session that carries media
    this.pending = null; // the attempt being negotiated
    this.recovery = null;
    this.takeover = false;
    this.waitVisible = false;
    this.streak = 0;
    this.attempts = 0;
    this.status = null;
    this.lastStatusOkAt = 0;
    this.levelSeenAt = null;
    this.stats = { w: 0, h: 0, fps: 0, kbps: 0, rttMs: 0, lossPct: 0, codec: '', encoder: '', limit: '', path: null };
    this.ticks = 0;
    this.statusBusy = false;
    this.stateBusy = false;
    this.stateAgain = false;
    this.reportedKey = '';
    this.reacquiring = false;
    this.cure = { video: 0, audio: 0 }; // re-acquires in a row that did not bring a healthy track back
    this.notBefore = { video: 0, audio: 0 }; // ...and the earliest time for the next one
    this.wake = 'idle'; // idle | held | released | rejected | unsupported
    this.sentinel = null;
    this.wakeBusy = false;
    this.lastState = 'idle';
    this.t = new Map(); // named timers
    this.inflight = new Set();
    this.unbinders = [];
    this.resetLinkHealth();
    this.bind();
  }

  // ---- public API --------------------------------------------------------------------------------------------

  get state() { return this.phase === 'live' && this.isInterrupted() ? 'interrupted' : this.phase; }

  snapshot() {
    const state = this.state, now = this.now();
    const control = this.current && now - this.lastStatusOkAt > TIMING.controlLostMs ? 'lost' : 'ok';
    const levelFresh = this.levelSeenAt !== null && now - this.levelSeenAt <= TIMING.levelSeenMs;
    const airFresh = !this.halted && now - this.lastStatusOkAt <= TIMING.airFreshMs; // never a stale "on air"
    return {
      state,
      error: this.error,
      attempts: this.attempts,
      attempt: (this.pending?.answered ? this.pending : this.current)?.id || null,
      tracksLive: this.hasTracks(),
      micMuted: this.micMuted,
      wakeLock: this.wake,
      visible: this.isVisible(),
      capture: this.capture(),
      control,
      status: this.status,
      stats: { ...this.stats },
      pcState: this.current?.pc?.connectionState || this.pending?.pc?.connectionState || '',
      pill: derivePill({ state, status: this.status, control, levelFresh, airFresh }),
    };
  }

  /** The tap. takeover = "bring it back here" (sent as X-Link-Takeover: 1 on the first offer of this tap only). */
  async start({ takeover = false } = {}) {
    if (!START_FROM.includes(this.phase) || this.hasTracks()) return this.snapshot();
    const epoch = ++this.epoch;
    this.halted = false; this.error = null; this.streak = 0; this.takeover = takeover === true; this.waitVisible = false;
    this.setPhase('acquiring');
    this.requestWakeLock(); // inside the tap, before any await
    let stream;
    try {
      if (!this.mediaDevices?.getUserMedia) throw Object.assign(fail('CAMERA_UNSUPPORTED'), { name: 'NotAllowedError' }); // insecure context or a very old browser
      stream = await this.mediaDevices.getUserMedia({ video: videoConstraints(), audio: audioConstraints(this.voice) }); // ONE prompt for both
    } catch (e) {
      if (epoch !== this.epoch) return this.snapshot();
      return this.refuse(DENIED.includes(e?.name) ? 'denied' : 'busy_camera', codeOf(e, snake(e?.name) || 'CAMERA_FAILED'));
    }
    const stopAll = () => { for (const track of stream?.getTracks?.() || []) { try { track.stop(); } catch { /* already ended */ } } };
    if (epoch !== this.epoch) { stopAll(); return this.snapshot(); } // stop was pressed while the prompt was open
    const video = stream.getVideoTracks?.()[0] || null, audio = stream.getAudioTracks?.()[0] || null;
    if (!video) { stopAll(); return this.refuse('busy_camera', 'CAMERA_NO_VIDEO'); }
    this.stream = stream;
    this.adopt('video', video);
    if (audio) this.adopt('audio', audio);
    emit(this.onPreview, video); // the raw track, mirrored by CSS only
    this.setPhase('offering');
    this.scheduleAttempt(); // an offer is created only after getUserMedia (real host candidates need the permission)
    return this.snapshot();
  }

  /** Stop: every track is released at once (indicators off well within 1 s), then the attempt is deleted at the hub. */
  async stop() {
    if (this.phase === 'idle' || this.phase === 'stopped') return this.snapshot();
    const target = this.pending?.posted ? this.pending : this.current; // the newest attempt the hub knows
    const resource = target ? target.location || '/api/link/whip/' + target.id : null;
    this.halt();
    this.error = null;
    this.setPhase('stopped');
    if (resource) await this.control(resource, { method: 'DELETE' });
    return this.snapshot();
  }

  /** Try again now instead of waiting for the next delay. */
  retry() {
    if (this.halted || this.pending || !this.tracks.video) return;
    this.cancel('retry');
    this.streak = 0;
    this.scheduleAttempt();
  }

  setMicMuted(muted) {
    this.micMuted = muted === true;
    if (this.tracks.audio) this.tracks.audio.enabled = !this.micMuted; // mute = track.enabled=false, nothing is renegotiated
    this.captureChanged();
    return this.micMuted;
  }
  toggleMic() { return this.setMicMuted(!this.micMuted); }

  /** Before any tap: is this phone paired? (No camera involved; 401 shows the pairing notice instead of a useless prompt.) */
  async preflight() {
    if (!['idle', 'stopped', 'unpaired'].includes(this.phase) || this.hasTracks()) return this.snapshot();
    try {
      await this.fetchStatus(null);
      if (this.phase === 'unpaired' && !this.hasTracks()) { this.error = null; this.phase = 'idle'; }
    } catch (e) {
      if (e.kind === 'unpaired' && ['idle', 'stopped'].includes(this.phase)) { this.error = e.code; this.phase = 'unpaired'; }
    }
    this.update();
    return this.snapshot();
  }

  destroy() { for (const off of this.unbinders.splice(0)) off(); }

  // ---- environment -------------------------------------------------------------------------------------------

  bind() {
    const on = (target, type, fn) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, fn);
      this.unbinders.push(() => target.removeEventListener?.(type, fn));
    };
    on(this.document, 'visibilitychange', () => { if (this.isVisible()) this.onReturn(); this.captureChanged(); });
    on(this.window, 'pageshow', () => { this.onReturn(); this.captureChanged(); });
    on(this.window, 'pagehide', () => this.onPageHide());
    on(this.mediaDevices, 'devicechange', () => this.evaluateCapture());
  }

  isVisible() { return !this.document || this.document.visibilityState !== 'hidden'; }
  hasTracks() { return KINDS.some(k => this.tracks[k] && this.tracks[k].readyState !== 'ended'); }

  after(name, ms, fn) {
    this.cancel(name);
    this.t.set(name, this.timers.setTimeout(() => { this.t.delete(name); fn(); }, ms));
  }
  cancel(name) {
    if (!this.t.has(name)) return;
    this.timers.clearTimeout(this.t.get(name));
    this.t.delete(name);
  }

  requestHeaders(extra) {
    let seam = {};
    try { seam = this.headers() || {}; } catch { /* the seam must not break a request */ }
    return { ...seam, 'X-Link-Client': this.clientId, ...extra };
  }

  /** One request with a time limit on the injected timers. Rejects on network failure, timeout or abort. */
  async http(path, init = {}, timeoutMs = TIMING.controlTimeoutMs) {
    if (!this.fetch) throw fail('FETCH_UNSUPPORTED');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let giveUp;
    const gate = new Promise((_, reject) => { giveUp = code => { try { ac?.abort(); } catch { /* nothing to abort */ } reject(fail(code)); }; });
    gate.catch(() => {});
    const entry = { abort: () => giveUp('REQUEST_ABORTED') };
    this.inflight.add(entry);
    const timer = this.timers.setTimeout(() => giveUp('REQUEST_TIMEOUT'), timeoutMs);
    const request = Promise.resolve().then(() => this.fetch(this.base + path, {
      cache: 'no-store', credentials: 'same-origin', redirect: 'error', ...init,
      headers: this.requestHeaders(init.headers), ...(ac ? { signal: ac.signal } : {}),
    }));
    request.catch(() => {});
    try { return await Promise.race([request, gate]); }
    finally { this.timers.clearTimeout(timer); this.inflight.delete(entry); }
  }

  /** A control call that may fail: it never throws and never touches media. */
  async control(path, init) {
    try { return await this.http(path, init); } catch { return null; }
  }

  async fetchStatus(attempt) {
    let res;
    try { res = await this.http('/api/link/status' + (attempt ? '?attempt=' + encodeURIComponent(attempt) : ''), { method: 'GET', headers: { Accept: 'application/json' } }); }
    catch { throw fail('STATUS_UNREACHABLE', { kind: 'unreachable' }); }
    if (res.status === 401) throw fail('PAIRING_REQUIRED', { kind: 'unpaired' });
    if (!res.ok) throw fail('STATUS_HTTP_' + res.status, { kind: 'unreachable' });
    let body;
    try { body = await res.json(); } catch { throw fail('STATUS_INVALID', { kind: 'unreachable' }); }
    const status = normalizeStatus(body), now = this.now();
    this.status = status;
    this.lastStatusOkAt = now;
    if (status.link.mine && status.link.audio.level >= LEVEL_SEEN_MIN) this.levelSeenAt = now;
    return status;
  }

  // ---- wake lock ---------------------------------------------------------------------------------------------

  requestWakeLock() {
    if (!this.wakeLock?.request) { this.wake = 'unsupported'; return; }
    if (this.wakeBusy || (this.sentinel && !this.sentinel.released)) return;
    let asked;
    try { asked = this.wakeLock.request('screen'); } catch { this.wake = 'rejected'; return; }
    this.wakeBusy = true;
    const epoch = this.epoch;
    Promise.resolve(asked).then(sentinel => {
      this.wakeBusy = false;
      if (this.halted || epoch !== this.epoch) { // it answered for a session that is over
        try { void Promise.resolve(sentinel?.release?.()).catch(() => {}); } catch { /* gone */ }
        if (!this.halted && this.hasTracks()) this.requestWakeLock(); // ...and a new one is already running
        return;
      }
      this.sentinel = sentinel; this.wake = 'held';
      sentinel?.addEventListener?.('release', () => { // the browser drops it when the page is hidden; asked again on return
        if (this.sentinel !== sentinel) return;
        this.sentinel = null;
        if (this.wake === 'held') this.wake = 'released';
        this.update();
      });
      this.update();
    }, () => { this.wakeBusy = false; if (epoch === this.epoch) { this.wake = 'rejected'; this.update(); } });
  }

  releaseWakeLock() {
    const sentinel = this.sentinel;
    this.sentinel = null; this.wake = 'idle';
    try { void Promise.resolve(sentinel?.release?.()).catch(() => {}); } catch { /* already released */ }
  }

  // ---- tracks and interruptions ------------------------------------------------------------------------------

  adopt(kind, track) {
    this.unwatch[kind]?.();
    this.tracks[kind] = track;
    this.mutedSince[kind] = track.muted ? this.now() : null;
    if (kind === 'audio') track.enabled = !this.micMuted;
    const handlers = { ended: () => this.onTrack(kind, track, 'ended'), mute: () => this.onTrack(kind, track, 'mute'), unmute: () => this.onTrack(kind, track, 'unmute') };
    for (const type of Object.keys(handlers)) track.addEventListener?.(type, handlers[type]);
    this.unwatch[kind] = () => { for (const type of Object.keys(handlers)) track.removeEventListener?.(type, handlers[type]); };
  }

  onTrack(kind, track, type) {
    if (this.tracks[kind] !== track) return;
    if (type === 'mute') this.mutedSince[kind] ??= this.now();
    if (type === 'unmute') this.mutedSince[kind] = null;
    this.captureChanged();
  }

  /** What POST /api/link/state reports. A microphone she muted herself is reported as muted too (it is). */
  capture() {
    const of = (track, userMuted) => (!track || track.readyState === 'ended' ? 'ended' : track.muted || userMuted ? 'muted' : 'live');
    return { video: of(this.tracks.video, false), audio: of(this.tracks.audio, this.micMuted), visible: this.isVisible() };
  }

  isInterrupted() {
    const broken = track => Boolean(track) && (track.readyState === 'ended' || track.muted === true);
    return !this.isVisible() || !this.tracks.video || broken(this.tracks.video) || broken(this.tracks.audio);
  }

  captureChanged() {
    if (this.halted) { this.update(); return; }
    const c = this.capture();
    if (c.video + '|' + c.audio + '|' + c.visible !== this.reportedKey) void this.postState(); // every change is reported
    this.evaluateCapture();
    this.update();
  }

  onReturn() { // visibilitychange -> visible, or pageshow
    if (this.halted) { if (this.phase === 'unpaired') void this.preflight(); return; }
    if (this.hasTracks()) this.requestWakeLock(); // asked again on every return
    const now = this.now();
    for (const k of KINDS) if (this.tracks[k]?.muted) this.mutedSince[k] = now; // give the browser a second to unmute by itself
    if (this.waitVisible) { this.waitVisible = false; this.cancel('retry'); this.streak = 0; this.scheduleAttempt(); }
  }

  /** Page visible and a track ended, or muted for more than 1 s: take that kind again and swap it in (no renegotiation). */
  evaluateCapture() {
    if (this.halted || !this.tracks.video || !this.isVisible()) return;
    const now = this.now(), need = [];
    let wait = Infinity;
    for (const kind of KINDS) {
      const track = this.tracks[kind];
      if (!track) continue;
      const ended = track.readyState === 'ended';
      if (!ended && !track.muted) { this.mutedSince[kind] = null; this.cure[kind] = 0; this.notBefore[kind] = 0; continue; }
      const graceEnd = ended ? 0 : (this.mutedSince[kind] ??= now) + TIMING.muteGraceMs;
      const due = Math.max(graceEnd, this.notBefore[kind]); // a re-acquire that did not help is not repeated at once
      if (now >= due) need.push(kind); else wait = Math.min(wait, due - now);
    }
    if (need.length) void this.reacquire(need);
    else if (wait !== Infinity) this.after('capture', wait, () => this.evaluateCapture());
    else this.cancel('capture');
  }

  async reacquire(kinds) {
    if (this.reacquiring || !this.mediaDevices?.getUserMedia) return;
    this.reacquiring = true;
    this.cancel('capture');
    const epoch = this.epoch;
    try {
      const constraints = {};
      if (kinds.includes('video')) constraints.video = videoConstraints();
      if (kinds.includes('audio')) constraints.audio = audioConstraints(this.voice);
      const fresh = await this.mediaDevices.getUserMedia(constraints); // that kind only; a healthy kind is never asked again
      if (epoch !== this.epoch || this.halted) { for (const track of fresh.getTracks?.() || []) { try { track.stop(); } catch { /* ended */ } } return; }
      for (const kind of kinds) {
        const next = (kind === 'video' ? fresh.getVideoTracks?.() : fresh.getAudioTracks?.())?.[0], old = this.tracks[kind];
        if (!next) continue;
        for (const session of [this.current, this.pending]) {
          if (session && !session.closed) { try { await session.senders[kind]?.replaceTrack(next); } catch { /* that connection is going away anyway */ } }
        }
        try { this.stream?.removeTrack?.(old); this.stream?.addTrack?.(next); } catch { /* keeping the stream tidy is optional */ }
        this.adopt(kind, next);
        try { old?.stop(); } catch { /* already ended */ }
        if (kind === 'video') emit(this.onPreview, next);
      }
    } catch { /* another app may still hold the camera: evaluateCapture() looks again after the delay below */ }
    finally { this.reacquiring = false; }
    if (epoch !== this.epoch || this.halted) return;
    // 1, 2, 4, 8, 15 s between tries for as long as that kind stays broken (a healthy track resets it)
    const now = this.now();
    for (const kind of kinds) this.notBefore[kind] = now + Math.min(TIMING.reacquireMaxMs, 1000 * 2 ** this.cure[kind]++);
    this.captureChanged();
  }

  // ---- attempts ----------------------------------------------------------------------------------------------

  setPhase(phase) { this.phase = phase; this.update(); }

  update() {
    const snap = this.snapshot();
    if (snap.state !== this.lastState) {
      this.lastState = snap.state;
      // embed-ready seam: tell a framing page the state (nothing secret, so any parent origin may read it)
      try { this.parent?.postMessage({ type: 'cam-link', state: snap.state }, '*'); } catch { /* no parent */ }
    }
    emit(this.onState, snap);
  }

  resetLinkHealth() {
    this.liveSince = 0; this.notMineSince = null; this.echoNullSince = null;
    this.flatSince = null; this.lastBytes = null; this.lastStatsAt = 0;
  }

  refuse(phase, code) { // no camera: nothing to keep
    this.halt();
    this.error = code;
    this.setPhase(phase);
    return this.snapshot();
  }

  /** Everything off: timers, requests, connections, tracks, wake lock. Nothing is sent to the hub from here. */
  halt() {
    ++this.epoch;
    this.halted = true;
    for (const handle of this.t.values()) this.timers.clearTimeout(handle);
    this.t.clear();
    for (const entry of [...this.inflight]) entry.abort();
    const sessions = [this.pending, this.current];
    this.pending = null; this.current = null; this.recovery = null; this.takeover = false; this.waitVisible = false;
    for (const session of sessions) this.dropSession(session, false);
    for (const kind of KINDS) {
      this.unwatch[kind]?.(); this.unwatch[kind] = null;
      try { this.tracks[kind]?.stop(); } catch { /* already ended */ }
      this.tracks[kind] = null; this.mutedSince[kind] = null; this.cure[kind] = 0; this.notBefore[kind] = 0;
    }
    this.stream = null;
    this.reportedKey = '';
    this.releaseWakeLock();
    this.resetLinkHealth();
    emit(this.onPreview, null);
  }

  scheduleAttempt() {
    if (this.halted || this.pending || this.t.has('retry')) return;
    const delays = TIMING.retryDelaysMs, wait = delays[Math.min(this.streak, delays.length - 1)];
    this.streak++;
    if (wait === 0) void this.attempt(); else this.after('retry', wait, () => void this.attempt());
  }

  async attempt() {
    if (this.halted || this.pending || !this.tracks.video) return;
    if (!this.isVisible()) { this.waitVisible = true; return; } // no point offering a muted camera; resumes on return
    const s = this.pending = { id: this.randomId(), pc: null, location: null, posted: false, answered: false, closed: false, senders: {}, deadline: null, cancelGather: null };
    const mine = () => this.pending === s && !s.closed;
    try {
      const status = await this.fetchStatus(s.id);
      if (!mine()) return;
      if (!status.program.online) throw fail('PROGRAM_OFFLINE', { kind: 'offline' });
      if (['server_unreachable', 'unpaired', 'program_offline'].includes(this.phase)) this.setPhase(this.current ? 'recovering' : 'offering');
      if (!this.PeerConnection) throw fail('WEBRTC_UNSUPPORTED');
      this.attempts++;
      const pc = s.pc = new this.PeerConnection({ iceServers: status.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
      pc.onconnectionstatechange = () => this.onPcState(s);
      const init = () => ({ direction: 'sendonly', streams: this.stream ? [this.stream] : [] });
      const videoTransceiver = pc.addTransceiver(this.tracks.video, init());
      s.senders.video = videoTransceiver.sender;
      this.preferCodec(videoTransceiver);
      if (this.tracks.audio) s.senders.audio = pc.addTransceiver(this.tracks.audio, init()).sender;
      await this.tune(s);
      if (!mine()) return;
      const gathered = this.gather(s);
      await pc.setLocalDescription(await pc.createOffer());
      gathered.check();
      await gathered.done;
      if (!mine()) return;
      const offer = limitCandidates(pc.localDescription?.sdp); // with the candidates gathered so far (createOffer's string has none)
      if (!offer) throw fail('OFFER_EMPTY');
      s.posted = true;
      if (this.recovery) this.recovery.offerSent = true;
      const takeover = this.takeover;
      this.takeover = false; // only the first offer after her tap may take the link over; a retry never does
      const headers = { 'Content-Type': 'application/sdp', 'X-Link-Attempt': s.id, ...(takeover ? { 'X-Link-Takeover': '1' } : {}) };
      let res;
      try { res = await this.http('/api/link/whip', { method: 'POST', headers, body: offer }, TIMING.whipTimeoutMs); }
      catch { throw fail('WHIP_UNREACHABLE', { kind: 'unreachable' }); }
      if (res.status !== 201) throw await whipFailure(res);
      s.answered = true;
      const location = res.headers?.get?.('location') || '';
      s.location = RESOURCE.test(location) ? location : '/api/link/whip/' + s.id;
      const answer = await res.text();
      if (!mine()) return this.dropSession(s, true); // stopped while the offer was parked: delete the late resource
      if (typeof answer !== 'string' || !answer.startsWith('v=0')) throw fail('ANSWER_INVALID');
      await pc.setRemoteDescription({ type: 'answer', sdp: mungeAnswer(answer) });
      void this.tune(s); // again: some browsers expose the encodings only after negotiation
      if (this.current === s) return; // it connected while the answer was being applied
      if (!mine()) return this.dropSession(s, true);
      s.deadline = this.timers.setTimeout(() => this.onNoPath(s, 'ICE_NO_PATH'), TIMING.connectDeadlineMs); // counted from setRemoteDescription
      if (this.phase !== 'no_path') this.setPhase(this.current ? 'recovering' : 'connecting');
      if (pc.connectionState === 'connected') this.onConnected(s);
    } catch (e) {
      if (this.pending !== s) return; // whoever took the turn already cleaned this attempt up
      this.attemptFailed(s, e);
    }
  }

  preferCodec(transceiver) {
    if (!transceiver?.setCodecPreferences) return;
    const sorted = source => { try { return sortCodecs(source?.getCapabilities?.('video')?.codecs, this.codec); } catch { return null; } };
    const send = sorted(this.RtpSender);
    if (!send) return; // this phone cannot encode it: the browser's own order stays
    try { transceiver.setCodecPreferences(send); return; } catch { /* newer browsers validate against the receive list */ }
    const receive = sorted(this.RtpReceiver);
    if (receive) { try { transceiver.setCodecPreferences(receive); } catch { /* optional: normal negotiation still works */ } }
  }

  tune(s) { return Promise.all([tuneSender(s.senders.video, 'video'), tuneSender(s.senders.audio, 'audio')]); }

  /** Gather-done: the first of (a) gathering complete, (b) a host candidate seen and 300 ms of quiet, (c) 2000 ms. */
  gather(s) {
    const pc = s.pc, T = this.timers;
    let hostSeen = false, quiet = null, settled = false, release;
    const done = new Promise(resolve => { release = resolve; });
    const finish = () => {
      if (settled) return;
      settled = true;
      if (quiet !== null) T.clearTimeout(quiet);
      T.clearTimeout(cap);
      pc.onicecandidate = null; pc.onicegatheringstatechange = null;
      s.cancelGather = null;
      release();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const cap = T.setTimeout(finish, TIMING.gatherMaxMs);
    pc.onicegatheringstatechange = check;
    pc.onicecandidate = event => {
      const candidate = event?.candidate;
      if (!candidate) { finish(); return; } // end of candidates
      if (candidate.type === 'host' || / typ host( |$)/.test(candidate.candidate || '')) hostSeen = true;
      if (hostSeen) { if (quiet !== null) T.clearTimeout(quiet); quiet = T.setTimeout(finish, TIMING.gatherQuietMs); }
    };
    s.cancelGather = finish;
    check();
    return { done, check };
  }

  dropSession(s, remove) {
    if (!s) return;
    if (!s.closed) {
      s.closed = true;
      if (s.deadline !== null) { this.timers.clearTimeout(s.deadline); s.deadline = null; }
      const pc = s.pc;
      s.pc = null; s.senders = {}; // no reference to a closed connection is kept
      if (pc) {
        pc.onconnectionstatechange = null;
        s.cancelGather?.();
        try { pc.close(); } catch { /* already closed */ }
      } else s.cancelGather?.();
    }
    if (remove && s.posted) void this.control(s.location || '/api/link/whip/' + s.id, { method: 'DELETE' });
  }

  onNoPath(s, code) {
    if (this.pending === s) this.attemptFailed(s, fail(code, { kind: 'no_path' }));
  }

  attemptFailed(s, e) {
    const kind = e?.kind || 'error', code = codeOf(e, snake(e?.name) || 'ATTEMPT_FAILED');
    this.pending = null;
    this.dropSession(s, s.answered); // an answered attempt is the hub's current one: tell it to let go
    this.error = code;
    if (kind === 'replaced') { // another device took the camera: stop retrying, release everything, offer "bring it back here"
      this.halt();
      this.error = code;
      this.setPhase('replaced');
      return;
    }
    if (kind === 'unpaired' && !this.current) { this.halt(); this.error = code; this.setPhase('unpaired'); return; }
    if (kind === 'offline') { // look again every 3 s and offer by itself when the program is online
      this.setPhase('program_offline');
      this.after('retry', TIMING.offlinePollMs, () => void this.attempt());
      return;
    }
    if (kind === 'unpaired') this.phase = 'unpaired'; // during recovery: media (if any still flows) is left alone
    else if (kind === 'unreachable') this.phase = 'server_unreachable';
    else if (kind === 'no_path') this.phase = 'no_path';
    else this.phase = this.current ? 'recovering' : 'offering'; // 504 and friends: just try again
    this.update();
    this.scheduleAttempt();
  }

  onPcState(s) {
    const state = s.pc?.connectionState;
    if (s.closed || !state) return;
    if (s === this.pending) {
      if (state === 'connected') this.onConnected(s);
      else if (state === 'failed' && s.answered) this.onNoPath(s, 'ICE_FAILED'); // no need to wait out the 10 s
      return;
    }
    if (s !== this.current) return;
    if (state === 'connected') {
      this.cancel('disconnect');
      // it healed by itself before any new offer left the phone: nothing to recover
      if (this.recovery && !this.recovery.offerSent) this.heal();
    } else if (state === 'disconnected') {
      if (!this.recovery && !this.t.has('disconnect')) {
        this.after('disconnect', TIMING.disconnectGraceMs, () => { if (this.current === s && s.pc?.connectionState === 'disconnected') this.recover('PC_DISCONNECTED'); });
      }
    } else if (state === 'failed') {
      this.cancel('disconnect');
      this.recover('PC_FAILED');
    }
  }

  heal() {
    const pending = this.pending;
    this.pending = null; this.recovery = null; this.waitVisible = false;
    this.cancel('retry');
    this.dropSession(pending, false);
    this.error = null;
    this.setPhase('live');
  }

  onConnected(s) {
    if (this.pending !== s || s.closed) return;
    if (s.deadline !== null) { this.timers.clearTimeout(s.deadline); s.deadline = null; }
    const old = this.current;
    this.current = s; this.pending = null; this.recovery = null;
    this.dropSession(old, false); // make-before-break: the old one closes only now (the hub replaced it when it took the new offer)
    this.cancel('disconnect'); this.cancel('retry');
    this.resetLinkHealth();
    this.liveSince = this.now();
    this.error = null;
    this.setPhase('live');
    if (!this.t.has('tick')) this.after('tick', TIMING.statusMs, () => void this.tick());
    void this.postState(); // the new attempt's capture state, at once
  }

  /** Make-before-break: the old connection stays, a NEW attempt (new RTCPeerConnection, new id) is started. */
  recover(reason) {
    if (this.halted || !this.current || this.recovery) return;
    const now = this.now();
    // a link that held for 10 s starts the delays over at 0 s; one that keeps dying young keeps the growing delays (no flapping)
    if (now - this.liveSince >= TIMING.stableMs) this.streak = 0;
    // the hub itself says the link is over (the program page was reloaded and waits for a phone before it loads its engine):
    // ask again within a second, whatever the delays had grown to
    else if (reason === 'LINK_LOST') this.streak = Math.min(this.streak, 1);
    this.recovery = { reason, since: now, offerSent: false };
    this.cancel('disconnect');
    this.error = reason;
    this.setPhase('recovering');
    this.scheduleAttempt();
  }

  // ---- heartbeat ---------------------------------------------------------------------------------------------

  async tick() {
    if (this.halted || !this.current) return;
    this.after('tick', TIMING.statusMs, () => void this.tick());
    const n = ++this.ticks;
    void this.pollStatus();
    await this.sampleStats();
    if (this.halted) return;
    if (n % TIMING.stateEveryTicks === 0) void this.postState();
    this.update();
  }

  async pollStatus() {
    if (this.statusBusy) return;
    this.statusBusy = true;
    const epoch = this.epoch;
    try {
      const status = await this.fetchStatus((this.pending?.answered ? this.pending : this.current)?.id);
      if (epoch === this.epoch) this.onStatus(status);
    } catch { /* a failed control call never stops media; after 3 s the pill says there is no control link */ }
    finally { this.statusBusy = false; }
    if (epoch === this.epoch) this.update();
  }

  onStatus(status) {
    if (this.halted || !this.current || this.recovery) return;
    const now = this.now(), link = status.link;
    if (!link.mine) {
      // "lost" and not mine: the hub knows this link is over (the program page was reloaded or gave it up) -> offer again now
      if (link.state === 'lost') { this.recover('LINK_LOST'); return; }
      // otherwise another client holds the link, or the gateway restarted and re-adopts the link within a second or two
      this.notMineSince ??= now;
      if (now - this.notMineSince >= TIMING.notMineGraceMs) this.recover('LINK_NOT_MINE');
      return;
    }
    this.notMineSince = null;
    let stale;
    if (link.echoAgeMs === null) { this.echoNullSince ??= now; stale = now - this.echoNullSince > TIMING.echoStaleMs; }
    else { this.echoNullSince = null; stale = link.echoAgeMs > TIMING.echoStaleMs; }
    // the program is there but no longer reports this link. Not while its engine is still loading (program.ready false):
    // that page is held up for seconds at a time and says nothing meanwhile, and a new offer could not be answered either,
    // it would only replace the connection the page has already made
    if (stale && status.program.online && status.program.ready) this.recover('ECHO_STALE');
  }

  async sampleStats() {
    const s = this.current;
    if (!s?.pc?.getStats) return;
    let report;
    try { report = await s.pc.getStats(); } catch { return; }
    if (this.current !== s || s.closed || this.halted) return;
    const now = this.now(), r = readStats(report);
    const seconds = this.lastStatsAt ? (now - this.lastStatsAt) / 1000 : 0;
    const kbps = seconds > 0 && this.lastBytes !== null && r.bytes >= this.lastBytes ? Math.round((r.bytes - this.lastBytes) * 8 / 1000 / seconds) : 0;
    // nothing leaves the phone although the camera is healthy and the page is in front: the far end is gone
    const healthy = this.phase === 'live' && !this.recovery && !this.isInterrupted() && r.outbound > 0;
    if (healthy && this.lastBytes !== null && r.bytes <= this.lastBytes) {
      this.flatSince ??= this.lastStatsAt;
      if (now - this.flatSince >= TIMING.flatMs) { this.flatSince = null; this.lastBytes = r.bytes; this.lastStatsAt = now; this.recover('BYTES_FLAT'); return; }
    } else this.flatSince = null;
    this.lastBytes = r.bytes; this.lastStatsAt = now;
    this.stats = { w: r.w, h: r.h, fps: r.fps, kbps, rttMs: r.rttMs, lossPct: r.lossPct, codec: r.codec, encoder: r.encoder, limit: r.limit, path: r.path };
  }

  async postState() {
    const s = this.pending?.answered ? this.pending : this.current; // the attempt the hub holds as current
    if (!s || this.halted) return;
    if (this.stateBusy) { this.stateAgain = true; return; }
    this.stateBusy = true;
    const c = this.capture(), st = this.stats;
    this.reportedKey = c.video + '|' + c.audio + '|' + c.visible;
    const body = JSON.stringify({
      attempt: s.id, video: c.video, audio: c.audio, visible: c.visible,
      stats: { w: whole(st.w, 1e5), h: whole(st.h, 1e5), fps: whole(st.fps, 1000), kbps: whole(st.kbps, 1e6), rttMs: whole(st.rttMs, 1e5), codec: label(st.codec), encoder: label(st.encoder), limit: label(st.limit) },
    });
    await this.control('/api/link/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    this.stateBusy = false;
    if (this.stateAgain) { this.stateAgain = false; void this.postState(); }
  }

  /** pagehide: tell the hub at once (the request outlives the page). */
  onPageHide() {
    const s = this.pending?.posted ? this.pending : this.current;
    if (!s || !this.fetch) return;
    const url = this.base + (s.location || '/api/link/whip/' + s.id) + '/bye';
    try { void Promise.resolve(this.fetch(url, { method: 'POST', keepalive: true, cache: 'no-store', credentials: 'same-origin', headers: this.requestHeaders() })).catch(() => {}); }
    catch { /* the page is going away */ }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The page (public/cam/index.html). Everything dynamic is written with textContent; no markup is ever built from data.
// ---------------------------------------------------------------------------------------------------------------

export function mountCamPage(g = globalThis, overrides = {}) { // overrides: now / timers / randomId for the tests
  const doc = g.document, win = g.window || g;
  const $ = id => doc.getElementById(id);
  const query = new URLSearchParams(g.location?.search || '');
  const root = $('cam'), video = $('self');
  let debug = query.get('debug') === '1', taps = [];

  const show = (id, visible) => { const el = $(id); if (el && el.hidden === visible) el.hidden = !visible; };
  const text = (id, value) => { const el = $(id); if (el && el.textContent !== value) el.textContent = value; };
  const coarse = () => (win.matchMedia ? win.matchMedia('(pointer: coarse)').matches : (g.navigator?.maxTouchPoints || 0) > 0);
  const landscape = () => {
    const type = g.screen?.orientation?.type;
    return type ? type.startsWith('landscape') : Boolean(win.matchMedia?.('(orientation: landscape)').matches);
  };

  const link = new CamLink({
    // the browser's own objects, taken from g so a test can hand in a fake page
    fetch: typeof g.fetch === 'function' ? g.fetch.bind(g) : null,
    PeerConnection: g.RTCPeerConnection ?? null,
    mediaDevices: g.navigator?.mediaDevices ?? null,
    RtpSender: g.RTCRtpSender ?? null,
    RtpReceiver: g.RTCRtpReceiver ?? null,
    wakeLock: g.navigator?.wakeLock ?? null,
    document: doc,
    window: win,
    ...overrides,
    voice: query.get('voice') === '1',
    codec: query.get('codec'),
    parent: win.parent && win.parent !== win ? win.parent : null,
    onState: render,
    onPreview: track => {
      video.srcObject = track ? new g.MediaStream([track]) : null;
      if (track) Promise.resolve(video.play?.()).catch(() => {});
    },
  });
  win.camLink = link; // for the end-to-end tests and for a look from the console

  function render(s) {
    root.dataset.state = s.state;
    const camera = s.tracksLive, notice = NOTICE[s.state];
    show('start-card', ['idle', 'stopped', 'acquiring'].includes(s.state));
    $('start').disabled = s.state === 'acquiring';
    show('notice', Boolean(notice));
    text('notice-text', notice || '');
    show('retry', s.state === 'denied' || s.state === 'busy_camera');
    show('takeover', s.state === 'replaced');
    show('pair-link', s.state === 'unpaired');
    show('pill', Boolean(s.pill.text));
    $('pill').dataset.tone = s.pill.tone;
    text('pill-text', s.pill.text);
    show('pill-sub', Boolean(s.pill.sub));
    text('pill-sub', s.pill.sub);
    show('air', s.pill.air);
    show('sending', camera); // fixed label while any track is live
    show('mic-muted', camera && s.micMuted);
    show('wake-hint', camera && (s.wakeLock === 'rejected' || s.wakeLock === 'unsupported'));
    show('controls', camera);
    $('mic').setAttribute('aria-pressed', String(s.micMuted));
    if (!camera) show('confirm', false);
    show('landscape', camera && landscape() && coarse()); // the stream continues underneath
    show('diag', debug);
    if (debug) {
      const st = s.stats, path = st.path || s.status?.link.path;
      text('d-state', s.state + (s.error ? ' · ' + s.error : ''));
      text('d-codec', st.codec || '—');
      text('d-encoder', st.encoder || '—');
      text('d-size', st.w && st.h ? st.w + '×' + st.h : '—');
      text('d-fps', String(st.fps || 0));
      text('d-kbps', String(st.kbps || 0));
      text('d-rtt', String(st.rttMs || 0));
      text('d-loss', String(st.lossPct || 0));
      text('d-limit', st.limit || '—');
      text('d-path', path ? path.local + ' → ' + path.remote + ' / ' + path.protocol : '—');
      text('d-attempts', String(s.attempts));
      text('d-pc', (s.pcState || '—') + ' · control ' + s.control + ' · wake ' + s.wakeLock);
    }
  }

  const rerender = () => render(link.snapshot());
  $('start').addEventListener('click', () => { void link.start(); });
  $('retry').addEventListener('click', () => { void link.start(); });
  $('takeover').addEventListener('click', () => { void link.start({ takeover: true }); });
  $('mic').addEventListener('click', () => { link.toggleMic(); });
  $('stop').addEventListener('click', () => show('confirm', true));
  $('confirm-keep').addEventListener('click', () => show('confirm', false));
  $('confirm-stop').addEventListener('click', () => { show('confirm', false); void link.stop(); });
  $('pill').addEventListener('click', () => { // five taps within 3 s open or close the diagnostics
    const now = Date.now();
    taps = taps.filter(at => now - at < 3000);
    taps.push(now);
    if (taps.length >= 5) { taps = []; debug = !debug; rerender(); }
  });
  g.screen?.orientation?.addEventListener?.('change', rerender);
  win.addEventListener?.('resize', rerender);

  rerender();
  void link.preflight();
  return link;
}

// The page asks for its UI with ?ui=1 on the script URL. A plain import (node --test, an embedding app) touches no DOM.
if (new URL(import.meta.url).searchParams.get('ui') === '1') mountCamPage();
