// THE BATTLE TARGET — the LIVE head of whoever is facing us in the battle (or the head the operator picks from the screen).
//
// The opponent's video is TikTok's: it is not in our broadcast, so nothing can be drawn on HIS screen. Instead his head is
// taken from the PHONE's battle screen and brought into OUR picture, where the effects are thrown at it / it is put on a body.
//
//   phone battle screen ──► all heads in the battle area (up to 5: 1v1, 2v2 "the four") ──► the target:
//                              • automatic = "the one facing me": the biggest head on the RIGHT half (the host is on the left)
//                              • or the head the operator picked (it is then followed from picture to picture)
//   the target head is cut out clean (hair + face, no room behind it, cut under the chin) and kept upright in a
//   384x384 "head picture": cheek-to-cheek midpoint at (HEAD.ax, HEAD.ay), forehead-top -> chin = HEAD.fh pixels.
//
// Two speeds:
//   idle : one snapshot of the phone every 2.5 s  (cheap; keeps the list of heads and a recent head ready)
//   live : while an effect needs the head (hold()): the phone's video stream, the head is followed ~7 times a second and
//          the picture inside the cut is the video itself, so the head MOVES (talks, laughs) on our screen. It is shown
//          a third of a second late, because only pictures in which he was SEEN are ever painted (see head()).
//          The stream is read and decoded in a worker (phone-stream-worker.js): the page is too busy to keep up with it.
//
// Privacy: pictures are only ever asked with ?need=tiktok — the server refuses unless TikTok is the app in front on the
// phone. A NEW target is taken only from a screen that is a battle right now (a head on BOTH halves); a picture older than
// 6 s is never used; when the server refuses, the picture and the target are dropped at once. Nothing is stored except the
// small round face the head-tomato uses (media/opponent/face.png, replaced every few seconds, deleted 50 s after the last
// one). And a picture is painted into our broadcast only if the target was seen in it or between two sightings of him:
// should the phone suddenly show something else, not one picture of it gets through — the head stands still, then leaves.
//
// MediaPipe is loaded when the tracker starts (not when this file is imported), so a page that cannot reach the CDN
// still runs everything else.
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// hair / face skin / body skin / clothes / accessories, per pixel -> an exact head shape
const HEAD_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

export const HEAD = { S: 384, ax: 192, ay: 215, fh: 150 };
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
// The face height (forehead top -> chin, mouth closed) is estimated two ways and the larger one is used:
//   forehead top -> under the nose (an open mouth does not change it; a head turned sideways does not either)
//   cheek to cheek (nodding up/down does not change it)
const NOSE_RATIO = 0.63, CHEEK_RATIO = 0.83;
const FRAME_MAX = 6000;   // a phone picture older than this is not used any more
const DELAY = 300;        // the live head is shown this many ms behind the phone, so that every picture shown already lies between two sightings
const LIVE_FPS = 20;      // pictures a second taken from the phone's stream while live (each one costs the page a texture upload)
const LIKE_MIN = 0.6;     // how much a sighting must look like the head seen a moment before (1 = the same picture, about 0 = unrelated), see _like()
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

export class Opponent {
  constructor(o = {}) {
    this.log = o.log || (() => {});
    this.snapUrl = o.snap ?? '/fx/phone.jpg?need=tiktok';
    this.streamUrl = o.stream === undefined ? '/fx/phone.mjpeg?need=tiktok' : o.stream; // null = this source has no video stream (snapshots only)
    this.videoUrl = o.video || null;                     // a video file standing in for the phone screen (tests / demos)
    this.region = o.region || [0, 0.15, 1, 0.63];        // the battle area on the phone screen: x0,y0,x1,y1 (fractions). Measured on a real 1v1: the two videos sit at y 0.207..0.605
    this.needHost = o.needHost !== false;                // a battle = a head on both halves
    this.upload = o.upload !== false;                    // keep the round face on the server (for other pages)
    this._enabled = true;                                // the operator's switch (see the enabled setter)
    this.heads = []; this.pick = null; this.cur = null; this.mask = null; this.maskAt = 0; this.valid = false; this.error = null;
    this.buf = [];                                       // the last phone pictures (while live: about 0.45 s of them), oldest first
    this.keys = [];                                      // the current run of sightings: { n, fat, M, H, roll } = where the head was in picture n
    this.out = canvas(HEAD.S, HEAD.S); this.octx = this.out.getContext('2d');
    this.crop = canvas(HEAD.S, HEAD.S); this.cctx = this.crop.getContext('2d');
    this.fastC = canvas(256, 256); this.fctx = this.fastC.getContext('2d');
    this.mraw = canvas(HEAD.S, HEAD.S); this.mrctx = this.mraw.getContext('2d');
    this.holds = 0; this.liveOn = false; this.liveRun = 0; this.frameNo = 0; this.miss = 0; this.started = false; this.ready = false;
  }

  // the operator's switch: off = the phone is not looked at and no head is given; it takes effect at once, also in the middle of an effect
  get enabled() { return this._enabled; }
  set enabled(v) { this._enabled = !!v; if (!v) this._forget(); this._sync(); }

