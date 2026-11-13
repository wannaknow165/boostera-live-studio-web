// CAM LINK v1 — the program-page receiver (?src=live).  Spec section 7; the pure rules are in fx/link-core.js.
//
// The creator's phone sends camera + microphone peer-to-peer (WebRTC) to THIS page; the gateway only carries the two
// SDP texts. fx/index.html starts this module right after it has read its query string — before MediaPipe is downloaded —
// so the page is "online" for the hub at once and can answer an offer while the engine is still loading.
//
// How the picture reaches the engine (fx/fx-engine.js is shared with the phone app and is NOT edited):
//   phone ──WebRTC──▶ rx (a private 1px <video>) ──cover-fit blit, mirrored──▶ norm (a 720x1280 canvas)
//         ──captureStream(30), set once──▶ the engine's own <video id="src">
// The engine therefore always sees one constant-size, always-ready input (the pattern of usePhone() in fx/index.html):
// no re-allocation when the phone changes resolution or turns, no 0x0 frame, no source swap.
// When the feed is gone the normaliser paints black — the body mask then finds nobody and, with a ?stage= wall, the wall
// shows alone — while the effects on top keep animating.
//
// The engine's own loop (requestAnimationFrame at the display rate, with no new-frame check) is replaced for this source
// by the loop below: at most one draw every 31 ms.
//
// Address (with ?src=live):  gw=<gateway base, default: this host, port + 1> · program=<page id, default random> ·
//   takeover=1 · mirror=1|0 (default 1) · audio=1 (default off) · sink=<part of an output device's label> ·
//   adelay=<ms> · jb=<ms> · and the fragment #pk=<program key>, which is read once and removed from the address.
// What it reports (POST /api/link/program/state, and window.linkReceiver.state() / .stats() for tests and the console):
//   state loading | idle | answering | connected | stalled | lost · showing webrtc | slate · numbers · audio · path ·
//   lastError: STREAM_REJECTED, SDP_INVALID, STALE_ATTEMPT, CLIENT_GONE (the spec's codes) and, from this page alone,
//   CONNECT_TIMEOUT (not connected 10 s after answering), CONNECTION_FAILED, ANSWER_FAILED, PROGRAM_SUPERSEDED.
//
// Never written to the page log or the console: SDP, ICE candidates, addresses, the program key.

import {
  NORM_W, NORM_H, DRAW_MIN_MS, STATS_MS, SLATE_REPAINT_MS, ANSWER_DEADLINE_MS, CONNECT_MS, POLL_TIMEOUT_MS, LEASE_PARKED_MS, RETRY_PARKED_MS,
  BUSY_RETRY_MS, DENIED_RETRY_MS, FAST_EMPTY_MS, FAST_EMPTY_WAIT_MS, REPEAT_WAIT_MS, ECHO_LIVE_MS, ECHO_IDLE_MS, ECHO_MIN_GAP_MS,
  ECHO_TIMEOUT_MS, LOST_LINGER_MS, HEAD_START_MS, HEAD_START_EXTRA_MS, KEY_STORE, ZERO_STATS,
  hz, backoffMs, upperSnake, linkOptions, pageIdFrom, readProgramKey, gatewayBase, coverFit, newFreshness, noteFrames, feedDecision, judgeAt,
  linkState, newSizeGuard, noteSize, gatherDecision, isHostCandidate, sdpProblem, capCandidates, cameraAway, pollOutcome,
  summarizeStats, pickSink, sinksHidden, sinkLabel, stateBody,
} from './link-core.js';

const LOG_KEEP = 60;   // the receiver's own ring of log lines (window.linkReceiver.state().log)
const ONCE_MAX = 12;   // at most this many different "said once" lines of ONE kind (frame errors, refusals, …) in a page's life
const SEEN_MAX = 8;    // attempt ids remembered, so an offer that is delivered again is not answered twice

function randomHex(win, bytes = 8) {
  try { const a = new Uint8Array(bytes); win.crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); }
  catch { return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2); }
}

// fx: the FxEngine instance · video: the engine's <video id="src"> · log: the page's log function · qs: the page's
// URLSearchParams · win: the window (tests pass a fake one). Returns { state(), stats(), stop(), headStart }; the page
// only awaits headStart — window.linkReceiver = { state(), stats() } is the read-only view for tests and for the console.
export function startLinkReceiver({ fx, video, log = () => {}, qs = null, win = globalThis } = {}) {
  if (win.linkReceiver) return win.linkReceiver; // one receiver per page
  const doc = win.document, nav = win.navigator, loc = win.location;
  const now = () => win.performance.now();

  // ---------- the program key: read once from #pk=…, and out of the address before anything else happens ----------
  const pk = readProgramKey(loc.hash);
  if (pk.found) {
    try { win.history.replaceState(win.history.state, '', loc.pathname + loc.search + pk.rest); }
    catch { try { loc.hash = pk.rest; } catch { /* nothing more to try */ } }
  }
  // The address no longer carries the key, so a reload of this window (F5, a crash recovery) would come back without it and
  // be refused for good. The tab therefore keeps it in sessionStorage: readable by this origin in this tab only, never
  // sent anywhere by the browser, gone when the window closes. A key in the address always wins.
  let key = pk.key;
  try {
    const store = win.sessionStorage;
    if (key) store.setItem(KEY_STORE, key);
    else if (!pk.found) key = readProgramKey('#pk=' + encodeURIComponent(store.getItem(KEY_STORE) || '')).key;
  } catch { /* no storage here: a reload then needs the launcher again */ }
  const hasKey = !!key, keyHeaders = hasKey ? { 'X-Link-Program-Key': key } : {};

  const opts = linkOptions(qs || loc.search);
  const where = gatewayBase(opts.gw, loc), gw = where.base;
  const pageId = pageIdFrom(opts.program, randomHex(win));
  // One value per LOAD of this page. The launcher always writes program=air, so two windows with that address carry the same
  // page id; the hub tells them apart by this (the newer one takes the slot, the older one is told to stop for good).
  const inst = randomHex(win);

  // ---------- a bounded log ----------
  const ring = [], once = new Set(), counts = new Map();
  const say = m => { ring.push({ t: Math.round(now()), m }); if (ring.length > LOG_KEEP) ring.shift(); try { log('LINK ' + m); } catch { /* the page log must never stop the link */ } };
  // a given line once; the key is "kind" or "kind:detail", and no kind gets more than ONCE_MAX different lines (so a flood
  // of ever-new frame errors cannot push the one line about, say, blocked audio out)
  const sayOnce = (k, m) => { if (once.has(k)) return; const kind = k.split(':')[0], n = (counts.get('once ' + kind) || 0) + 1; if (n > ONCE_MAX) return; counts.set('once ' + kind, n); once.add(k); say(m); };
  const sayLimited = (k, m, max = 10) => { const n = (counts.get(k) || 0) + 1; counts.set(k, n); if (n <= max) say(n === max && max > 1 ? m + ' (not reported again)' : m); };
  const short = id => String(id).slice(0, 8);
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));

  // ---------- state ----------
  let stopped = false, superseded = false, lease = 'none';           // lease: none | held | busy | superseded
  let after = 0, polls = 0, pollFails = 0, echoes = 0, pollAbort = null;
  let session = null;                                                // the one live attempt (and its RTCPeerConnection), or null
  let pcCreated = 0, lastError = null, lostUntil = 0, lostAttempt = null;
  const seen = [];
  const fresh = newFreshness(); let guard = newSizeGuard(), captureBadSince = null, capture = null;
  let statsPrev = null, last = { ...ZERO_STATS }, samplingSince = null, seenAt = null; // seenAt: when the decoder's counter was last read (see judgeAt)
  let painted = 'slate', paintedAt = -1e9;                           // what is on the normaliser now
  let rafId = 0, rafCount = 0, drawCount = 0, rafHz = null, drawHz = null, rateAt = now(), // (null until the first full second was measured)
      lastDraw = -1e9, takenRaf, loopTaken = false;
  let echoAt = -1e9, echoBusy = false, echoTimer = null, lastEchoed = '';
  // audio (only with audio=1)
  let au = null, actx = null, graph = null, sinkNow = opts.audio ? (opts.sink ? 'no_sink' : 'default') : null, sinkId = null, audioBlocked = false, gestureArmed = false, routing = 0, devTimer = null;

  // ---------- the head start ----------
  // Loading the engine (models, the first inference) takes the page's main thread for seconds at a time, and an offer that
  // arrives then is answered late or too late (the hub waits 8 s for the answer). fx/index.html therefore awaits `headStart`
  // before it loads the engine: it resolves as soon as the first connection is up (or its attempt is over), or after
  // HEAD_START_MS when no phone asked. A phone that lost its link through a reload of this page asks again within a second or
  // two; one that found the program offline (the window was not open yet) looks again every 3 s.
  let headDone = () => {}; const headStart = new Promise(resolve => { headDone = resolve; });
  let headTimer = win.setTimeout(() => { if (!session || session.connectedAt != null) headDone(); else headTimer = win.setTimeout(headDone, HEAD_START_EXTRA_MS); }, HEAD_START_MS);

  if (opts.clean) { try { doc.title = 'LINK PROGRAM'; } catch { /* the title is only a convenience for the capture picker */ } }

  // ---------- the normaliser: one 720x1280 canvas feeds the engine's <video>, once and for good ----------
  const norm = doc.createElement('canvas'); norm.width = NORM_W; norm.height = NORM_H;
  const nctx = norm.getContext('2d', { alpha: false });
  let feed = null, feedStream = null; // the canvas capture track and its stream
  // captureStream(30) takes a frame only when its own 30 Hz timer has ticked since the last one. This loop paints at about
  // the same rate, so the two would beat (a painted frame skipped now and then). Asking for a frame with every paint makes
  // it exact: one painted frame = one frame for the engine.
  const grab = () => { if (feed && typeof feed.requestFrame === 'function') { try { feed.requestFrame(); } catch { /* the timer still takes frames */ } } };
  const black = t => { nctx.setTransform(1, 0, 0, 1, 0, 0); nctx.fillStyle = '#000'; nctx.fillRect(0, 0, NORM_W, NORM_H); painted = 'slate'; paintedAt = t; grab(); };
  try {
    feedStream = norm.captureStream(30); feed = typeof feedStream.getVideoTracks === 'function' ? feedStream.getVideoTracks()[0] || null : null;
    video.srcObject = feedStream; const playing = video.play(); if (playing && playing.catch) playing.catch(() => {});
  } catch (e) { say('the normaliser could not feed the engine: ' + (e && e.name)); }
  black(now()); // the first frame of the stream: the engine's input is ready from the start

  // the private element that receives the phone's video: muted, in the page (NOT display:none), one invisible pixel
  const rx = doc.createElement('video');
  rx.muted = true; rx.playsInline = true; rx.autoplay = true; rx.tabIndex = -1;
  rx.setAttribute('muted', ''); rx.setAttribute('playsinline', ''); rx.setAttribute('aria-hidden', 'true');
  rx.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  (doc.body || doc.documentElement).appendChild(rx);
  const soon = () => { void sample(); };
  rx.addEventListener('loadeddata', soon); rx.addEventListener('resize', soon); // the first frame / a new size: read the counters now, not in half a second

  function paint(t) {
    const d = feedDecision({ now: judgeAt(t, seenAt), riseAt: fresh.riseAt, captureBadSince });
    if (d.mode === 'live') {
      const fit = session && session.videoTrack && rx.readyState >= 2 ? coverFit(rx.videoWidth, rx.videoHeight, NORM_W, NORM_H, opts.mirror) : null;
      if (!fit) return; // no frame of this attempt on the element yet: what is there stays
      try { nctx.setTransform(...fit.transform); nctx.drawImage(rx, fit.sx, fit.sy, fit.sw, fit.sh, 0, 0, NORM_W, NORM_H); painted = 'webrtc'; paintedAt = t; grab(); }
      finally { nctx.setTransform(1, 0, 0, 1, 0, 0); }
    } else if (d.mode === 'slate' && (painted !== 'slate' || t - paintedAt >= SLATE_REPAINT_MS)) black(t);
    // 'hold': the last frame stays
  }

  // ---------- the loop: replaces the engine's own display-rate loop for this source ----------
  // Engine members used (fx-engine.js, not edited): fx.ready (true at the end of init()), fx.raf (the pending frame of the
  // loop that start() runs; there is no stop(), cancelling that frame is what ends it), fx.frame(ts), fx.postFX().
  // The engine schedules its models by frame COUNT (face every frame, pose and body mask on alternate frames), so at
  // one draw per 31 ms the face is tracked about 30 times a second and the pose / the cut-out mask about 15 times.
  const engineReady = () => fx.ready === true && fx.raf != null;
  function frame(t) {
    rafId = win.requestAnimationFrame(frame);
    rafCount++;
    if (fx.raf != null && fx.raf !== takenRaf) { // the engine has (re)started its own loop: this one takes its place
      win.cancelAnimationFrame(fx.raf); takenRaf = fx.raf; loopTaken = true; lastDraw = t; return;
    }
    if (t - lastDraw < DRAW_MIN_MS) return;
    lastDraw = t;
    try { paint(now()); } catch (e) { sayOnce('paint:' + (e && e.name), 'blit failed: ' + (e && e.name)); }
    if (!loopTaken) return;
    drawCount++;
    try { fx.frame(win.performance.now()); fx.postFX(); } catch (e) { const m = String((e && e.message) || e).slice(0, 120); sayOnce('frame:' + m, 'frame error ' + m); }
  }

  // ---------- freshness, size guard and numbers: getStats() every 500 ms (it also ticks while rendering is throttled) ----------
  async function sample() {
    const s = session, t0 = now();
    if (!s || !s.pc) return;
    if (samplingSince != null) { if (t0 - samplingSince < 3000) return; seenAt = t0; } // a reading that never came back counts as a reading without a rise
    samplingSince = t0;
    try {
      const report = await s.pc.getStats();
      if (session !== s) return;
      const entries = []; report.forEach(e => entries.push(e));
      const t = now(), sum = summarizeStats(entries, statsPrev, t);
      statsPrev = sum.next; last = sum; seenAt = t;
      if (noteFrames(fresh, sum.hasVideo ? sum.framesDecoded : NaN, t) && s.firstFrameAt == null) { s.firstFrameAt = t; say(`first frame ${sum.w}x${sum.h}`); echoSoon(); }
      const verdict = noteSize(guard, sum.w, sum.h, t);
      if (verdict !== 'ok') failSession(s, 'STREAM_REJECTED', verdict === 'too_large' ? `stream too large (${sum.w}x${sum.h})` : 'stream keeps changing size');
    } catch { if (session === s) seenAt = now(); /* a reading that failed is simply a reading without a rise */ }
    finally { if (samplingSince === t0) samplingSince = null; }
  }

  // ---------- what the page says about itself ----------
  function snapshot() {
    const t = now(), s = session, d = feedDecision({ now: judgeAt(t, seenAt), riseAt: fresh.riseAt, captureBadSince }), lostLinger = !s && t < lostUntil;
    const state = linkState({ engineReady: engineReady(), hasPc: !!s, connectedAt: s ? s.connectedAt : null, firstFrameAt: s ? s.firstFrameAt : null, mode: d.mode, captureAway: captureBadSince != null, lostLinger, now: t });
    const showing = painted === 'webrtc' && d.mode !== 'slate' ? 'webrtc' : 'slate';
    return {
      state, showing, attempt: s ? s.id : lostLinger ? lostAttempt : null, lastError,
      // fps is the rate of frames that are really being shown: 0 whenever the picture is held or black
      stats: { w: last.w, h: last.h, fps: showing === 'webrtc' && d.mode === 'live' ? last.fps : 0, framesDecoded: last.framesDecoded, freezeCount: last.freezeCount, jitterMs: last.jitterMs, kbps: last.kbps, rttMs: last.rttMs, lossPct: last.lossPct, rafHz, drawHz, pcCreated, vw: win.innerWidth, vh: win.innerHeight, dpr: win.devicePixelRatio },
      hidden: !!doc.hidden,
      audio: { wanted: opts.audio, playing: audioPlaying(), level: last.level, sink: sinkNow },
      path: last.path,
    };
  }
  const echoKey = snap => [snap.state, snap.showing, snap.attempt, snap.lastError, snap.hidden, rafHz != null && rafHz < 10, snap.audio.playing, snap.audio.sink].join('|'); // what is told at once when it changes

  // ---------- the state echo: every second while a connection exists, every 5 s when idle, and at once on a change ----------
  const post = (path, body, ms) => timedFetch(gw + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...keyHeaders }, body: JSON.stringify(body) }, ms);
  async function timedFetch(url, init, ms) {
    const ctl = new win.AbortController(), t = win.setTimeout(() => ctl.abort(), ms);
    try { return await win.fetch(url, { cache: 'no-store', credentials: 'omit', ...init, signal: ctl.signal }); }
    finally { win.clearTimeout(t); }
  }
  async function sendEcho() {
    echoAt = now(); echoBusy = true; echoes++;
    try { const snap = snapshot(); lastEchoed = echoKey(snap); await post('/api/link/program/state', stateBody({ program: pageId, inst, ...snap }), ECHO_TIMEOUT_MS); }
    catch { /* the gateway is away: the poll loop reports that, once */ }
    finally { echoBusy = false; }
  }
  function echoTick(force) {
    if (stopped || superseded || lease !== 'held') return;
    const since = now() - echoAt;
    // with a connection: every tick of the 1 s timer (unless a change was told a moment ago); idle: every 5 s
    if (!force && since < (session ? ECHO_MIN_GAP_MS : ECHO_IDLE_MS - 20)) return;
    if (echoBusy && since < ECHO_TIMEOUT_MS) return;
    void sendEcho();
  }
  function echoSoon() {
    if (echoTimer != null || stopped || superseded) return;
    echoTimer = win.setTimeout(() => { echoTimer = null; echoTick(true); }, Math.max(0, ECHO_MIN_GAP_MS - (now() - echoAt)));
  }

  // ---------- one attempt ----------
  // keepFrame: the last picture stays for what is left of its 3 s (a new attempt is already on its way); otherwise black at once
  function closeSession({ error = null, keepFrame = false } = {}) {
    const s = session; session = null;
    if (s) {
      headDone(); // an attempt that is over is no reason to hold the engine back any longer
      win.clearTimeout(s.deadline); win.clearTimeout(s.watchdog);
      const p = s.pc; s.pc = null;
      if (p) { p.ontrack = p.onconnectionstatechange = p.onicecandidate = p.onicegatheringstatechange = null; try { p.close(); } catch { /* already closed */ } }
      if (s.wake) s.wake(); // lets a waiting "gathering done?" go
      detachAudio();
      try { rx.srcObject = null; } catch { /* nothing attached */ }
    }
    fresh.frames = null; if (!keepFrame) fresh.riseAt = null; guard = newSizeGuard(); captureBadSince = null; capture = null; statsPrev = null; last = { ...ZERO_STATS }; seenAt = null;
    if (error) { lastError = error; lostAttempt = s ? s.id : null; lostUntil = now() + LOST_LINGER_MS; } else { lostAttempt = null; lostUntil = 0; }
  }
  function failSession(s, code, why) {
    if (session !== s) return;
    say(`${why} - link ${short(s.id)} closed (${code})`);
    closeSession({ error: code }); echoSoon();
  }
  function applyJitterTarget(p) { // a hint; both receivers, because audio and video are played in sync
    let list = []; try { list = p.getReceivers() || []; } catch { /* no receivers yet */ }
    for (const r of list) { try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = opts.jbMs; else if ('playoutDelayHint' in r) r.playoutDelayHint = opts.jbMs / 1000; } catch { /* out of this browser's range */ } }
  }
  function gathered(s) { // resolves by the gather-done rule (or at once when the attempt is over)
    return new Promise(resolve => {
      let timer = null;
      const check = () => {
        win.clearTimeout(timer);
        if (session !== s || !s.pc) { s.wake = null; return resolve(); }
        const t = now(), d = gatherDecision({ complete: s.pc.iceGatheringState === 'complete', hostSeen: s.g.host, sinceCandidateMs: t - s.g.last, elapsedMs: t - s.g.t0 });
        if (d.done) { s.wake = null; s.gather = d.why; return resolve(); }
        timer = win.setTimeout(check, d.waitMs);
      };
      s.wake = check; check();
    });
  }
  async function postAnswer(s, sdp) { // the same answer may be sent again: the hub answers a repeat with { ok, repeated }
    for (let i = 0; i < 3; i++) {
      if (session !== s) return { ok: false, code: null };
      try {
        const res = await post('/api/link/program/answer', { program: pageId, inst, attempt: s.id, sdp }, 4000);
        if (res.status >= 200 && res.status < 300) return { ok: true };
        if (res.status >= 400 && res.status < 500) { // STALE_ATTEMPT, CLIENT_GONE, SDP_INVALID, a refused key…: asking again cannot help
          let code = null; try { code = upperSnake((await res.json()).error); } catch { /* no body */ }
          return { ok: false, code: code || (res.status === 409 ? 'STALE_ATTEMPT' : res.status === 410 ? 'CLIENT_GONE' : 'ANSWER_FAILED') };
        }
      } catch { /* no reply: try again */ }
      await sleep(400 * (i + 1));
    }
    return { ok: false, code: 'ANSWER_FAILED' };
  }
  async function answer(m) {
    closeSession({ keepFrame: true }); // at most one live connection, and no reference to a closed one; her last frame is held (under 3 s) while the new one comes up
    const bad = sdpProblem(m.sdp);
    if (bad) { say(`offer ${short(m.attempt)} refused (${bad})`); lastError = 'SDP_INVALID'; lostAttempt = m.attempt; lostUntil = now() + LOST_LINGER_MS; echoSoon(); return; }
    const s = { id: m.attempt, pc: null, at: now(), connectedAt: null, firstFrameAt: null, answeredAt: null, videoTrack: null, audioTrack: null, audioStream: null, deadline: null, watchdog: null, wake: null, gather: null, g: { t0: now(), last: now(), host: false } };
    session = s;
    const stale = () => session !== s;
    let step = 'create';
    try {
      const cfg = { iceServers: m.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
      let p;
      try { p = new win.RTCPeerConnection(cfg); }
      catch { sayOnce('ice-config', 'the ICE server list was refused by the browser - using host candidates only'); p = new win.RTCPeerConnection({ ...cfg, iceServers: [] }); }
      s.pc = p; pcCreated++;
      p.ontrack = ev => onTrack(s, ev);
      p.onconnectionstatechange = () => onConnection(s);
      p.onicecandidate = ev => { if (ev && ev.candidate) { s.g.last = now(); if (isHostCandidate(ev.candidate)) s.g.host = true; } if (s.wake) s.wake(); };
      p.onicegatheringstatechange = () => { if (s.wake) s.wake(); };
      s.deadline = win.setTimeout(() => { if (s.answeredAt == null) failSession(s, 'ANSWER_FAILED', 'the answer was not delivered in time'); }, ANSWER_DEADLINE_MS);
      say(`offer ${short(s.id)} - answering`); echoSoon();
      step = 'remote'; await p.setRemoteDescription({ type: 'offer', sdp: m.sdp }); if (stale()) return;
      applyJitterTarget(p);
      step = 'answer'; const ans = await p.createAnswer(); if (stale()) return;
      s.g.t0 = s.g.last = now();
      step = 'local'; await p.setLocalDescription(ans); if (stale()) return;
      step = 'gather'; await gathered(s); if (stale()) return;
      step = 'post'; const r = await postAnswer(s, capCandidates(p.localDescription.sdp)); if (stale()) return;
      if (!r.ok) return failSession(s, r.code || 'ANSWER_FAILED', 'the hub did not take the answer');
      s.answeredAt = now(); win.clearTimeout(s.deadline);
      say(`answer sent (${s.gather}, ${Math.round(s.answeredAt - s.at)} ms)`);
      if (s.connectedAt == null) s.watchdog = win.setTimeout(() => { if (s.connectedAt == null) failSession(s, 'CONNECT_TIMEOUT', 'not connected within 10 s of answering'); }, CONNECT_MS);
    } catch (e) { // only the error's name is logged: its message can quote a line of the SDP
      if (!stale()) failSession(s, step === 'remote' ? 'SDP_INVALID' : 'ANSWER_FAILED', `${step} failed (${(e && e.name) || 'error'})`);
    }
  }
  function onTrack(s, ev) {
    if (session !== s || !ev || !ev.track) return;
    const track = ev.track;
    if (track.kind === 'video' && !s.videoTrack) { // rx gets a stream only now that the video track exists (never an audio-only stream: 0x0)
      s.videoTrack = track;
      try { rx.srcObject = new win.MediaStream([track]); const playing = rx.play(); if (playing && playing.catch) playing.catch(() => {}); }
      catch (e) { sayOnce('rx', 'the received video could not be attached: ' + (e && e.name)); }
    } else if (track.kind === 'audio' && !s.audioTrack) {
      s.audioTrack = track;
      if (opts.audio) attachAudio(s, track).catch(() => {});
    }
  }
  function onConnection(s) {
    if (session !== s || !s.pc) return;
    const st = s.pc.connectionState;
    if (st === 'connected') {
      win.clearTimeout(s.watchdog); s.watchdog = null;
      if (s.connectedAt == null) { s.connectedAt = now(); lastError = null; say(`connected ${short(s.id)}`); headDone(); } else sayLimited('back', 'the connection is back', 20);
      void sample(); echoSoon();
    } else if (st === 'disconnected') sayLimited('gone', 'the connection is interrupted - waiting for it to come back', 20);
    else if (st === 'failed') failSession(s, 'CONNECTION_FAILED', 'the connection failed');
  }

  // ---------- messages from the hub ----------
  function handle(m) {
    if (m.type === 'offer') {
      if (seen.includes(m.attempt)) return; // delivered again: it is already being answered (or was)
      seen.push(m.attempt); if (seen.length > SEEN_MAX) seen.shift();
      void answer(m);
    } else if (m.type === 'stop') {
      if (!session || session.id !== m.attempt) return;
      say(`stopped by the hub (${m.reason})`);
      // Closed at once, always. "replaced" means the hub has already taken a newer offer (her phone's own recovery, or a
      // takeover) and that offer is the next message in the queue: her last frame is held for what is left of its 3 s while
      // the new connection comes up, and black follows by itself if no new picture arrives. Every other stop (she pressed
      // stop, the offer ran out): black on the next draw.
      closeSession({ keepFrame: m.reason === 'replaced' }); lastError = null; echoSoon();
    } else if (m.type === 'capture') {
      if (!session || session.id !== m.attempt) return;
      capture = { video: m.video, audio: m.audio, visible: m.visible };
      if (!cameraAway(m)) captureBadSince = null; else if (captureBadSince == null) { captureBadSince = now(); sayLimited('away', 'the phone reports its camera away - the slate follows in 3 s', 20); }
    }
  }

  // ---------- the hub client: one long poll after the other (it never waits for an answer in the making) ----------
  function setLease(v) {
    if (lease === v) return;
    const was = lease; lease = v;
    if (v === 'held') { if (was === 'busy') sayLimited('ours', 'the program slot is ours now', 5); echoSoon(); }
  }
  async function pollLoop() {
    while (!stopped && !superseded) {
      const t0 = now(); polls++;
      const ctl = new win.AbortController(); pollAbort = ctl;
      const kill = win.setTimeout(() => ctl.abort(), POLL_TIMEOUT_MS);
      // not refused within a second = parked = the slot is ours. After failed polls (the gateway was away or restarted) that is
      // taken on trust much sooner: holding the slot sends the echo, and the echo is what lets a restarted hub adopt the running
      // link before the phone gives it up. An echo to a gateway that is still away is simply lost.
      const parked = win.setTimeout(() => { if (!stopped && !superseded) setLease('held'); }, pollFails ? RETRY_PARKED_MS : LEASE_PARKED_MS);
      let status = 0, body = null;
      try {
        const res = await win.fetch(`${gw}/api/link/program/poll?program=${pageId}&inst=${inst}&after=${after}&takeover=${opts.takeover ? 1 : 0}`, { method: 'GET', headers: keyHeaders, cache: 'no-store', credentials: 'omit', signal: ctl.signal });
        status = res.status;
        if (status !== 204) { try { body = await res.json(); } catch { body = null; } }
      } catch { status = 0; }
      win.clearTimeout(kill); win.clearTimeout(parked); pollAbort = null;
      if (stopped) return;
      const out = pollOutcome(status, body); let wait = 0;
      if (out.kind !== 'error' && pollFails) { pollFails = 0; sayLimited('up', 'the gateway answers again', 20); }
      if (out.kind === 'message' || out.kind === 'empty') {
        setLease('held');
        if (out.kind === 'empty') { if (now() - t0 < FAST_EMPTY_MS) wait = FAST_EMPTY_WAIT_MS; } // an empty reply that did not wait: never spin
        else {
          const m = out.message;
          if (m.seq <= after) wait = REPEAT_WAIT_MS; // the hub starts its numbers again (it was restarted), or repeats itself: follow it, without spinning
          after = m.seq;
          try { handle(m); } catch (e) { sayOnce('handle:' + (e && e.name), 'a hub message could not be handled: ' + (e && e.name)); }
        }
      } else if (out.kind === 'superseded') { // another page took the program slot over: this one stops for good
        superseded = true; lease = 'superseded'; headDone();
        say('another program page took the link over (PROGRAM_SUPERSEDED) - this page stops for good');
        closeSession(); lastError = 'PROGRAM_SUPERSEDED';
        win.clearInterval(statsTimer); win.clearInterval(echoInterval); win.clearTimeout(echoTimer);
        return;
      } else {
        after = 0; // whatever the hub holds for this page is asked for again from the start (handling is idempotent)
        if (out.kind === 'busy') { if (lease !== 'busy') { lease = 'busy'; sayLimited('busy', 'another program page holds the link (PROGRAM_BUSY) - asking again every 5 s', 5); } wait = BUSY_RETRY_MS; }
        else if (out.kind === 'denied') { setLease('none'); sayOnce('denied:' + out.code, `the gateway refuses this page (${out.code}) - asking again every 5 s`); wait = DENIED_RETRY_MS; }
        else { pollFails++; if (pollFails === 1) sayLimited('down', `the gateway does not answer (${out.code}) - trying again`, 20); if (pollFails >= 3) setLease('none'); wait = backoffMs(pollFails); }
      }
      if (wait) await sleep(wait);
    }
  }

  // ---------- audio: only with audio=1; a dedicated <audio>, never the engine's <video> ----------
  function silence() {
    if (au) au.muted = true;
    if (graph) { try { graph.src.disconnect(); graph.delay.disconnect(); } catch { /* already apart */ } graph = null; }
  }
  function detachAudio() {
    routing++; silence(); audioBlocked = false; sinkId = null; // (sinkNow keeps naming the output the next link will use)
    if (au) { try { au.pause(); } catch { /* not playing */ } try { au.srcObject = null; } catch { /* nothing attached */ } }
  }
  const audioPlaying = () => {
    const s = session;
    if (!opts.audio || !s || !s.audioTrack || !s.audioStream || sinkNow === 'no_sink' || audioBlocked) return false;
    if (s.audioTrack.readyState !== 'live' || s.audioTrack.muted) return false;
    return opts.adelayMs > 0 ? !!graph && !!actx && actx.state === 'running' : !!au && !au.paused && !au.muted;
  };
  async function findSink() { // the output whose label contains sink=…, or null: then the page stays silent (never the default speakers)
    try {
      const list = await nav.mediaDevices.enumerateDevices(), d = pickSink(list, opts.sink);
      if (!d) {
        if (sinksHidden(list)) sayOnce('sink-hidden', 'audio stays silent: the browser hides the output device names (this page has no microphone permission in this Chrome profile), so sink= cannot be matched');
        else sayOnce('sink-missing', `audio stays silent: no output device matches sink="${sinkLabel(opts.sink) || ''}"`);
      }
      return d;
    } catch { sayOnce('sink-error', 'audio stays silent: the output devices could not be listed'); return null; }
  }
  async function probeSink() { // no link yet: is the wanted output there? The operator sees it before she connects
    if (!opts.audio || !opts.sink || (session && session.audioStream)) return;
    const d = await findSink();
    if (session && session.audioStream) return;
    sinkNow = d ? (sinkLabel(d.label) || 'selected') : 'no_sink';
  }
  // A refused play() shows nothing in the picture: playing:false is reported and the first click or key press tries again.
  async function startAudio() {
    const mine = routing; if (!au) return;
    let refused = false;
    try { await au.play(); } catch (e) { refused = !!e && e.name === 'NotAllowedError'; } // (anything else: the stream was taken away meanwhile)
    if (routing !== mine) return;
    if (graph && actx && actx.state !== 'running') {
      try { await Promise.race([actx.resume(), sleep(500)]); } catch { /* still not allowed */ }
      if (routing !== mine) return;
      if (actx.state !== 'running') refused = true;
    }
    audioBlocked = refused;
    if (!refused) return;
    sayOnce('autoplay', 'audio is blocked by the autoplay policy - it starts with the first click or key press in this window');
    if (gestureArmed) return; gestureArmed = true;
    const again = () => {
      if (!session || !session.audioStream) return; // nothing to start now; the click itself still unlocks the next link's audio
      startAudio().then(() => { if (!audioBlocked) { gestureArmed = false; win.removeEventListener('pointerdown', again, true); win.removeEventListener('keydown', again, true); echoSoon(); } });
    };
    win.addEventListener('pointerdown', again, true); win.addEventListener('keydown', again, true);
  }
  async function routeAudio(s) {
    const mine = ++routing, live = () => session === s && routing === mine && !!s.audioStream;
    silence(); // nothing is heard until the output is known to be the right one
    let device = null;
    if (opts.sink) { device = await findSink(); if (!live()) return; if (!device) { sinkNow = 'no_sink'; sinkId = null; return; } }
    try {
      if (opts.adelayMs > 0) { // remote track -> delay line -> output; the muted <audio> stays, Chrome needs an element sink for remote WebRTC audio
        if (!actx) actx = new (win.AudioContext || win.webkitAudioContext)({ latencyHint: 'interactive' });
        if (device) { if (typeof actx.setSinkId !== 'function') throw new Error('unsupported'); await actx.setSinkId(device.deviceId); if (!live()) return; }
        const src = actx.createMediaStreamSource(s.audioStream), delay = actx.createDelay(Math.max(1, opts.adelayMs / 1000 + 0.1));
        delay.delayTime.value = opts.adelayMs / 1000; src.connect(delay); delay.connect(actx.destination);
        graph = { src, delay }; au.muted = true;
      } else {
        if (device) { if (typeof au.setSinkId !== 'function') throw new Error('unsupported'); await au.setSinkId(device.deviceId); if (!live()) return; }
        au.volume = 1; au.muted = false;
      }
    } catch (e) {
      silence();
      if (opts.sink) { sinkNow = 'no_sink'; sinkId = null; sayOnce('sink-set', 'audio stays silent: the output device could not be selected (' + ((e && e.name) || 'error') + ')'); }
      else sayOnce('audio-path', 'the audio path could not be built (' + ((e && e.name) || 'error') + ')');
      return;
    }
    sinkNow = device ? (sinkLabel(device.label) || 'selected') : 'default'; sinkId = device ? device.deviceId : null;
    if (device) sayOnce('sink:' + sinkNow, 'audio output: ' + sinkNow);
    await startAudio(); echoSoon();
  }
  async function attachAudio(s, track) {
    if (!au) { au = doc.createElement('audio'); au.muted = true; au.setAttribute('aria-hidden', 'true'); au.style.display = 'none'; (doc.body || doc.documentElement).appendChild(au); }
    s.audioStream = new win.MediaStream([track]);
    au.muted = true; au.srcObject = s.audioStream;
    await routeAudio(s);
  }
  async function recheckSink() { // the chosen output went away -> silent at once; it (or the wanted one) came -> route again
    const s = session; if (!s || !s.audioStream) return probeSink();
    let list; try { list = await nav.mediaDevices.enumerateDevices(); } catch { return; }
    if (session !== s) return;
    if (sinkId != null) {
      if (list.some(d => d && d.kind === 'audiooutput' && d.deviceId === sinkId)) return;
      silence(); sinkNow = 'no_sink'; sinkId = null; sayLimited('sink-gone', 'the audio output device went away - silent until it returns', 5); echoSoon();
    } else if (pickSink(list, opts.sink)) void routeAudio(s);
  }
  if (opts.audio && opts.sink) {
    if (nav.mediaDevices && nav.mediaDevices.addEventListener) nav.mediaDevices.addEventListener('devicechange', () => { win.clearTimeout(devTimer); devTimer = win.setTimeout(() => { recheckSink().catch(() => {}); }, 300); });
    probeSink().catch(() => {});
  }

  // ---------- timers, page events, start ----------
  const statsTimer = win.setInterval(() => {
    void sample();
    // a paused element shows no new frames: both are muted, so play() is always allowed (the engine's video only while it still plays OUR stream)
    for (const el of [session && session.videoTrack ? rx : null, feedStream && video.srcObject === feedStream ? video : null]) {
      if (el && el.paused) { try { const playing = el.play(); if (playing && playing.catch) playing.catch(() => {}); } catch { /* next tick */ } }
    }
    if (echoKey(snapshot()) !== lastEchoed) echoSoon(); // a change of state is told at once, not at the next full second
  }, STATS_MS);
  const echoInterval = win.setInterval(() => {
    const t = now(), dt = t - rateAt;
    if (dt >= 500) { rafHz = hz(rafCount, dt); drawHz = hz(drawCount, dt); rafCount = drawCount = 0; rateAt = t; }
    echoTick(false);
  }, ECHO_LIVE_MS);
  win.addEventListener('pagehide', () => { // the program slot is given back at once (a beacon cannot carry the key; the hub does not ask for it here)
    if (lease === 'held') { try { nav.sendBeacon(`${gw}/api/link/program/bye?program=${pageId}&inst=${inst}`); } catch { /* the lease then runs out by itself */ } }
    closeSession(); // and the connection is closed properly, so the phone learns it now and not when its checks time out
  });
  doc.addEventListener('visibilitychange', echoSoon);

  function stop() { // tests; the page itself never stops the receiver
    if (stopped) return; stopped = true;
    try { if (pollAbort) pollAbort.abort(); } catch { /* not in flight */ }
    win.clearInterval(statsTimer); win.clearInterval(echoInterval); win.clearTimeout(echoTimer); win.clearTimeout(devTimer); win.clearTimeout(headTimer); headDone();
    win.cancelAnimationFrame(rafId);
    closeSession();
  }

  const state = () => {
    const snap = snapshot(), s = session;
    return {
      state: snap.state, showing: snap.showing, attempt: snap.attempt, lastError: snap.lastError, lease, engineReady: engineReady(), hidden: snap.hidden,
      program: pageId, gateway: gw, hasKey, connection: s && s.pc ? s.pc.connectionState : null, gather: s ? s.gather : null,
      capture: capture ? { ...capture } : null, audio: { ...snap.audio, blocked: audioBlocked }, path: snap.path ? { ...snap.path } : null,
      options: { mirror: opts.mirror, audio: opts.audio, sink: opts.sink, adelayMs: opts.adelayMs, jbMs: opts.jbMs, takeover: opts.takeover },
      log: ring.map(e => ({ ...e })),
    };
  };
  const stats = () => ({ ...stateBody({ program: pageId, inst, ...snapshot() }).stats, polls, echoes, pollFails });
  const view = Object.freeze({ state, stats });
  try { Object.defineProperty(win, 'linkReceiver', { value: view, enumerable: true, configurable: false, writable: false }); } catch { /* the view is a convenience, the link does not depend on it */ }

  say(`receiver started - program ${pageId}, gateway ${gw}${hasKey ? ', key present' : ', no key'}${opts.takeover ? ', takeover' : ''}, mirror ${opts.mirror ? 'on' : 'off'}, audio ${opts.audio ? (opts.sink ? 'on (chosen output)' : 'on (default output)') : 'off'}`);
  if (where.rejected) say(`gw= ignored (${where.rejected})`);
  if (pk.found && !hasKey) say('the program key in the address could not be used');
  if (loc.hostname !== '127.0.0.1' && loc.hostname !== 'localhost') say('this page is not opened on 127.0.0.1 or localhost - the gateway answers the program page only there');
  rafId = win.requestAnimationFrame(frame);
  pollLoop().catch(e => say('the hub client stopped: ' + ((e && e.name) || 'error')));
  return { state, stats, stop, headStart };
}