  // ---------- start ----------
  async start() {
    if (this.started) return this; this.started = true;
    if (this.videoUrl && !this.video) {
      const v = this.video = document.createElement('video'); v.src = this.videoUrl; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.play().catch(() => {});
    }
    this._models().then(() => { if (!this.idleOn) { this.idleOn = true; this._idle(); } this._sync(); })
      .catch(e => { this.started = false; this.error = 'זיהוי הפנים לא נטען: ' + e.message; this.log(this.error); }); // not started: the next start() / hold() tries again
    return this;
  }
  async _models() {
    if (typeof globalThis.dbg !== 'function') globalThis.dbg = (...a) => console.debug('[mediapipe]', ...a); // see fx-engine.js
    const { FilesetResolver, FaceLandmarker, ImageSegmenter } = await import(VISION);
    const fs = await FilesetResolver.forVisionTasks(WASM);
    const face = d => FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: FACE_MODEL, delegate: d }, runningMode: 'IMAGE', numFaces: 5, minFaceDetectionConfidence: 0.4 });
    try { this.faceLm = await face('GPU'); } catch { this.faceLm = await face('CPU'); }
    // following ONE head between the full looks: video mode keeps the face's place from picture to picture and skips the search (about 40% cheaper)
    try { this.trackLm = await FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.4, minTrackingConfidence: 0.4 }); } catch { this.trackLm = null; }
    try { this.seg = await ImageSegmenter.createFromOptions(fs, { baseOptions: { modelAssetPath: HEAD_MODEL, delegate: 'GPU' }, runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false }); }
    catch (e) { this.seg = null; this.log('גזירת השיער לא זמינה, נשאר על גזירה לפי קו הפנים (' + e.message + ')'); }
    // the first call of each model compiles its GPU programs (seconds): do it now, not in the middle of an effect
    const w = canvas(256, 256); w.getContext('2d').fillRect(0, 0, 256, 256);
    try { this.faceLm.detect(w); } catch {}
    try { this.trackLm?.detectForVideo(w, performance.now()); } catch {}
    try { this.seg?.segment(this.crop).close(); } catch {}
    this.ready = true;
  }

  // ---------- pictures of the phone ----------
  _frame() {
    const v = this.video;
    if (v) return v.readyState >= 2 && v.videoWidth ? { src: v, w: v.videoWidth, h: v.videoHeight, at: performance.now(), n: Math.round(v.currentTime * 60) } : null;
    const f = this.frame; return f && performance.now() - f.at < FRAME_MAX ? f : null; // an old picture is never looked at again as if it were now
  }
  // at = when the picture came from the phone (the worker stamps it; decoding takes a moment).
  // part = { w, h, oy }: the bitmap is only a band of the phone picture (w x h), starting at row oy (the worker cuts the
  // battle area out). Positions everywhere stay in pixels of the WHOLE phone picture; _blit() takes care of the offset.
  _setFrame(bmp, at = performance.now(), part = null) {
    const f = this.frame = { src: bmp, w: part?.w || bmp.width, h: part?.h || bmp.height, oy: part?.oy || 0, at, n: ++this.frameNo }, B = this.buf; B.push(f);
    // while an effect is live the pictures of the last 0.55 s are kept (head() shows them a moment late); otherwise only the newest
    const max = this.liveOn ? 20 : 1;
    while (B.length > max || (B.length > 1 && f.at - B[0].at > 550)) { try { B.shift().src.close?.(); } catch {} }
  }
  // the server refused / the phone is gone: forget the picture and the target at once
  // drawImage from a phone picture, with the source rectangle given in pixels of the whole phone picture
  _blit(ctx, f, sx, sy, sw, sh, dx, dy, dw, dh) { ctx.drawImage(f.src, sx, sy - (f.oy || 0), sw, sh, dx, dy, dw, dh); }
  _drop(msg) {
    for (const b of this.buf) { try { b.src.close?.(); } catch {} } this.buf = []; this.frame = null;
    this._forget(); this.valid = false; this.battleAt = undefined; this.heads = []; this.headsAt = performance.now();
    if (msg) this.error = msg;
  }
  async _snapshot() {
    const r = await fetch(this.snapUrl + (this.snapUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) { const msg = r.status === 409 ? 'הטלפון לא ב-TikTok כרגע' : 'אין תמונה מהטלפון (מחובר ב-ADB?)'; this._drop(msg); throw new Error(msg); }
    this._setFrame(await createImageBitmap(await r.blob()));
  }
  // The phone's video stream is read and decoded in a worker: the page itself is busy with tracking and effects, and
  // reading there keeps only about one picture in three. Every picture arrives as a ready ImageBitmap, stamped with the
  // moment its bytes came in. Returns false when workers cannot be used here (then _stream reads it in the page).
  _streamInWorker(url) {
    if (this.noWorker) return false;
    let w = this.worker;
    try { w ||= this.worker = new Worker(new URL('./phone-stream-worker.js', import.meta.url)); } catch { this.noWorker = true; return false; }
    const id = this.streamId = (this.streamId || 0) + 1, tok = this._ac = { n: 0, abort: () => { try { w.postMessage({ stop: true }); } catch {} } };
    w.onmessage = e => {
      const m = e.data;
      if (m.id !== id || this._ac !== tok) { m.bmp?.close?.(); return; }                  // from a stream that was already closed
      if (m.bmp) { if (m.n > tok.n) { tok.n = m.n; this._setFrame(m.bmp, Math.min(performance.now(), m.t - performance.timeOrigin), m); } else m.bmp.close(); return; }
      // it is over: refused (TikTok is not in front), closed by the server (TikTok left the front, the phone was unplugged) or failed
      this._drop(m.status === 409 ? 'הטלפון לא ב-TikTok כרגע' : m.status && m.status !== 200 ? 'אין וידאו מהטלפון (מחובר ב-ADB?)' : m.error || 'הווידאו מהטלפון נעצר');
      this._ac = null; if (this.liveOn) setTimeout(() => this.liveOn && this._stream(), 1500);   // still needed -> try again
    };
    w.onerror = () => { // the worker cannot run here: read the stream in the page
      this.noWorker = true; try { w.terminate(); } catch {} this.worker = null;
      if (this._ac === tok) { this._ac = null; if (this.liveOn) this._stream(); }
    };
    w.postMessage({ url: new URL(url, location.href).href, id, crop: [this.region[1], this.region[3]], fps: LIVE_FPS });
    return true;
  }
  // the same stream read in the page (multipart JPEG, split by hand) — only where a worker is not available
  async _stream() {
    if (this._ac || !this.streamUrl || this.video) return;
    const url = this.streamUrl + (this.streamUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    if (this._streamInWorker(url)) return;
    const ac = this._ac = new AbortController();
    try {
      const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!r.ok || !r.body) throw new Error(r.status === 409 ? 'הטלפון לא ב-TikTok כרגע' : 'אין וידאו מהטלפון (מחובר ב-ADB?)');
      const rd = r.body.getReader(), td = new TextDecoder('latin1'); let buf = new Uint8Array(0), busy = false;
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb;
        for (;;) {
          let h = -1; for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) { h = i; break; }
          if (h < 0) break;
          const m = /content-length:\s*(\d+)/i.exec(td.decode(buf.subarray(0, h)));
          if (!m) { buf = buf.subarray(h + 4); continue; }
          const n = +m[1]; if (buf.length < h + 4 + n) break;
          const jpg = buf.slice(h + 4, h + 4 + n); buf = buf.subarray(h + 4 + n);
          if (!busy) { busy = true; createImageBitmap(new Blob([jpg], { type: 'image/jpeg' })).then(b => { if (this._ac === ac) this._setFrame(b); else b.close?.(); }).catch(() => {}).finally(() => { busy = false; }); } // a picture still decoding -> skip this one
        }
        if (buf.length > 2e7) buf = new Uint8Array(0);
      }
      if (this._ac === ac) this._drop('הווידאו מהטלפון נעצר'); // the server closed it (TikTok left the front / the phone was unplugged)
    } catch (e) { if (e.name !== 'AbortError' && this._ac === ac) this._drop(e.message); }
    if (this._ac === ac) { this._ac = null; if (this.liveOn) setTimeout(() => this.liveOn && this._stream(), 1500); } // still needed -> try again
  }

  // ---------- idle: a snapshot every 2.5 s ----------
  _idle() {
    const tick = async () => {
      try {
        if (this.enabled && this.ready) { // switched off = the phone is not looked at at all
          const noStream = !this.video && !this.streamUrl; // a source without a video stream keeps taking snapshots while live
          if (!this.liveOn || noStream) { if (!this.video) await this._snapshot(); if (!this.liveOn) { this._full(); if (this.cur && this.cur.at >= (this.lookAt || 0)) this._segment(); } }
        }
      } catch (e) { this.error = e.message; }
      setTimeout(tick, 2500);
    };
    tick();
  }

  // ---------- live: hold() while an effect needs the moving head ----------
  hold() {
    if (!this.enabled) return () => {};                 // switched off: no stream, no model calls
    this.holds++; this._sync(); let done = false;
    return () => { if (done) return; done = true; this.holds--; setTimeout(() => this._sync(), 2500); };
  }
  // live exactly while somebody holds it, the switch is on and the models are loaded
  _sync() {
    if (this.holds > 0 && !this.started) { this.start(); return; }
    const on = this.holds > 0 && this.ready && this.enabled;
    if (on === this.liveOn) return;
    this.liveOn = on;
    if (!on) { this._ac?.abort(); this._ac = null; return; }
    this.liveSince = performance.now(); this._stream();
    const run = ++this.liveRun;                           // only the newest loop keeps going
    const step = () => {
      if (!this.liveOn || run !== this.liveRun) return;
      const now = performance.now();
      try {
        const f = this._frame();
        if (f) {
          // a full look every 1.5 s (with no target: once a second), and only at a picture that was not looked at yet
          if (f.n !== this.fullN && now - (this.fullAt || 0) > (this.cur ? 1500 : 1000)) { this.fullAt = now; this.fullN = f.n; this._full(); }
          else if (this.cur && f.n !== this.lastN && now - (this.fastAt || 0) > 140) { this.fastAt = now; this.lastN = f.n; this._fast(); }
          else if (this.cur && this.cur.at > (this.segFor || 0) && now - (this.segAt || 0) > 250) { this._segment(); }
        }
      } catch (e) { this.error = e.message; }
      setTimeout(step, 20);
    };
    step();
  }

  // ---------- measuring one head from its 478 points (in phone-picture pixels) ----------
  _measure(P) {
    const M = { x: (P[234].x + P[454].x) / 2, y: (P[234].y + P[454].y) / 2 };
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const i of OVAL) { const p = P[i]; if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    return { M, H: Math.max(dist(P[10], P[2]) / NOSE_RATIO, dist(P[234], P[454]) / CHEEK_RATIO), roll: Math.atan2(P[263].y - P[33].y, P[263].x - P[33].x), chin: { x: P[152].x, y: P[152].y }, oval: OVAL.map(i => ({ x: P[i].x, y: P[i].y })), box: { x0, y0, x1, y1 } };
  }
  _update(m, f) {
    const now = performance.now(), p = this.cur && now - this.cur.at < 450 ? this.cur : null;
    if (!p) { this.cur = { ...m, at: now, v: { x: 0, y: 0 } }; this.keys = []; return this._seen(f); } // a new run of sightings starts here
    // light smoothing so the head does not shiver; a fast move still follows at once
    const k = clamp(0.45 + dist(m.M, p.M) / (m.H * 0.2)), mix = (a, b, t) => a + (b - a) * t;
    let dr = m.roll - p.roll; while (dr > Math.PI) dr -= 2 * Math.PI; while (dr < -Math.PI) dr += 2 * Math.PI;
    const M = { x: mix(p.M.x, m.M.x, k), y: mix(p.M.y, m.M.y, k) }, dt = Math.max(16, now - p.at), v = { x: mix(p.v?.x || 0, (M.x - p.M.x) / dt, 0.5), y: mix(p.v?.y || 0, (M.y - p.M.y) / dt, 0.5) };
    this.cur = { ...m, M, v, H: mix(p.H, m.H, 0.22), roll: p.roll + dr * 0.5, at: now }; // the size changes slowly (he does not jump towards the camera): smoothing it keeps the head from pulsing
    this._seen(f);
  }
  // every sighting is remembered together with the picture it was made on (see head())
  _seen(f) {
    if (!f || this.video) return;
    const k = { n: f.n, fat: f.at, M: this.cur.M, H: this.cur.H, roll: this.cur.roll }, K = this.keys;
    if (K.length && K[K.length - 1].n >= f.n) K[K.length - 1] = k; else K.push(k);
    if (K.length > 10) K.shift();
  }
  // the target is gone or replaced: nothing of him is kept
  _forget() { this.cur = null; this.keys = []; this._key = null; }
  // What a face looks like: a 16x16 grey thumbnail (brightness and contrast taken out) of the square around it in canvas
  // "src" (centre cx,cy; half-size r). Two thumbnails are compared with _like(): 1 = the same picture, about 0 = unrelated.
  // The follower may "see" a face for one picture where there is none, and another app may show somebody's photo at the
  // very same place — a sighting therefore counts only when it looks like the head seen a moment before.
  _thumb(src, cx, cy, r) {
    const c = this.tC ||= (() => { const k = canvas(16, 16); k.x = k.getContext('2d', { willReadFrequently: true }); return k; })();
    c.x.fillStyle = '#777'; c.x.fillRect(0, 0, 16, 16); c.x.drawImage(src, cx - r, cy - r, 2 * r, 2 * r, 0, 0, 16, 16);
    const d = c.x.getImageData(0, 0, 16, 16).data, v = new Float32Array(256); let m = 0;
    for (let i = 0; i < 256; i++) { v[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; m += v[i]; }
    m /= 256; let s = 0; for (let i = 0; i < 256; i++) { v[i] -= m; s += v[i] * v[i]; }
    s = Math.sqrt(s) || 1; for (let i = 0; i < 256; i++) v[i] /= s;
    return v;
  }
  _like(a, b) { let s = 0; for (let i = 0; i < 256; i++) s += a[i] * b[i]; this.likeLast = s; return s; }
  _tellPick(pick) { fetch('/api/opponent-pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick: pick && { fx: pick.fx, fy: pick.fy } }) }).catch(() => {}); }

  // ---------- all the heads in the battle area (every 1.5 s while live, every snapshot while idle) ----------
  _full() {
    const f = this._frame(); if (!f || !this.faceLm) return;
    const now = this.lookAt = performance.now(); this.fullN = f.n;
    const [rx0, ry0, rx1, ry1] = this.region, rw = (rx1 - rx0) * f.w, rh = (ry1 - ry0) * f.h, sc = 640 / rw, kh = Math.max(8, Math.round(rh * sc));
    const k = this.fullC ||= canvas(640, kh); if (k.height !== kh) k.height = kh;
    this._blit(k.getContext('2d'), f, rx0 * f.w, ry0 * f.h, rw, rh, 0, 0, 640, kh);
    const mid = (rx0 + rx1) / 2 * f.w;
    const heads = (this.faceLm.detect(k).faceLandmarks || []).map(L => this._measure(L.map(p => ({ x: rx0 * f.w + p.x * 640 / sc, y: ry0 * f.h + p.y * kh / sc }))))
      .filter(h => h.H > f.w * 0.045 && Math.abs(h.M.x - mid) > 0.3 * (h.box.x1 - h.box.x0))  // big enough, and clearly on one side (one host in the middle of a normal LIVE sits ON the middle line: not a battle)
      .map(h => ({ ...h, side: h.M.x < mid ? 'L' : 'R', fx: h.M.x / f.w, fy: h.M.y / f.h }))
      .sort((a, b) => Math.abs(a.fy - b.fy) > 0.08 ? a.fy - b.fy : a.fx - b.fx);              // top row first, left to right
    const hasL = heads.some(h => h.side === 'L'), right = heads.filter(h => h.side === 'R');
    // a battle = a head on both halves, seen in THIS look. Once seen, the head already being followed is kept for 12 s
    // (one look that misses the host — she turned, covered her face — must not take the target away in the middle of
    // an effect), but a NEW target is only ever taken from a screen that is a battle right now.
    const battleNow = heads.length > 0 && (!this.needHost || (hasL && right.length > 0));
    if (battleNow) this.battleAt = now;
    this.valid = now - (this.battleAt ?? -1e9) < 12000;
    const near = (fx, fy) => { let b = null, bd = 1e9; for (const h of heads) { const d = Math.hypot(h.fx - fx, (h.fy - fy) * f.h / f.w); if (d < bd) { bd = d; b = h; } } return b && bd < Math.max(0.12, b.H / f.w) ? b : null; };
    let t = null;
    if (this.pick) {
      // the picked head, followed by its place. Not on screen: hidden for a moment (the other heads are all still there)
      // -> wait up to 20 s; the screen has changed (another battle, another layout) -> 4 s. Then back to automatic, everywhere.
      t = near(this.pick.fx, this.pick.fy);
      if (t) this.pick = { fx: t.fx, fy: t.fy, seen: now, n: this.pick.n || heads.length };
      else if (now - (this.pick.seen || 0) > (this.pick.n && heads.length !== this.pick.n - 1 ? 4000 : 20000)) { this.pick = null; this._forget(); this._tellPick(null); this.onPick?.(null); }
    } else if (this.cur && now - this.cur.at < 6000) {
      // automatic, and somebody is being followed: he STAYS the target (two heads of similar size must not swap, and one
      // look that misses him must not hand the effect to his neighbour)
      t = near(this.cur.M.x / f.w, this.cur.M.y / f.h); if (t && t.side !== 'R') t = null;
    } else if (battleNow) t = [...right].sort((a, b) => b.H - a.H)[0] || null; // "the one facing me" = the biggest head on the right
    // He must be on a battle screen right now, or look like the head seen a moment before: inside the 12 s of grace a
    // face that merely sits where he was (another screen, somebody's photo) is nobody.
    if (t) { t.look = this._thumb(k, (t.M.x - rx0 * f.w) * sc, (t.M.y - ry0 * f.h) * sc, t.H * sc * 0.6); if (!battleNow && !(this.look && this._like(t.look, this.look) >= LIKE_MIN)) t = null; }
    // small round pictures of every head for the operator's chooser
    for (const h of heads) { const s = 72, c = canvas(s, s), x = c.getContext('2d'), side = h.H * 1.9; x.beginPath(); x.arc(s / 2, s / 2, s / 2, 0, 7); x.clip(); this._blit(x, f, h.M.x - side / 2, h.M.y - side * 0.56, side, side, 0, 0, s, s); h.thumb = c; h.target = h === t; }
    this.heads = heads; this.headsAt = performance.now(); this.targetIdx = t ? heads.indexOf(t) : -1;
    if (!this.valid || !t) {
      this.error = !this.valid ? (heads.length ? 'אין קרב על מסך הטלפון (צריך יוצר/ת בצד שמאל ויריב בצד ימין)' : 'לא נמצאו ראשים במסך הקרב בטלפון') : this.pick ? 'הראש שנבחר לא נראה כרגע' : 'היריב לא נראה כרגע בצד ימין של מסך הקרב';
      if (!this.valid) this._forget(); // no battle on the phone any more. (Only the target is missing in this look: the fast follower keeps him.)
      return;
    }
    this.error = null; this.miss = 0; this.look = t.look; this._update(t, f);
    if (!battleNow) return;
    // the small round face (head-tomato, other pages) — only from a screen that is a battle right now
    const S = 320, o = canvas(S, S), ox = o.getContext('2d'), side = t.H * 1.9;
    ox.beginPath(); ox.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ox.clip(); this._blit(ox, f, t.M.x - side / 2, t.M.y - side * 0.56, side, side, 0, 0, S, S);
    this.still = o; this.stillAt = performance.now(); this.onStill?.(o);
    if (this.upload && this.enabled && (!this.upAt || performance.now() - this.upAt > 8000)) { this.upAt = performance.now(); o.toBlob(b => b && fetch('/api/opponent-face', { method: 'POST', body: b }).catch(() => {}), 'image/png'); }
  }

  // ---------- following the target between two full looks (fast: only the area around it) ----------
  // the part of the phone picture that belongs to a head at x: its own side of the middle line, inside the battle area
  _tile(f, x) { const [rx0, ry0, rx1, ry1] = this.region, mid = (rx0 + rx1) / 2 * f.w; return { x0: x < mid ? rx0 * f.w : mid, x1: x < mid ? mid : rx1 * f.w, y0: ry0 * f.h, y1: ry1 * f.h }; }
  _fast() {
    const f = this._frame(), c = this.cur; if (!f || !c) return;
    // a tight square around the head, and only pixels of his own side (the person next to him is painted grey)
    const T = this._tile(f, c.M.x), side = c.H * 2.4, sx = c.M.x - side / 2, sy = c.M.y - side * 0.55, S = 256, x = this.fctx, k = S / side;
    const ax0 = Math.max(sx, T.x0), ay0 = Math.max(sy, T.y0), ax1 = Math.min(sx + side, T.x1), ay1 = Math.min(sy + side, T.y1);
    x.fillStyle = '#777'; x.fillRect(0, 0, S, S); if (ax1 > ax0 && ay1 > ay0) this._blit(x, f, ax0, ay0, ax1 - ax0, ay1 - ay0, (ax0 - sx) * k, (ay0 - sy) * k, (ax1 - ax0) * k, (ay1 - ay0) * k);
    const ts = this.trackTs = Math.max((this.trackTs || 0) + 1, performance.now());
    const all = (this.trackLm ? this.trackLm.detectForVideo(this.fastC, ts) : this.faceLm.detect(this.fastC)).faceLandmarks || [];
    let best = null, bd = 1e9; for (const L of all) { const d = Math.hypot((L[234].x + L[454].x) / 2 - 0.5, (L[234].y + L[454].y) / 2 - 0.55); if (d < bd) { bd = d; best = L; } }
    if (!best || bd > 0.3) { if (++this.miss > 8) { this._forget(); this.error = 'היריב לא נראה כרגע'; } return; }
    const m = this._measure(best.map(p => ({ x: sx + p.x * side, y: sy + p.y * side })));
    if (dist(m.M, c.M) > c.H * 0.7 || m.H > c.H * 1.6 || m.H < c.H * 0.6) { if (++this.miss > 8) this._forget(); return; } // a jump like that is another face, not him moving
    const look = this._thumb(this.fastC, (m.M.x - sx) * k, (m.M.y - sy) * k, m.H * k * 0.6);
    if (!this.look || this._like(look, this.look) < LIKE_MIN) { if (++this.miss > 8) this._forget(); return; } // a face there, but not the one seen a moment ago
    this.look = look; this.miss = 0; this._update(m, f);
  }

  // phone picture -> the upright head picture (cheek midpoint at ax,ay; face height fh)
  _norm(ctx, f, c) {
    const S = HEAD.S, s = HEAD.fh / c.H, half = S / s * 0.75;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, S, S);
    ctx.translate(HEAD.ax, HEAD.ay); ctx.rotate(-c.roll); ctx.scale(s, s); ctx.translate(-c.M.x, -c.M.y);
    const T = this._tile(f, c.M.x), x0 = Math.max(0, T.x0, c.M.x - half), y0 = Math.max(0, T.y0, c.M.y - half), x1 = Math.min(f.w, T.x1, c.M.x + half), y1 = Math.min(f.h, T.y1, c.M.y + half); // only his own side of the battle screen
    if (x1 > x0 && y1 > y0) this._blit(ctx, f, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  _toHead(c, p) { const s = HEAD.fh / c.H, dx = p.x - c.M.x, dy = p.y - c.M.y, co = Math.cos(-c.roll), si = Math.sin(-c.roll); return { x: HEAD.ax + (dx * co - dy * si) * s, y: HEAD.ay + (dx * si + dy * co) * s }; }

  // ---------- the cut: hair + face (+ glasses, hat), a short soft piece of neck, nothing else ----------
  _segment() {
    // the cut is made on the very picture of the last sighting, so the shape and the place belong together
    const K = this.keys, c = this.cur, f = (!this.video && K.length && this.buf.find(b => b.n === K[K.length - 1].n)) || this._frame(); if (!f || !c) return;
    this.segAt = performance.now(); this.segFor = c.at;
    const S = HEAD.S, chin = this._toHead(c, c.chin), fh = HEAD.fh;
    if (this.seg) {
      try {
        this._norm(this.cctx, f, c);
        const r = this.seg.segment(this.crop), cm = r.categoryMask, cat = cm.getAsUint8Array(), mw = cm.width, mh = cm.height;
        if (cat.length === mw * mh && mw === S && mh === S) {
          const keep = this._keep ||= new Uint8Array(S * S), out = this._id ||= this.mrctx.createImageData(S, S), d = out.data, stack = this._stack ||= new Int32Array(S * S);
          const neckX = fh * 0.42, neckBottom = chin.y + fh * 0.16, hairBottom = chin.y + fh * 0.30;
          for (let y = 0, i = 0; y < S; y++) for (let x = 0; x < S; x++, i++) {
            const k = cat[i]; let a = 0;
            if (k === 3) a = y <= chin.y + fh * 0.07 ? 255 : 0;                                              // face skin
            else if (k === 1) a = y <= hairBottom ? Math.round(255 * clamp((hairBottom - y) / (fh * 0.14))) : 0; // hair (long hair fades out under the chin)
            else if (k === 5) a = y <= chin.y + fh * 0.03 ? 255 : 0;                                         // glasses, hat, earrings
            else if (k === 2) a = y > chin.y - fh * 0.45 && y < neckBottom && Math.abs(x - chin.x) < neckX ? Math.round(255 * clamp((neckBottom - y) / (fh * 0.13))) : 0; // ears / the top of the neck, fading
            keep[i] = a;
          }
          // only the blob that contains the face (a neighbour's hair at the edge is dropped)
          d.fill(0); let seed = -1;
          for (let r2 = 0; r2 < 40 && seed < 0; r2 += 4) for (let a = 0; a < 8 && seed < 0; a++) { const x = Math.round(HEAD.ax + Math.cos(a * 0.785) * r2), y = Math.round(HEAD.ay + Math.sin(a * 0.785) * r2), i = y * S + x; if (keep[i]) seed = i; }
          if (seed >= 0) {
            let n = 0; stack[n++] = seed; const seen = this._seen ||= new Uint8Array(S * S); seen.fill(0); seen[seed] = 1;
            while (n) { const i = stack[--n], x = i % S; d[i * 4 + 3] = keep[i];
              if (x > 0 && keep[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[n++] = i - 1; }
              if (x < S - 1 && keep[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[n++] = i + 1; }
              if (i >= S && keep[i - S] && !seen[i - S]) { seen[i - S] = 1; stack[n++] = i - S; }
              if (i < S * (S - 1) && keep[i + S] && !seen[i + S]) { seen[i + S] = 1; stack[n++] = i + S; } }
            this.mrctx.putImageData(out, 0, 0);
            // never wider than the picture itself (the edge of the phone screen, the middle line): no head pixels there
            this.mrctx.globalCompositeOperation = 'destination-in'; this.mrctx.drawImage(this.crop, 0, 0); this.mrctx.globalCompositeOperation = 'source-over';
            this._soften(); r.close(); return;
          }
        }
        r.close();
      } catch (e) { this.segError = e.message; }
    }
    // no hair model (or it found nothing): the face outline, widened upward for the forehead and hair
    const x = this.mrctx; x.clearRect(0, 0, S, S); x.fillStyle = '#000'; x.beginPath();
    c.oval.forEach((p, i) => { const q = this._toHead(c, p), dx = q.x - HEAD.ax, dy = q.y - HEAD.ay, up = dy < 0; const X = HEAD.ax + dx * (up ? 1.2 : 1.05), Y = HEAD.ay + dy * (up ? 1.5 : 1.04); i ? x.lineTo(X, Y) : x.moveTo(X, Y); });
    x.closePath(); x.fill(); this._soften(3);
  }
  _soften(blur = 1.3) { // soft edge + fade to nothing at the border of the head picture
    const S = HEAD.S, m = this.mask ||= canvas(S, S), x = m.getContext('2d');
    x.globalCompositeOperation = 'copy'; x.filter = `blur(${blur}px)`; x.drawImage(this.mraw, 0, 0); x.filter = 'none';
    x.globalCompositeOperation = 'destination-in';
    const g = this._edge ||= (() => { const e = canvas(S, S), ex = e.getContext('2d'); ex.filter = 'blur(7px)'; ex.fillRect(12, 12, S - 24, S - 24); return e; })();
    x.drawImage(g, 0, 0); x.globalCompositeOperation = 'source-over';
    this.maskAt = performance.now();
  }

  // ---------- what the effects use ----------
  // is there a usable target right now?  live: followed within the last 1.6 s (the first 1.6 s of a hold may still use the
  // head from the last idle look);  idle: found in the LATEST look, and that look is not older than 30 s
  _has(now) {
    const c = this.cur; if (!this.enabled || !c || !this.mask || !this.valid) return false;
    if (this.liveOn) return now - Math.max(c.at, this.liveSince || 0) <= 1600;
    return c.at >= (this.lookAt || 0) && now - c.at <= 30000;
  }
  // the phone picture to show now: DELAY behind the newest, and never one outside the current run of sightings
  _shown(now) {
    const K = this.keys; if (!K.length) return null;
    const a = K[0].n, z = K[K.length - 1].n, T = now - DELAY; let f = null;
    for (const b of this.buf) { if (b.n < a) continue; if (b.n > z) break; if (!f || b.at <= T) f = b; else break; }
    return f && now - f.at <= FRAME_MAX ? f : null;
  }
  // where the head is in that picture: between the sighting before it and the one after it
  _poseAt(f) {
    const K = this.keys; let i = 0; while (i < K.length - 1 && K[i + 1].n <= f.n) i++;
    const a = K[i], b = K[i + 1]; if (!b || a.n >= f.n || b.fat <= a.fat) return a;
    const t = clamp((f.at - a.fat) / (b.fat - a.fat)); let dr = b.roll - a.roll; while (dr > Math.PI) dr -= 2 * Math.PI; while (dr < -Math.PI) dr += 2 * Math.PI;
    return { M: { x: a.M.x + (b.M.x - a.M.x) * t, y: a.M.y + (b.M.y - a.M.y) * t }, H: a.H + (b.H - a.H) * t, roll: a.roll + dr * t };
  }
  // head(now) -> { canvas, sticker(), ax, ay, fh } (the cut-out head, upright) or null when there is no target right now
  head(now = performance.now()) {
    if (!this._has(now)) return null;
    const c = this.cur, x = this.octx, paint = (f, pose) => { this._norm(x, f, pose); x.globalCompositeOperation = 'destination-in'; x.drawImage(this.mask, 0, 0); x.globalCompositeOperation = 'source-over'; };
    if (this.video) {
      // a video file standing in for the phone (tests, demos): its newest picture, the cut moved along with the head's speed
      const f = this._frame(); if (!f) return null;
      const key = f.n + ':' + c.at + ':' + this.maskAt;
      if (key !== this._key) { this._key = key; const dt = this.liveOn && c.v ? Math.min(160, Math.max(0, f.at - c.at)) : 0; paint(f, dt ? { ...c, M: { x: c.M.x + c.v.x * dt, y: c.M.y + c.v.y * dt } } : c); }
    } else {
      // the phone: only a picture in which he was SEEN is painted — one that lies between two sightings of the follower
      // (that is why it is shown DELAY late). A picture not confirmed yet is never painted: when he is covered for a
      // moment, or the screen suddenly shows something else, the head stands still (at most ~2 s) until he is seen again.
      const f = this._shown(now);
      if (f) { this.shownAt = now; const key = f.n + ':' + this.maskAt; if (key !== this._key) { this._key = key; paint(f, this._poseAt(f)); } }
      else if (!this._key || !this.liveOn || now - (this.shownAt || 0) > 1800) return null;
    }
    // sticker(): the same head with a white cut-out edge and a soft shadow (made only when asked for, once per picture).
    // The edge is grown from the pixels that are really drawn, so a head cut by the side of his video gets no white slab.
    const sticker = () => {
      const S = HEAD.S, s = this.outS ||= canvas(S, S);
      if (this._skey !== this._key) { this._skey = this._key;
        const rim = this.rim ||= canvas(S, S), rx = rim.getContext('2d');
        rx.globalCompositeOperation = 'copy'; rx.filter = 'blur(3.5px)'; rx.drawImage(this.out, 0, 0); rx.filter = 'none';
        rx.globalCompositeOperation = 'source-over'; for (let i = 0; i < 7; i++) rx.drawImage(rim, 0, 0);   // the blurred edge becomes solid = the shape grown by ~4 px
        rx.globalCompositeOperation = 'source-in'; rx.fillStyle = '#fff'; rx.fillRect(0, 0, S, S); rx.globalCompositeOperation = 'source-over';
        const x = s.getContext('2d'); x.clearRect(0, 0, S, S); x.save(); x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 9; x.shadowOffsetY = 4; x.drawImage(rim, 0, 0); x.restore(); x.drawImage(this.out, 0, 0); }
      return s;
    };
    return { canvas: this.out, sticker, ax: HEAD.ax, ay: HEAD.ay, fh: HEAD.fh };
  }
  // the small round face (kept for the head-tomato): only while fresh
  face(now = performance.now()) { return this.enabled && this.still && now - (this.stillAt || 0) < 30000 ? this.still : null; }
  // the operator picks a head: its index in this.heads, or null = automatic (the one facing me)
  choose(i, { tell = true } = {}) {
    const h = i == null ? null : this.heads[i];
    this.pick = h ? { fx: h.fx, fy: h.fy, seen: performance.now(), n: this.heads.length } : null; this._forget();
    if (tell) this._tellPick(this.pick);
    try { if (this.ready && this._frame()) { this._full(); if (this.cur) this._segment(); } } catch {}
    return this.pick;
  }
  // a pick made on another page (panel -> clean layer)
  applyPick(p) { if (!p) { if (this.pick) { this.pick = null; this._forget(); } return; } if (!this.pick || Math.hypot(this.pick.fx - p.fx, this.pick.fy - p.fy) > 0.03) { this.pick = { fx: p.fx, fy: p.fy, seen: performance.now() }; this._forget(); } }
  status() {
    if (!this.enabled) return 'כבוי';
    if (!this.ready) return this.error || 'טוען זיהוי פנים…';
    if (this._has(performance.now())) return `${this.pick ? 'הראש שבחרת' : 'מי שמולך'} זוהה ✓ · ${this.heads.length} ראשים במסך הקרב${this.liveOn ? ' · חי' : ''}`;
    return this.error || 'מחפש את היריב במסך הקרב בטלפון…';
  }
}

// ---------- a head from a STILL picture: a supporter's profile picture ----------
// AvatarHeads.get(url) -> Promise<{ canvas, sticker(), ax, ay, fh, face } | null>: the same kind of cut-out head the battle
// target gives (hair + face, upright, same anchor), made once from one picture and kept. A picture with no face in it
// (a logo, a drawing, a group photo) becomes a round badge of the whole picture, placed where a head would be.
// opp: () => the Opponent of this page, if there is one — its models are used instead of loading them a second time.
export class AvatarHeads {
  constructor(opp = () => null) { this.opp = opp; this.cache = new Map(); }
  // load the cutter ahead of time (the first profile picture would otherwise wait for the models: seconds)
  warm() { return this._cutter().then(() => true, () => false); }
  get(url) {
    if (!url) return Promise.resolve(null);
    if (!this.cache.has(url)) {
      if (this.cache.size >= 60) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(url, this._make(url).catch(() => { this.cache.delete(url); return null; }));
    }
    return this.cache.get(url);
  }
  // a private Opponent used only as a cutter (it never looks at the phone); a profile picture is ONE picture, not two halves
  async _cutter() {
    if (this.cut) return this.cut;
    const o = this.opp(), h = new Opponent({ snap: null, stream: null, upload: false, needHost: false, region: [0, 0, 1, 1] });
    h._tile = f => ({ x0: 0, x1: f.w, y0: 0, y1: f.h });
    if (o?.started) for (let i = 0; i < 80 && o.started && !o.ready; i++) await new Promise(r => setTimeout(r, 100)); // its models are on their way: wait for them
    if (o?.ready) { h.faceLm = o.faceLm; h.seg = o.seg; h.ready = true; } else await h._models();
    return this.cut = h;
  }
  async _make(url) {
    const im = await new Promise((ok, no) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = () => no(new Error('no picture')); i.src = url; });
    const S = HEAD.S, out = canvas(S, S), ox = out.getContext('2d'), w = im.naturalWidth, hh = im.naturalHeight;
    let face = false, h = null; try { h = await this._cutter(); } catch { /* no models (offline): the round badge below still works */ }
    if (h && w > 8 && hh > 8) try {
      const sc = Math.min(1, 640 / Math.max(w, hh)), k = canvas(Math.max(8, Math.round(w * sc)), Math.max(8, Math.round(hh * sc)));
      k.getContext('2d').drawImage(im, 0, 0, k.width, k.height);
      const all = (h.faceLm.detect(k).faceLandmarks || []).map(L => h._measure(L.map(p => ({ x: p.x * w, y: p.y * hh })))).sort((a, b) => b.H - a.H);
      if (all[0] && all[0].H > Math.min(w, hh) * 0.12) {
        const now = performance.now(), f = { src: im, w, h: hh, oy: 0, at: now, n: 1 };
        h.frame = f; h.buf = [f]; h.keys = []; h.cur = { ...all[0], at: now, v: { x: 0, y: 0 } }; h.mask = null;
        h._segment();
        if (h.mask) { h._norm(ox, f, h.cur); ox.globalCompositeOperation = 'destination-in'; ox.drawImage(h.mask, 0, 0); ox.globalCompositeOperation = 'source-over'; face = true; }
        h.frame = null; h.buf = []; h.cur = null;
      }
    } catch { face = false; ox.setTransform(1, 0, 0, 1, 0, 0); ox.globalCompositeOperation = 'source-over'; ox.clearRect(0, 0, S, S); }
    if (!face) { // the whole picture as a round badge
      const r = HEAD.fh * 0.78, cx = HEAD.ax, cy = HEAD.ay - HEAD.fh * 0.08, sc = Math.max(2 * r / w, 2 * r / hh);
      ox.save(); ox.beginPath(); ox.arc(cx, cy, r, 0, Math.PI * 2); ox.clip(); ox.drawImage(im, cx - w * sc / 2, cy - hh * sc / 2, w * sc, hh * sc); ox.restore();
    }
    // the same white cut-out edge and soft shadow the live head gets
    const rim = canvas(S, S), rx = rim.getContext('2d'), st = canvas(S, S), sx = st.getContext('2d');
    rx.filter = 'blur(3.5px)'; rx.drawImage(out, 0, 0); rx.filter = 'none'; for (let i = 0; i < 7; i++) rx.drawImage(rim, 0, 0);
    rx.globalCompositeOperation = 'source-in'; rx.fillStyle = '#fff'; rx.fillRect(0, 0, S, S);
    sx.save(); sx.shadowColor = 'rgba(0,0,0,0.5)'; sx.shadowBlur = 9; sx.shadowOffsetY = 4; sx.drawImage(rim, 0, 0); sx.restore(); sx.drawImage(out, 0, 0);
    return { canvas: out, sticker: () => st, ax: HEAD.ax, ay: HEAD.ay, fh: HEAD.fh, face };
  }
}
