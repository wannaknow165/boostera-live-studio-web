// WANNA Live FX — real-time AR transformation engine.
// Tracks the streamer's face (478 points incl. irises) and body mask with MediaPipe, keeps a clean background plate,
// and plays a JSON timeline: hat on the head, glowing eyes, texture on the body, vanish, transparent clip, return.
import { FilesetResolver, FaceLandmarker, ImageSegmenter, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { newHeadTomato, drawHeadTomato } from './head-tomato.js';
// The battle clips on the target's head live in two more modules (opponent.js, battle-stage.js). A host that serves only
// the engine itself (the mobile gateway) runs without them: no opponent watcher, and battle clips are simply not played.
let Opponent = null, BattleStage = null;
try { ({ Opponent } = await import('./opponent.js')); ({ BattleStage } = await import('./battle-stage.js')); } catch { Opponent = BattleStage = null; }
const noBattle = () => ({ busy: false, clips: {}, live: [], opp: null, load() { return Promise.resolve(this); }, has: () => false, play: () => null, stop() {}, end() {}, target: () => null, draw() {} });

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const SEG_MODEL ='https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = t => 1 - Math.pow(1 - clamp(t), 3);
const bounce = t => { t = clamp(t); const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375; return n * (t -= 2.625 / d) * t + .984375; };
// Points used to map the effect layer onto the streamer piece by piece (face outline, brows, eyes, irises,
// nose, mouth) and the upper-body joints (shoulders, elbows, hips).
const MESH_FACE = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  70, 105, 107, 336, 334, 300, 33, 133, 159, 145, 263, 362, 386, 374, 468, 473, 168, 6, 1, 98, 327, 61, 291, 0, 13, 14, 17];
const MESH_POSE = [11, 12, 13, 14, 23, 24];

// Bowyer–Watson Delaunay triangulation of [{x,y}] -> array of [i,j,k]
function delaunay(P) {
  const n = P.length; if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of P) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const d = Math.max(maxX - minX, maxY - minY) * 20, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const pts = [...P, { x: mx - d, y: my - d }, { x: mx, y: my + d }, { x: mx + d, y: my - d }];
  const circ = (a, b, c) => { const A = pts[a], B = pts[b], C = pts[c], D = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y)); if (Math.abs(D) < 1e-9) return { x: 0, y: 0, r: Infinity };
    const ux = ((A.x * A.x + A.y * A.y) * (B.y - C.y) + (B.x * B.x + B.y * B.y) * (C.y - A.y) + (C.x * C.x + C.y * C.y) * (A.y - B.y)) / D, uy = ((A.x * A.x + A.y * A.y) * (C.x - B.x) + (B.x * B.x + B.y * B.y) * (A.x - C.x) + (C.x * C.x + C.y * C.y) * (B.x - A.x)) / D;
    return { x: ux, y: uy, r: (A.x - ux) ** 2 + (A.y - uy) ** 2 }; };
  let tris = [{ v: [n, n + 1, n + 2], c: circ(n, n + 1, n + 2) }];
  for (let i = 0; i < n; i++) {
    const p = pts[i], bad = tris.filter(t => (p.x - t.c.x) ** 2 + (p.y - t.c.y) ** 2 < t.c.r), edges = [];
    for (const t of bad) for (const [a, b] of [[t.v[0], t.v[1]], [t.v[1], t.v[2]], [t.v[2], t.v[0]]]) { const k = edges.findIndex(e => e[0] === b && e[1] === a); if (k >= 0) edges.splice(k, 1); else edges.push([a, b]); }
    tris = tris.filter(t => !bad.includes(t)); for (const [a, b] of edges) tris.push({ v: [a, b, i], c: circ(a, b, i) });
  }
  return tris.filter(t => t.v.every(k => k < n)).map(t => t.v);
}

const PERSIST = ['hat', 'attach', 'eyesGlow', 'bodyTexture', 'bodyTint', 'faceMorph']; // stay on the person until vanish/return
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

export class FxEngine {
  constructor(video, out, { log = console.log } = {}) {
    this.video = video; this.out = out; this.ctx = out.getContext('2d'); this.log = log;
    this.effects = {}; this.active = null; this.face = null; this.bbox = null; this.ready = false;
    // transparent program (?stage=<url>): only the person (cut out by the body mask) is drawn, nothing opaque under her —
    // the page behind the canvas (the stage iframe) is the background. Remixes, the effect's room and the foreground still paint over it.
    this.transparent = false;
    // battle clips on the target's head (snipe, tomato, diaper, gloves…): battle-stage.js. Its hits shake our picture.
    this.battle = BattleStage ? new BattleStage({ log, onHit: h => this.battleHit(h) }) : noBattle(); this.battle.load();
  }

  async init() {
    // MediaPipe 0.10.14 wasm calls a missing emscripten dbg() when the GPU path logs; define it so it can't crash
    // (never give a page element id="dbg": it becomes window.dbg and breaks this)
    if (typeof globalThis.dbg !== 'function') globalThis.dbg = (...a) => console.debug('[mediapipe]', ...a);
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const make = async delegate => {
      const timeout = new Promise((_, j) => setTimeout(() => j(new Error('timeout')), 20000));
      return Promise.race([timeout, (async () => ({
        // 1 head normally; setMaxHeads(4) while a target head in our picture is being chosen / kept
        face: await FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO', numFaces: 1 }),
        seg: await ImageSegmenter.createFromOptions(fileset, { baseOptions: { modelAssetPath: SEG_MODEL, delegate }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false }),
        pose: await PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: POSE_MODEL, delegate }, runningMode: 'VIDEO', numPoses: 1 }),
      }))()]);
    };
    let m, delegate = new URLSearchParams(location.search).get('cpu') ? 'CPU' : 'GPU';
    try { m = await make(delegate); } catch (e) { this.log(`GPU נכשל (${e.message}) – עובר למעבד`); delegate = 'CPU'; m = await make('CPU'); }
    this.faceLm = m.face; this.seg = m.seg; this.poseLm = m.pose; this.maxHeads = 1;
    this.ready = true; this.log(`MediaPipe ready (face + pose + body mask, ${delegate})`);
  }

  async loadEffect(base) {
    const fx = await (await fetch(`${base}/effect.json`)).json();
    fx.base = base; fx.img = {}; fx.clip = {};
    for (const a of fx.assets) {
      if (a.type === 'image') { const im = new Image(); im.src = `${base}/${a.file}`; await im.decode().catch(() => this.log('missing asset ' + a.file)); fx.img[a.id] = im; }
      if (a.type === 'layer') {
        // green-screen effect layer aligned to the reference video + the creator's face track in that video
        const v = document.createElement('video'); v.src = `${base}/${a.file}`; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.load();
        await new Promise(r => { v.oncanplaythrough = r; setTimeout(r, 8000); }); try { await v.play(); v.pause(); v.currentTime = 0; } catch {}
        let tr; const r = await fetch(`${base}/${a.track}`);
        if (r.ok) tr = await r.json();
        else { this.log(`בונה מעקב לאפקט ${fx.id}… (פעם אחת)`); tr = await this.buildTrack(base, a); await fetch(`/save?path=${encodeURIComponent(base + '/' + a.track)}`, { method: 'POST', body: JSON.stringify(tr) }); this.log(`מעקב נשמר: ${tr.frames.filter(f => !f.none).length}/${tr.frames.length} פריימים`); }
        fx.clip[a.id] = v; fx.track = fx.track || {}; fx.track[a.id] = FxEngine.fillTrack(tr, a.afterTrack || 'screen');
      }
      if (a.type === 'clip') { const v = document.createElement('video'); v.src = `${base}/${a.file}`; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.load();
        // warm up the decoder so the clip starts instantly when triggered
        await new Promise(r => { v.oncanplaythrough = r; setTimeout(r, 8000); }); try { await v.play(); v.pause(); v.currentTime = 0; } catch {}
        fx.clip[a.id] = v; }
    }
    this.effects[fx.id] = fx; this.log(`effect loaded: ${fx.id}`);
    return fx;
  }

  // Which body parts are visible right now (fresh within 400 ms).
  visible() {
    const now = performance.now(), fresh = o => o && now - o.seen < 400, P = fresh(this.pose) ? this.pose : {};
    return { sit: this.posture === 'sit', stand: this.posture === 'stand', face: fresh(this.face), eyes: fresh(this.face), frontal: fresh(this.face) && this.face.frontal, shoulders: !!P.shoulders, hands: !!(P.handL || P.handR), handL: !!P.handL, handR: !!P.handR, waist: !!(P.hipL && P.hipR), body: !!this.bbox };
  }
  static NAMES = { sit: 'ישיבה', stand: 'עמידה', frontal: 'מבט ישר למצלמה', face: 'פנים', eyes: 'עיניים', shoulders: 'כתפיים', hands: 'ידיים', handL: 'יד שמאל', handR: 'יד ימין', waist: 'מותניים', body: 'גוף' };
  // Effect.requires = ["face","shoulders",...]; returns { ok, missing, message }
  check(id) {
    const fx = this.effects[id]; const v = this.visible();
    // effect.posture ("sit" | "stand") is checked first: it decides which group of effects can run right now
    const reqs = [...(fx?.posture ? [fx.posture] : []), ...(fx?.requires || ['face', 'body'])];
    const missing = reqs.filter(r => !v[r]);
    let message = 'מוכן';
    if (missing.includes('sit')) message = 'האפקט הזה לישיבה: שבי כדי להפעיל.';
    else if (missing.includes('stand')) message = 'האפקט הזה לעמידה: קומי והתרחקי כך שיראו את כל הגוף.';
    else if (missing.length) message = `אי אפשר להפעיל עכשיו: לא רואים ${missing.map(m => FxEngine.NAMES[m] || m).join(', ')}. ${missing.some(m => ['waist', 'hands', 'shoulders'].includes(m)) ? 'התרחקי מהמצלמה כך שיראו חצי גוף.' : 'הסתכלי ישר למצלמה.'}`;
    return { ok: !missing.length, missing, message };
  }

  // Where the head is in each frame of an effect layer:
  //  "reference"  – the creator's face in the original video (the layer is aligned 1:1 with it)
  //  "layer-eyes" – the two glowing eyes inside the green layer itself
  async buildTrack(base, a) {
    const fps = 24, src = a.trackFrom === 'reference' ? `${base}/reference.mp4` : `${base}/green/green-src.mp4`;
    const v = document.createElement('video'); v.muted = true; v.src = src; await new Promise(r => v.onloadeddata = r);
    const n = Math.round(v.duration * fps), frames = [];
    if (a.trackFrom === 'reference') {
      if (!this.faceImg) { const fs = await FilesetResolver.forVisionTasks(WASM); this.faceImg = await FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' }, runningMode: 'IMAGE', numFaces: 1 }); }
      if (!this.poseImg) { const fs = await FilesetResolver.forVisionTasks(WASM); this.poseImg = await PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' }, runningMode: 'IMAGE', numPoses: 1 }); }
      const W = v.videoWidth, H = v.videoHeight, c = canvas(W, H), cx = c.getContext('2d');
      for (let i = 0; i < n; i++) {
        v.currentTime = (i + 0.5) / fps; await new Promise(r => v.onseeked = r); cx.drawImage(v, 0, 0, W, H);
        const lm = this.faceImg.detect(c).faceLandmarks?.[0];
        const pl = this.poseImg.detect(c).landmarks?.[0];
        // part points for the piece-by-piece warp: face subset + upper-body joints (normalised 0..1)
        const pts = {};
        if (lm) for (const k of MESH_FACE) pts['f' + k] = [lm[k].x, lm[k].y];
        if (pl) for (const k of MESH_POSE) if ((pl[k].visibility ?? 1) > 0.5 && pl[k].x >= 0 && pl[k].x <= 1 && pl[k].y >= 0 && pl[k].y <= 1) pts['p' + k] = [pl[k].x, pl[k].y];
        if (!lm) { frames.push({ i, none: true, pts: Object.keys(pts).length ? pts : undefined }); continue; }
        const P = k => [lm[k].x, lm[k].y], L = P(234), R = P(454), eL = P(33), eR = P(263);
        frames.push({ i, pts, top: P(10), chin: P(152), eyes: [(lm[468].x + lm[473].x) / 2, (lm[468].y + lm[473].y) / 2], faceW: Math.hypot((R[0] - L[0]) * W, (R[1] - L[1]) * H) / W, roll: Math.atan2((eR[1] - eL[1]) * H, (eR[0] - eL[0]) * W) });
      }
    } else {
      const W = 180, H = Math.round(180 * v.videoHeight / v.videoWidth), c = canvas(W, H), cx = c.getContext('2d', { willReadFrequently: true });
      for (let i = 0; i < n; i++) {
        v.currentTime = (i + 0.5) / fps; await new Promise(r => v.onseeked = r); cx.drawImage(v, 0, 0, W, H);
        const d = cx.getImageData(0, 0, W, H).data, pts = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = (y * W + x) * 4, r = d[p], g = d[p + 1], b = d[p + 2]; if (b > 200 && b > g + 25 && r < 210 && g < 210 && r + g + b > 380) pts.push([x, y]); }
        let hit = null;
        if (pts.length >= 6 && pts.length < W * H * 0.04) {
          const xs = pts.map(p => p[0]).sort((p, q) => p - q), mx = xs[xs.length >> 1], A = pts.filter(p => p[0] < mx), B = pts.filter(p => p[0] >= mx);
          const cen = P => [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
          if (A.length >= 3 && B.length >= 3) { const e1 = cen(A), e2 = cen(B), dist = Math.hypot(e2[0] - e1[0], e2[1] - e1[1]);
            if (dist > W * 0.06 && dist < W * 0.45 && Math.abs(e2[1] - e1[1]) < dist * 0.5) hit = { i, eyes: [(e1[0] + e2[0]) / 2 / W, (e1[1] + e2[1]) / 2 / H], faceW: dist / 0.45 / W, roll: Math.atan2(e2[1] - e1[1], e2[0] - e1[0]) }; }
        }
        frames.push(hit || { i, none: true });
      }
      // drop short runs (< 0.5 s): those are a flying creature's eyes, not the costume on her face
      for (let i = 0; i < n;) { if (frames[i].none) { i++; continue; } let j = i; while (j < n && !frames[j].none) j++; if (j - i < 12) for (let k = i; k < j; k++) frames[k] = { i: k, none: true }; i = j; }
    }
    // mark full-frame scenes (almost no green left in the layer): those always play full screen
    try {
      const g = document.createElement('video'); g.muted = true; g.src = `${base}/green/green-src.mp4`; await new Promise((r, j) => { g.onloadeddata = r; g.onerror = j; });
      const gw = 48, gh = Math.round(48 * g.videoHeight / g.videoWidth), gc = canvas(gw, gh), gx = gc.getContext('2d', { willReadFrequently: true });
      for (let i = 0; i < frames.length; i++) {
        g.currentTime = Math.min(g.duration - 0.05, (i + 0.5) / fps); await new Promise(r => g.onseeked = r); gx.drawImage(g, 0, 0, gw, gh);
        const d = gx.getImageData(0, 0, gw, gh).data; let green = 0; for (let p = 0; p < d.length; p += 4) if (d[p + 1] > 120 && d[p + 1] > d[p] * 1.4 && d[p + 1] > d[p + 2] * 1.4) green++;
        frames[i].full = green / (gw * gh) < 0.08;
      }
    } catch { /* no green source: leave unmarked */ }
    return { fps, width: v.videoWidth, height: v.videoHeight, source: a.trackFrom || 'layer-eyes', frames };
  }

  // Interpolate gaps between tracked frames; after the last tracked frame mark frames as "screen" (layer goes full-frame).
  // mode "hold": when the creator's face is hidden (helmet, mask) keep the last placement on the streamer's head,
  //              and go full screen only on full-frame scenes. mode "screen" (default): full screen once the face is gone.
  static fillTrack(tr, mode = 'screen') {
    const f = tr.frames, ok = f.map((x, i) => x.none ? -1 : i).filter(i => i >= 0), last = ok[ok.length - 1];
    const lerp = (a, b, t) => a + (b - a) * t, lp = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
    // robust placement to hold on: median of the last ~0.6 s of tracked frames (the frames right before a mask
    // covers the face are often half-detected and give a wrong size)
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const holdCache = {};
    const hold = p => holdCache[p] ||= (() => {
      const w = ok.filter(k => k <= p && k > p - 15).map(k => f[k]);
      // face part-points frozen from the last good frame (pose points are taken live from the current reference frame)
      const facePts = Object.fromEntries(Object.entries(f[p].pts || {}).filter(([k]) => k[0] === 'f'));
      return { eyes: [med(w.map(x => x.eyes[0])), med(w.map(x => x.eyes[1]))], faceW: med(w.map(x => x.faceW)), roll: med(w.map(x => x.roll)), top: f[p].top, chin: f[p].chin, facePts };
    })();
    const withPose = (o, x) => ({ ...o, pts: { ...(o.facePts || {}), ...Object.fromEntries(Object.entries(x.pts || {}).filter(([k]) => k[0] === 'p')) } });
    const out = f.map((x, i) => {
      if (!x.none) return x;
      if (x.full) return { i, screen: true };
      const p = ok.filter(k => k < i).pop(), n = ok.find(k => k > i);
      if (i > last) return mode === 'hold' && p !== undefined ? withPose({ ...hold(p), i, held: true }, x) : { i, screen: true };
      if (p === undefined) return { ...f[n], i };
      // a long gap (> 1.5 s) between face runs = the creature is off flying: full screen, then back on her face
      if (n - p > 36) return mode === 'hold' ? withPose({ ...hold(p), i, held: true }, x) : { i, screen: true };
      const t = (i - p) / (n - p), A = f[p], B = f[n];
      const ipts = {}; for (const k in (A.pts || {})) if (k[0] === 'f' && B.pts?.[k]) ipts[k] = lp(A.pts[k], B.pts[k], t);
      for (const k in (x.pts || {})) if (k[0] === 'p') ipts[k] = x.pts[k];
      return { i, pts: ipts, eyes: lp(A.eyes, B.eyes, t), top: lp(A.top, B.top, t), chin: lp(A.chin, B.chin, t), faceW: lerp(A.faceW, B.faceW, t), roll: lerp(A.roll, B.roll, t) };
    });
    // de-jitter the placed frames: median over ±2 frames (detector noise in the reference becomes wobble on the streamer)
    const sm = out.map((x, i) => {
      if (x.screen || !x.eyes) return x;
      const w = out.slice(Math.max(0, i - 2), i + 3).filter(y => !y.screen && y.eyes);
      return { ...x, eyes: [med(w.map(y => y.eyes[0])), med(w.map(y => y.eyes[1]))], faceW: med(w.map(y => y.faceW)), roll: med(w.map(y => y.roll)) };
    });
    return { ...tr, frames: sm, lastTracked: last };
  }

  // Draw the green layer so the creator's head in the layer lands on the streamer's head.
  drawLayer(ctx, s, k, fx, st) {
    const v = fx.clip[s.asset], tr = fx.track?.[s.asset]; if (!v || !tr) return;
    if (!st.started.has(s)) { st.started.add(s); if (s.from) v.currentTime = s.from; v.play().catch(e => this.log('layer play failed ' + e.message)); }
    if (!v.videoWidth) return;
    const W = this.W, H = this.H, i = Math.min(tr.frames.length - 1, Math.floor(v.currentTime * tr.fps)), src = tr.frames[i];
    const Lw = W, Lh = W * v.videoHeight / v.videoWidth;
    // target placement as an affine matrix [a b c d e f]: layer pixel -> screen
    let m, mode;
    if (src.screen) { // full-frame scene: cover the screen
      const s2 = Math.max(W / Lw, H / Lh); m = [s2, 0, 0, s2, (W - Lw * s2) / 2, (H - Lh * s2) / 2]; mode = 'screen';
    } else {
      // fresh face -> follow it; face lost for a moment -> freeze on the last good position instead of jumping
      const fresh = this.face && performance.now() - this.face.seen < 250;
      const f = fresh ? this.face : (st.lastFace || this.face); if (!f) return; if (fresh) st.lastFace = f;
      const dx = (f.irisL.x + f.irisR.x) / 2, dy = (f.irisL.y + f.irisR.y) / 2;
      const sc = (s.scale || 1) * f.faceW / (src.faceW * Lw), r = f.roll - src.roll, sx = src.eyes[0] * Lw, sy = src.eyes[1] * Lh;
      const a = sc * Math.cos(r), b = sc * Math.sin(r), c = -b, d = a;
      m = [a, b, c, d, dx - (a * sx + c * sy), dy - (b * sx + d * sy)]; mode = src.held ? 'held' : 'face';
    }
    // smooth hand-over between modes (face -> held -> full screen): glide the matrix over 0.4 s instead of jumping
    const now = performance.now();
    if (st.layerMode && st.layerMode !== mode && st.lastM) { st.blendFrom = st.lastM; st.blendT0 = now; }
    st.layerMode = mode;
    if (st.blendFrom) { const p = ease((now - st.blendT0) / 400); if (p >= 1) st.blendFrom = null; else m = m.map((x, j) => st.blendFrom[j] + (x - st.blendFrom[j]) * p); }
    st.lastM = m;
    // piece-by-piece: inside the mesh of matched part-points the layer is warped triangle by triangle from the
    // creator's parts onto the streamer's parts; outside it the layer keeps the global placement.
    const mesh = (mode !== 'screen' && !st.blendFrom && s.warp !== false) ? this.buildWarp(src, Lw, Lh) : null;
    if (!mesh) { ctx.save(); ctx.transform(...m); ctx.drawImage(v, 0, 0, Lw, Lh); ctx.restore(); this.lastMesh = null; return; }
    const hull = mesh.hull;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); hull.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.clip('evenodd');
    ctx.transform(...m); ctx.drawImage(v, 0, 0, Lw, Lh); ctx.restore();
    for (const [i0, i1, i2] of mesh.tris) {
      const s0 = mesh.src[i0], s1 = mesh.src[i1], s2 = mesh.src[i2], d0 = mesh.dst[i0], d1 = mesh.dst[i1], d2 = mesh.dst[i2];
      const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y); if (Math.abs(den) < 1e-6) continue;
      // affine that maps the source triangle (layer px) onto the destination triangle (screen px)
      const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den, c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
      const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den, d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
      const e = d0.x - a * s0.x - c * s0.y, f = d0.y - b * s0.x - d * s0.y;
      const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3, g = q => ({ x: q.x + (q.x - cx) * 0.03 + Math.sign(q.x - cx) * 0.6, y: q.y + (q.y - cy) * 0.03 + Math.sign(q.y - cy) * 0.6 });
      const q0 = g(d0), q1 = g(d1), q2 = g(d2);
      ctx.save(); ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.closePath(); ctx.clip();
      ctx.setTransform(a, b, c, d, e, f); ctx.drawImage(v, 0, 0, Lw, Lh); ctx.restore();
    }
    this.lastMesh = mesh;
  }

  // Matched part-points between the creator (this layer frame) and the streamer (now) -> triangles.
  buildWarp(src, Lw, Lh) {
    if (!src.pts || !this.facePts) return null;
    const now = performance.now(); if (!this.face || now - this.face.seen > 250) return null;
    const W = this.W, H = this.H, live = {};
    for (const k of MESH_FACE) live['f' + k] = [this.facePts[k].x * W, this.facePts[k].y * H];
    if (this.posePts) for (const k of MESH_POSE) { const p = this.posePts[k]; if ((p.visibility ?? 1) > 0.5 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) live['p' + k] = [p.x * W, p.y * H]; }
    // temporal smoothing per point (the raw landmarks shimmer a little)
    const S = this.ptsSmooth ||= {};
    for (const k in live) { const o = S[k]; S[k] = o && now - o.t < 300 ? { x: o.x + (live[k][0] - o.x) * 0.55, y: o.y + (live[k][1] - o.y) * 0.55, t: now } : { x: live[k][0], y: live[k][1], t: now }; }
    const keys = Object.keys(src.pts).filter(k => live[k]);
    if (keys.filter(k => k[0] === 'f').length < 20) return null;
    const srcP = keys.map(k => ({ x: src.pts[k][0] * Lw, y: src.pts[k][1] * Lh })), dst = keys.map(k => ({ x: S[k].x, y: S[k].y }));
    const tris = delaunay(dst).filter(([a, b, c]) => {
      // drop slivers and triangles that flip between creator and streamer (bad matches)
      const ar = (P, i, j, k) => (P[j].x - P[i].x) * (P[k].y - P[i].y) - (P[k].x - P[i].x) * (P[j].y - P[i].y);
      const as = ar(srcP, a, b, c), ad = ar(dst, a, b, c); return Math.sign(as) === Math.sign(ad) && Math.abs(ad) > 4;
    });
    // convex hull of the destination points (where the warp replaces the global placement)
    const idx = [...dst.keys()].sort((i, j) => dst[i].x - dst[j].x || dst[i].y - dst[j].y), cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x), lo = [], up = [];
    for (const i of idx) { while (lo.length > 1 && cr(dst[lo.at(-2)], dst[lo.at(-1)], dst[i]) <= 0) lo.pop(); lo.push(i); }
    for (const i of [...idx].reverse()) { while (up.length > 1 && cr(dst[up.at(-2)], dst[up.at(-1)], dst[i]) <= 0) up.pop(); up.push(i); }
    const hullIdx = [...lo.slice(0, -1), ...up.slice(0, -1)];
    return { keys, src: srcP, dst, tris, hull: hullIdx.map(i => dst[i]) };
  }

  // ---------- REMIX: an AI video of this streamer herself transforming, generated from her own frame ----------
  remixVideo(url) {
    this.remixCache ||= {};
    if (!this.remixCache[url]) { const v = document.createElement('video'); v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.load(); this.remixCache[url] = v; }
    return this.remixCache[url];
  }
  // grab the current camera frame (what the remix will start from) as a jpeg blob
  async grabFrame() { const c = canvas(this.W, this.H); c.getContext('2d').drawImage(this.video, 0, 0, this.W, this.H); return new Promise(r => c.toBlob(r, 'image/jpeg', 0.92)); }
  async triggerRemix(id, url, { force = false } = {}) {
    const fx = this.effects[id]; const c = this.check(id);
    if (!c.ok && !force) { this.onReject?.(c); return c; }
    const v = this.remixVideo(url); if (v.readyState < 3) await new Promise(r => { v.oncanplaythrough = r; setTimeout(r, 4000); });
    v.currentTime = 0; await v.play().catch(() => {});
    this.active = { fx, remix: v, t0: performance.now() }; this.log('REMIX ' + id); return c;
  }
  drawRemix() {
    const ctx = this.ctx, W = this.W, H = this.H, st = this.active, v = st.remix;
    const t = (performance.now() - st.t0) / 1000, dur = v.duration || 10, fadeIn = 0.3, fadeOut = 0.7;
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    // transparent program: her cut-out instead of the camera, so the remix covers the stage page as it fades in and uncovers it as it fades out
    if (this.transparent) { ctx.clearRect(0, 0, W, H); this.personLayer(ctx, 1); } else ctx.drawImage(this.video, 0, 0, W, H);
    if (v.videoWidth) {
      const a = Math.min(clamp(t / fadeIn), clamp((dur - t) / fadeOut));
      const sc = Math.max(W / v.videoWidth, H / v.videoHeight), w = v.videoWidth * sc, h = v.videoHeight * sc;
      ctx.globalAlpha = a; ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h); ctx.globalAlpha = 1;
      // return: a flash in the effect's colour while the live comes back
      const r = clamp((t - (dur - fadeOut)) / fadeOut); if (r > 0 && r < 1) this.drawGlowBurst(ctx, { x: W / 2, y: H * 0.45 }, Math.max(W, H) * 0.7, st.fx?.returnColor || '#ffd27a', Math.sin(Math.PI * r) * 0.8);
    }
    if (v.ended || t > dur + 0.2) { this.active = null; this.log('REMIX done'); }
    if (this.debug) this.drawDebug(ctx);
  }

  trigger(id, { force = false } = {}) {
    const fx = this.effects[id]; if (!fx) return this.log('unknown effect ' + id);
    const c = this.check(id);
    // only the gaze is missing: arm and start automatically the moment she looks at the camera (up to 5 s)
    if (!c.ok && !force && c.missing.length === 1 && c.missing[0] === 'frontal') {
      if (this.armed) return c;
      this.armed = id; const t0 = performance.now(); this.onReject?.({ ...c, message: 'הסתכלי ישר למצלמה…' });
      const wait = () => { if (this.armed !== id) return; if (this.check(id).ok) { this.armed = null; this.trigger(id); } else if (performance.now() - t0 > 5000) { this.armed = null; this.onReject?.(this.check(id)); } else requestAnimationFrame(wait); };
      wait(); return c;
    }
    if (!c.ok && !force) { this.log(c.message); this.onReject?.(c); return c; }
    this.active = { fx, t0: performance.now(), frozen: {}, started: new Set() };
    for (const v of Object.values(fx.clip)) { v.pause(); if (v.currentTime) v.currentTime = 0; }
    this.active.lastFace = null;
    this.log('TRIGGER ' + id); return c;
  }

  setup() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (this.W === w && this.H === h) return;
    this.W = this.out.width = w; this.H = this.out.height = h;
    this.mask = canvas(w, h); this.maskCtx = this.mask.getContext('2d');
    this.segIn = canvas(Math.round(w / 2), Math.round(h / 2)); this.segCtx = this.segIn.getContext('2d'); this.maskSmall = null; // half-size picture for the body-mask model
    this.plate = canvas(w, h); this.plateCtx = this.plate.getContext('2d');
    this.tmp = canvas(w, h); this.tmpCtx = this.tmp.getContext('2d');
    this.tmp2 = canvas(w, h); this.tmp2Ctx = this.tmp2.getContext('2d');
    // plate starts empty: only pixels actually seen without the person are stored; holes are filled at vanish time
    this.filled = canvas(w, h); this.filledCtx = this.filled.getContext('2d');
  }

  // Best quality: the streamer steps out of frame for a second and the empty room is stored as the plate.
  capturePlate() { if (!this.W) return; this.plateCtx.globalCompositeOperation = 'copy'; this.plateCtx.drawImage(this.video, 0, 0, this.W, this.H); this.plateCtx.globalCompositeOperation = 'source-over'; this.plateLocked = true; this.log('רקע ריק נשמר'); }

  // Empty-room plate from a file (image or a frame of a video of the room without the streamer).
  async plateFromUrl(url) {
    if (!this.W) return this.log('אין מקור וידאו עדיין');
    let src;
    if (/\.(png|jpe?g|webp)$/i.test(url) || url.startsWith('blob:') && !this._plateIsVideo) { src = new Image(); src.src = url; try { await src.decode(); } catch { src = null; } }
    if (!src) { src = document.createElement('video'); src.muted = true; src.src = url; await new Promise(r => src.onloadeddata = r); src.currentTime = Math.min(1, src.duration / 2); await new Promise(r => src.onseeked = r); }
    this.plateCtx.globalCompositeOperation = 'copy'; this.plateCtx.drawImage(src, 0, 0, this.W, this.H); this.plateCtx.globalCompositeOperation = 'source-over';
    this.plateLocked = true; this.log('רקע ריק נטען מקובץ');
  }

  // Fill the never-seen area behind the person (push-pull: multi-scale blur of the known pixels, drawn underneath).
  fillPlate() {
    // Diffusion inpaint at 1/8 resolution: only fully-known plate pixels are trusted; unknown pixels take the
    // average of their known neighbours, growing inward from the edges until the hole is closed (walls stay walls).
    const W = this.W, H = this.H, f = this.filledCtx;
    const sw = Math.max(8, Math.round(W / 8)), sh = Math.max(8, Math.round(H / 8));
    const s = canvas(sw, sh), sc = s.getContext('2d', { willReadFrequently: true });
    sc.drawImage(this.plate, 0, 0, sw, sh);
    const img = sc.getImageData(0, 0, sw, sh), d = img.data, n = sw * sh;
    let known = new Uint8Array(n); let r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
    // also distrust a wide band around the person's current silhouette (long hair / motion leaks there)
    const ms = canvas(sw, sh), mc = ms.getContext('2d', { willReadFrequently: true }); mc.drawImage(this.mask, 0, 0, sw, sh);
    const md = mc.getImageData(0, 0, sw, sh).data, band = this.plateLocked ? 0 : Math.round(sw / 10), near = new Uint8Array(n);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (md[(y * sw + x) * 4 + 3] > 20)
      for (let yy = Math.max(0, y - band); yy <= Math.min(sh - 1, y + band); yy++) for (let xx = Math.max(0, x - band); xx <= Math.min(sw - 1, x + band); xx++) near[yy * sw + xx] = 1;
    for (let i = 0; i < n; i++) if (d[i * 4 + 3] > 240 && !near[i]) { known[i] = 1; r[i] = d[i * 4]; g[i] = d[i * 4 + 1]; b[i] = d[i * 4 + 2]; }
    for (let pass = 0, left = 1; left && pass < 400; pass++) {
      left = 0; const nk = known.slice();
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const i = y * sw + x; if (known[i]) continue;
        let c = 0, R = 0, G = 0, B = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
          const j = yy * sw + xx; if (known[j]) { c++; R += r[j]; G += g[j]; B += b[j]; }
        }
        if (c >= 2 || (c && pass > 50)) { nk[i] = 1; r[i] = R / c; g[i] = G / c; b[i] = B / c; } else left++;
      }
      known = nk;
    }
    for (let i = 0; i < n; i++) { d[i * 4] = r[i]; d[i * 4 + 1] = g[i]; d[i * 4 + 2] = b[i]; d[i * 4 + 3] = 255; }
    sc.putImageData(img, 0, 0);
    f.globalCompositeOperation = 'copy'; f.imageSmoothingQuality = 'high'; f.filter = 'blur(6px)'; f.drawImage(s, 0, 0, W, H); f.filter = 'none';
    if (this.plateLocked) { f.globalCompositeOperation = 'source-over'; f.drawImage(this.plate, 0, 0); } // a real empty-room plate wins
    else { // real pixels only outside the distrusted band, feathered
      const k = canvas(W, H), kc = k.getContext('2d'); kc.drawImage(this.plate, 0, 0);
      const nm = canvas(sw, sh), nc = nm.getContext('2d'), nd = nc.createImageData(sw, sh); for (let i = 0; i < n; i++) nd.data[i * 4 + 3] = near[i] ? 255 : 0; nc.putImageData(nd, 0, 0);
      kc.globalCompositeOperation = 'destination-out'; kc.filter = 'blur(12px)'; kc.drawImage(nm, 0, 0, W, H); kc.filter = 'none';
      f.globalCompositeOperation = 'source-over'; f.drawImage(k, 0, 0);
    }
  }

  // ---------- per-frame tracking ----------
  // Speed budget: all of this must stay well under 33 ms per frame for a 30 fps broadcast, so
  //  • faces    : 1 head normally (fast); up to 4 only while a target head is being chosen / kept (setMaxHeads)
  //  • pose     : every 2nd frame (shoulders and hands move slowly enough)
  //  • body mask: computed on a half-size picture (the model itself works at 256 px, nothing is lost),
  //               every 2nd frame while an effect runs (the frames without pose), every 6th frame when idle
  //  Each model call blocks ~10 ms waiting for its result, so no frame ever runs more than two of them.
  async setMaxHeads(n) {
    if (this.maxHeads === n || !this.faceLm) return; this.maxHeads = n; this.faceBusy = true;
    try { await this.faceLm.setOptions({ numFaces: n }); } catch (e) { this.log('setMaxHeads: ' + e.message); }
    this.faceBusy = false;
  }
  track(ts) {
    const v = this.video, W = this.W, H = this.H, n = this.frameNo = (this.frameNo || 0) + 1;
    // never more than two models in one frame: face always; pose on even frames; body mask on odd frames
    const remix = !!this.active?.remix, busy = !!this.active || this.debug; // a remix is just a video: no pose / mask needed
    const cut = !!this.transparent; // transparent program: the person is cut out on every frame she is drawn, during a remix too
    if (!this.faceBusy) {
      const fr = this.faceLm.detectForVideo(v, ts);
      // every head on screen: center, width, box (for choosing a target)
      const all = (fr.faceLandmarks || []).map(L => {
        let x0 = 1, x1 = 0, y0 = 1, y1 = 0; for (const p of L) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
        return { lm: L, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, top: { x: L[10].x, y: L[10].y } };
      });
      this.heads = all; this.headsSeen = performance.now();
      if (this.target) { // keep the chosen head: follow the nearest head each frame
        let best = null, bd = 1e9; for (const h of all) { const d = Math.hypot(h.cx - this.target.cx, h.cy - this.target.cy); if (d < bd) { bd = d; best = h; } }
        if (best && bd < Math.max(0.12, this.target.w)) { this.target = { cx: best.cx, cy: best.cy, w: best.w, h: best.h, seen: performance.now() }; }
      }
      const lm = all.length ? all.reduce((a, b) => (b.w > a.w ? b : a)).lm : undefined; // primary = the biggest head
      if (lm) {
        const P = i => ({ x: lm[i].x * W, y: lm[i].y * H });
        const L = P(234), R = P(454), eL = P(33), eR = P(263);
        const faceW = Math.hypot(R.x - L.x, R.y - L.y);
        const roll = Math.atan2(eR.y - eL.y, eR.x - eL.x);
        const oval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109].map(P);
        // head angle: nose offset from the cheek midpoint (yaw) and from the eyes-chin line (pitch), in face widths
        const nose = P(1), midC = { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 }, eyeMid = { x: (eL.x + eR.x) / 2, y: (eL.y + eR.y) / 2 }, chin = P(152);
        const yaw = ((nose.x - midC.x) * Math.cos(roll) + (nose.y - midC.y) * Math.sin(roll)) / faceW;
        const pitch = ((nose.y - eyeMid.y) / Math.max(1, chin.y - eyeMid.y)) - 0.42; // ~0 when looking straight
        this.facePts = lm; // all 478 points, for the debug overlay
        // smoothing: blend each anchor with the previous frame so effects don't jitter (fast moves still follow)
        const prev = this.face && performance.now() - this.face.seen < 300 ? this.face : null;
        const sm = (a, b) => { if (!prev) return a; const d = Math.hypot(a.x - b.x, a.y - b.y), k = Math.min(1, 0.35 + d / (faceW * 0.25)); return { x: b.x + (a.x - b.x) * k, y: b.y + (a.y - b.y) * k }; };
        const smv = (a, b) => prev ? b + (a - b) * 0.45 : a;
        const now = performance.now();
        this.face = { top: sm(P(10), prev?.top), chin: sm(chin, prev?.chin), irisL: sm(P(468), prev?.irisL), irisR: sm(P(473), prev?.irisR), faceW: smv(faceW, prev?.faceW), roll: smv(roll, prev?.roll), oval, yaw, pitch, frontalNow: Math.abs(yaw) < 0.09 && Math.abs(pitch) < 0.12 && Math.abs(roll) < 0.35, seen: now };
        // stable lock: the gaze must hold for half a second in a row
        this.frontalSince = this.face.frontalNow ? (this.frontalSince ?? now) : null;
        this.face.frontal = this.frontalSince != null && now - this.frontalSince >= 500;
      }
    }
    // Upper-body skeleton: shoulders 11/12, elbows 13/14, wrists 15/16, hips 23/24 (visibility-gated) — every 2nd frame
    if (n % 2 === 0 && !remix) {
      const pr = this.poseLm.detectForVideo(v, ts); const pl = pr.landmarks?.[0];
      this.posePts = pl || null;
      if (pl) {
        // a joint counts only if it's confident AND actually inside the frame (MediaPipe guesses off-screen knees)
        const Q = i => (pl[i].visibility ?? 1) > 0.4 && pl[i].y >= 0 && pl[i].y <= 1 && pl[i].x >= 0 && pl[i].x <= 1 ? { x: pl[i].x * W, y: pl[i].y * H } : null;
        const sL = Q(11), sR = Q(12);
        this.pose = { shoulderL: sL, shoulderR: sR, elbowL: Q(13), elbowR: Q(14), handL: Q(15), handR: Q(16), hipL: Q(23), hipR: Q(24),
          shoulders: sL && sR ? { x: (sL.x + sR.x) / 2, y: (sL.y + sR.y) / 2 } : null, shoulderW: sL && sR ? Math.hypot(sR.x - sL.x, sR.y - sL.y) : null, seen: performance.now() };
        this.updatePosture(Q);
      }
    }
    // Body mask (person vs background) on a half-size copy of the picture
    this.maskFresh = false;
    if ((!remix || cut) && n % 2 === 1 && (busy || cut || n % 6 === 1)) { // while an effect runs (or the program is transparent): every 2nd frame; idle: every 6th
      this.segCtx.drawImage(v, 0, 0, this.segIn.width, this.segIn.height);
      const sr = this.seg.segmentForVideo(this.segIn, ts), m = sr.confidenceMasks?.[0];
      if (m) {
        const f = m.getAsFloat32Array(), mw = m.width, mh = m.height;
        if (f.length === mw * mh) {
          if (!this.maskSmall || this.maskSmall.width !== mw || this.maskSmall.height !== mh) {
            this.maskSmall = canvas(mw, mh); this.maskSmallCtx = this.maskSmall.getContext('2d', { willReadFrequently: true });
            this.maskData = this.maskSmallCtx.createImageData(mw, mh); this.maskA = new Float32Array(f.length); this.maskB = new Float32Array(f.length); this.maskHas = false;
          }
          const d = this.maskData.data, prev = this.maskA, cur = this.maskB, has = this.maskHas;
          // tighter matte (no halo of the old wall) + temporal smoothing (edges don't flicker)
          for (let i = 0, p = 3; i < f.length; i++, p += 4) { const c = has ? prev[i] * 0.35 + f[i] * 0.65 : f[i]; cur[i] = c; d[p] = c > 0.65 ? 255 : c > 0.45 ? (c - 0.45) * 1275 : 0; }
          this.maskA = cur; this.maskB = prev; this.maskHas = true;
          let minX = mw, minY = mh, maxX = 0, maxY = 0, cnt = 0;
          for (let y = 0; y < mh; y += 4) for (let x = 0; x < mw; x += 4) if (f[y * mw + x] > 0.5) { cnt++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
          this.maskSmallCtx.putImageData(this.maskData, 0, 0);
          // the full-size mask every effect uses = the small one scaled up (smooth edges)
          this.maskCtx.globalCompositeOperation = 'copy'; this.maskCtx.drawImage(this.maskSmall, 0, 0, W, H); this.maskCtx.globalCompositeOperation = 'source-over';
          const kx = W / mw, ky = H / mh;
          this.bbox = cnt > 20 ? { x: minX * kx, y: minY * ky, w: (maxX - minX) * kx, h: (maxY - minY) * ky, cx: (minX + maxX) / 2 * kx, cy: (minY + maxY) / 2 * ky } : null;
          this.maskFresh = true;
        }
        m.close?.();
      }
      sr.close?.();
    }
  }

  // Sitting vs standing from the skeleton, voted over the last ~20 frames so it doesn't flicker.
  //  standing: knees well below the hips (thigh vertical) or ankles in frame
  //  sitting : knees about level with the hips (thigh horizontal), or only the upper body in frame (desk / chair stream)
  updatePosture(Q) {
    const sh = this.pose.shoulders, hL = Q(23), hR = Q(24), kL = Q(25), kR = Q(26), aL = Q(27), aR = Q(28);
    let vote = null;
    if (sh) {
      const hip = hL && hR ? { x: (hL.x + hR.x) / 2, y: (hL.y + hR.y) / 2 } : (hL || hR);
      const knee = kL && kR ? { x: (kL.x + kR.x) / 2, y: (kL.y + kR.y) / 2 } : (kL || kR);
      if (hip && knee) {
        const torso = Math.max(1, hip.y - sh.y), thighDrop = (knee.y - hip.y) / torso;
        vote = thighDrop > 0.55 ? 'stand' : thighDrop < 0.35 ? 'sit' : null;
      }
      if (!vote && (aL || aR)) vote = 'stand';
      if (!vote && !knee) vote = 'sit'; // half body only: a seated/desk framing
    }
    const h = (this.postureVotes ||= []); h.push(vote); if (h.length > 20) h.shift();
    const sit = h.filter(v => v === 'sit').length, stand = h.filter(v => v === 'stand').length;
    if (sit >= 12) this.posture = 'sit'; else if (stand >= 12) this.posture = 'stand';
  }

  // Clean plate: copy camera pixels into the plate wherever there is no person (mask dilated so hair/edges never leak in).
  updatePlate() {
    if (this.active?.vanishing || this.plateLocked) return; // freeze plate while hidden, or when an empty-room plate was captured
    const t = this.tmpCtx, W = this.W, H = this.H;
    t.globalCompositeOperation = 'copy'; t.drawImage(this.video, 0, 0, W, H);
    // dilate the person mask generously so loose hair and soft edges never get stored in the plate
    t.globalCompositeOperation = 'destination-out'; t.filter = `blur(${Math.round(this.W / 18)}px)`;
    for (let i = 0; i < 5; i++) t.drawImage(this.mask, 0, 0);
    t.filter = 'none'; t.globalCompositeOperation = 'source-over';
    this.plateCtx.drawImage(this.tmp, 0, 0);
  }

  // ---------- drawing primitives ----------
  // Average + accent colour of a background image, used to relight the streamer so she sits in that room.
  roomLight(im) {
    if (im._light) return im._light;
    const c = canvas(16, 16), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, 16, 16);
    const d = x.getImageData(0, 0, 16, 16).data; let r = 0, g = 0, b = 0, best = null, bs = -1;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]), s = (mx - mn) * mx; if (s > bs) { bs = s; best = [d[i], d[i + 1], d[i + 2]]; } }
    const n = d.length / 4; return im._light = { avg: `rgb(${r / n | 0},${g / n | 0},${b / n | 0})`, rim: `rgb(${best.join(',')})`, dark: (r + g + b) / n / 3 < 90 };
  }

  personLayer(ctx, alpha, { blur = 0, glow = 0, grade = null } = {}) {
    // camera masked to the person; blur/glow make her dissolve into light instead of a flat fade
    const t = this.tmp2Ctx, W = this.W, H = this.H; t.globalCompositeOperation = 'copy'; t.drawImage(this.video, 0, 0, W, H);
    t.globalCompositeOperation = 'destination-in'; t.filter = `blur(${2 + blur * 0.6}px)`; t.drawImage(this.mask, 0, 0); t.filter = 'none'; t.globalCompositeOperation = 'source-over';
    if (grade) {
      // relight into the new room: tint toward its colour (darker rooms -> darker subject), then a coloured rim light on her edges
      const L = this.roomLight(grade.im), k = grade.a;
      t.globalCompositeOperation = 'source-atop';
      t.globalAlpha = 0.35 * k; t.fillStyle = L.rim; t.globalCompositeOperation = 'color'; t.fillRect(0, 0, W, H);
      if (L.dark) { t.globalCompositeOperation = 'multiply'; t.globalAlpha = 0.55 * k; t.fillStyle = '#5a6488'; t.fillRect(0, 0, W, H); }
      t.globalAlpha = 1;
      const e = this.tmpCtx; e.globalCompositeOperation = 'copy'; e.drawImage(this.mask, 0, 0);
      e.globalCompositeOperation = 'destination-out'; e.filter = `blur(${Math.round(W / 40)}px)`; e.drawImage(this.mask, 0, 0); e.drawImage(this.mask, 0, 0); e.filter = 'none';
      e.globalCompositeOperation = 'source-in'; e.fillStyle = L.rim; e.fillRect(0, 0, W, H); e.globalCompositeOperation = 'source-over';
      t.globalCompositeOperation = 'destination-in'; t.filter = `blur(${2 + blur * 0.6}px)`; t.drawImage(this.mask, 0, 0); t.filter = 'none'; // keep only her pixels after the colour blends
      t.globalCompositeOperation = 'lighter'; t.globalAlpha = 1.0 * k; t.drawImage(this.tmp, 0, 0); t.drawImage(this.tmp, 0, 0); t.globalAlpha = 1; t.globalCompositeOperation = 'source-over';
    }
    // keep a copy of the (relit) person for effects that reuse her pixels (face melt)
    if (!this.personCanvas || this.personCanvas.width !== W) { this.personCanvas = canvas(W, H); this.personCtx = this.personCanvas.getContext('2d'); }
    this.personCtx.globalCompositeOperation = 'copy'; this.personCtx.drawImage(this.tmp2, 0, 0);
    ctx.save(); ctx.globalAlpha = alpha;
    if (blur > 0.5 || glow > 0.01) ctx.filter = `blur(${blur}px) brightness(${1 + glow * 1.2}) saturate(${1 + glow * 0.8})`;
    ctx.drawImage(this.tmp2, 0, 0); ctx.restore();
  }

  drawAttach(ctx, s, k, fx) {
    const f = this.face; if (!f) return; const im = fx.img[s.asset || 'hat']; if (!im?.naturalWidth) return;
    const anchor = s.anchor || 'head';
    let w = (s.scale || (anchor === 'head' ? 2.2 : 1.1)) * f.faceW, h = w * im.naturalHeight / im.naturalWidth;
    const up = { x: Math.sin(f.roll), y: -Math.cos(f.roll) };
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const P = this.pose || {};
    const chest = P.shoulders ? { x: P.shoulders.x, y: P.shoulders.y + (P.shoulderW || f.faceW * 2) * 0.35 } : { x: f.chin.x - up.x * f.faceW * 1.1, y: f.chin.y - up.y * f.faceW * 1.1 };
    const anchors = {
      head: f.top, eyes: mid(f.irisL, f.irisR), face: mid(f.top, f.chin), chin: f.chin, chest,
      shoulders: P.shoulders, shoulderL: P.shoulderL, shoulderR: P.shoulderR, handL: P.handL, handR: P.handR,
      elbowL: P.elbowL, elbowR: P.elbowR, waist: P.hipL && P.hipR ? mid(P.hipL, P.hipR) : null,
    };
    const base = anchors[anchor]; if (!base) return; // body part not visible this frame
    const pivotY = s.pivotY ?? (anchor === 'head' ? 0.86 : 0.5);
    const lift = (s.offsetUp ?? (anchor === 'head' ? 0.1 : 0)) * f.faceW;
    let ax = base.x + up.x * lift, ay = base.y + up.y * lift;
    // keep the item inside the frame: if it would stick out above the top, shrink it (never below 55%)
    const above = h * pivotY, room = ay - 4;
    if (above > room && room > 0) { const k2 = Math.max(0.55, room / above); w *= k2; h *= k2; }
    if (s.enter === 'pop') { const p = ease(k / Math.min(1, s.d)); ctx.save(); ctx.translate(ax, ay); ctx.rotate(f.roll); ctx.globalAlpha = s.alpha ?? 1; ctx.drawImage(im, -w * p / 2, -h * p * pivotY, w * p, h * p); ctx.restore(); return; }
    if (s.enter === 'fade') s = { ...s, alpha: (s.alpha ?? 1) * ease(k / Math.min(1, s.d)) };
    if (s.enter === 'drop') ay -= (1 - bounce(k / Math.min(1, s.d))) * this.H * 0.6;
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(f.roll); ctx.globalAlpha = s.alpha ?? 1;
    ctx.drawImage(im, -w / 2, -h * pivotY, w, h); ctx.restore();
  }

  drawBodyTint(ctx, s, k) {
    const t = this.tmp2Ctx; t.globalCompositeOperation = 'copy'; t.fillStyle = s.color || '#6a00ff'; t.fillRect(0, 0, this.W, this.H);
    t.globalCompositeOperation = 'destination-in'; t.drawImage(this.mask, 0, 0); t.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = (s.opacity ?? 0.5) * ease(k * 2) * (s.alpha ?? 1); ctx.drawImage(this.tmp2, 0, 0); ctx.restore();
  }

  drawEyes(ctx, s, k) {
    const f = this.face; if (!f) return; const r = (s.size || 0.1) * f.faceW * (0.8 + 0.2 * Math.sin(performance.now() / 120));
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = ease(k * 2) * (s.alpha ?? 1);
    for (const c of [f.irisL, f.irisR]) {
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r * 2.4);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.18, s.color || '#7fb2ff'); g.addColorStop(0.45, (s.color || '#7fb2ff') + '66'); g.addColorStop(1, '#00000000');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  drawBodyTexture(ctx, s, k, fx) {
    const im = fx.img[s.texture]; if (!im?.naturalWidth || !this.bbox) return;
    const t = this.tmp2Ctx, W = this.W, H = this.H, b = this.bbox;
    t.globalCompositeOperation = 'copy'; t.fillStyle = t.createPattern(im, 'repeat');
    const sc = Math.max(0.15, (b.w / im.naturalWidth) * 0.55); t.save(); t.scale(sc, sc); t.fillRect(0, 0, W / sc, H / sc); t.restore();
    t.globalCompositeOperation = 'destination-in'; t.drawImage(this.mask, 0, 0);
    if (s.keepFace && this.face) { t.globalCompositeOperation = 'destination-out'; t.beginPath(); this.face.oval.forEach((p, i) => i ? t.lineTo(p.x, p.y) : t.moveTo(p.x, p.y)); t.closePath(); t.filter = 'blur(6px)'; t.fill(); t.filter = 'none'; }
    // reveal from the bottom up
    const p = ease(k / Math.min(1, s.dReveal || 1));
    const edge = b.y + b.h - p * (b.h + 40);
    t.globalCompositeOperation = 'destination-out'; const g = t.createLinearGradient(0, edge - 40, 0, edge + 40); g.addColorStop(0, '#000f'); g.addColorStop(1, '#0000'); t.fillStyle = g; t.fillRect(0, 0, W, edge + 40);
    t.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.globalAlpha = (s.opacity ?? 0.9) * (s.alpha ?? 1); ctx.drawImage(this.tmp2, 0, 0); ctx.restore();
  }

  drawGlowBurst(ctx, at, r, color, alpha) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, r); g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, color); g.addColorStop(1, '#00000000');
    ctx.fillStyle = g; ctx.fillRect(at.x - r, at.y - r, r * 2, r * 2); ctx.restore();
  }

  drawSparkle(ctx, s, k) {
    const f = this.face; if (!f) return; const n = 40, R = f.faceW * 1.3;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const a = i * 2.399 + k * 3, rr = R * (0.4 + ((i * 37) % 60) / 100) * (0.6 + k);
      const x = f.top.x + Math.cos(a) * rr, y = f.top.y - f.faceW * 0.3 + Math.sin(a) * rr * 0.7;
      ctx.globalAlpha = (1 - k) * (0.5 + 0.5 * Math.sin(i + k * 20));
      ctx.fillStyle = s.color || '#b46bff'; ctx.beginPath(); ctx.arc(x, y, 2 + (i % 4), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  drawClip(ctx, s, k, fx, st) {
    const v = fx.clip[s.asset]; if (!v) return;
    if (!st.started.has(s)) { st.started.add(s); v.play().catch(e => this.log('clip play failed ' + e.message)); if (s.freezeAnchor) st.frozen[s.asset] = this.bbox ? { ...this.bbox } : { cx: this.W / 2, cy: this.H * 0.6, h: this.H * 0.6 }; }
    if (!v.videoWidth) return;
    const b = (s.freezeAnchor && st.frozen[s.asset]) || this.bbox || { cx: this.W / 2, cy: this.H * 0.6, h: this.H * 0.6 };
    const h = (s.scale || 1) * b.h, w = h * v.videoWidth / v.videoHeight;
    ctx.drawImage(v, b.cx - w / 2, b.cy - h * 0.55, w, h);
  }

  // Her face turns into the creature's face: the face oval darkens to black-purple, eyes stay for the glow.
  drawFaceMorph(ctx, s, k) {
    const f = this.face; if (!f) return; const pAll = ease(k) * (s.alpha ?? 1);
    const t = this.tmp2Ctx, W = this.W, H = this.H;
    // stage 1: her face melts (growing blur of her own face, clipped to the face oval)
    const melt = ease(Math.min(1, k * 1.6)) * (s.alpha ?? 1);
    if (melt > 0.01) {
      // soft-edged: her own (relit) face, lightly blurred and cooled, faded in through a feathered ellipse
      const src = this.personCanvas || this.video, cx0 = (f.top.x + f.chin.x) / 2, cy0 = (f.top.y + f.chin.y) / 2, R0 = Math.hypot(f.chin.x - f.top.x, f.chin.y - f.top.y) * 0.62;
      const m = this.tmpCtx; m.globalCompositeOperation = 'copy'; m.filter = `blur(${Math.round(f.faceW * 0.035 * melt)}px) saturate(${1 - 0.5 * melt}) brightness(${1 - 0.35 * melt})`; m.drawImage(src, 0, 0, W, H); m.filter = 'none';
      const gr = m.createRadialGradient(cx0, cy0, R0 * 0.35, cx0, cy0, R0); gr.addColorStop(0, '#000f'); gr.addColorStop(1, '#0000');
      m.globalCompositeOperation = 'destination-in'; m.fillStyle = gr; m.fillRect(0, 0, W, H); m.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.globalAlpha = Math.min(1, melt * 1.2); ctx.drawImage(this.tmp, 0, 0); ctx.restore();
    }
    // stage 2: the melted face darkens into the creature's face
    const p = ease(Math.max(0, k * 1.5 - 0.5)) * (s.alpha ?? 1) * (s.opacity ?? 0.95);
    t.globalCompositeOperation = 'copy'; t.clearRect(0, 0, W, H);
    const cx = (f.top.x + f.chin.x) / 2, cy = (f.top.y + f.chin.y) / 2, R = Math.hypot(f.chin.x - f.top.x, f.chin.y - f.top.y) * 0.7;
    const g = t.createRadialGradient(cx, cy, R * 0.1, cx, cy, R); g.addColorStop(0, s.color || '#0b0614'); g.addColorStop(0.6, (s.color || '#0b0614') + 'ee'); g.addColorStop(1, '#2a124800');
    t.globalCompositeOperation = 'source-over'; t.fillStyle = g; t.beginPath(); f.oval.forEach((q, i) => i ? t.lineTo(q.x, q.y) : t.moveTo(q.x, q.y)); t.closePath(); t.filter = `blur(${Math.round(f.faceW * 0.04)}px)`; t.fill(); t.filter = 'none';
    ctx.save(); ctx.globalAlpha = p; ctx.drawImage(this.tmp2, 0, 0); ctx.restore();
    this.drawEyes(ctx, { color: s.eyeColor || '#6f8bff', size: 0.09, alpha: Math.max(p, pAll * 0.6) }, 1);
  }

  // Debug overlay: every detected point + lock status.
  drawDebug(ctx) {
    const W = this.W, H = this.H, s = Math.max(1.5, W / 400);
    if (this.bbox) { ctx.save(); ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'source-over'; const t = this.tmp2Ctx; t.globalCompositeOperation = 'copy'; t.fillStyle = '#00e5ff'; t.fillRect(0, 0, W, H); t.globalCompositeOperation = 'destination-in'; t.drawImage(this.mask, 0, 0); t.globalCompositeOperation = 'source-over'; ctx.drawImage(this.tmp2, 0, 0); ctx.restore(); }
    if (this.facePts && this.face && performance.now() - this.face.seen < 400) {
      ctx.fillStyle = '#7CFF6B'; for (const p of this.facePts) ctx.fillRect(p.x * W - s / 2, p.y * H - s / 2, s, s);
      ctx.fillStyle = '#ff3df2'; for (let i = 468; i < 478; i++) { const p = this.facePts[i]; ctx.beginPath(); ctx.arc(p.x * W, p.y * H, s * 1.6, 0, 7); ctx.fill(); }
    }
    if (this.posePts) {
      const P = i => this.posePts[i], ok = i => (P(i).visibility ?? 1) > 0.4;
      ctx.strokeStyle = '#ffd400'; ctx.lineWidth = s * 2;
      for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28]]) if (ok(a) && ok(b)) { ctx.beginPath(); ctx.moveTo(P(a).x * W, P(a).y * H); ctx.lineTo(P(b).x * W, P(b).y * H); ctx.stroke(); }
      ctx.fillStyle = '#ffd400'; for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) if (ok(i)) { ctx.beginPath(); ctx.arc(P(i).x * W, P(i).y * H, s * 3, 0, 7); ctx.fill(); }
    }
    // the piece-by-piece mapping currently in use: face pieces turquoise, body pieces pink, face↔body links yellow
    if (this.lastMesh) {
      const M = this.lastMesh; ctx.save(); ctx.lineWidth = Math.max(1, W / 500);
      for (const t of M.tris) {
        const kind = t.map(i => M.keys[i][0]), face = kind.every(k => k === 'f'), body = kind.every(k => k === 'p');
        ctx.strokeStyle = face ? '#00f0ff' : body ? '#ff4fd8' : '#ffd400'; ctx.fillStyle = face ? '#00f0ff14' : body ? '#ff4fd822' : '#ffd40018';
        ctx.beginPath(); t.forEach((i, j) => j ? ctx.lineTo(M.dst[i].x, M.dst[i].y) : ctx.moveTo(M.dst[i].x, M.dst[i].y)); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
    const v = this.visible(), f = this.face, lock = v.face && v.frontal && v.shoulders && v.body;
    // gaze-hold progress bar (needs 0.5 s in a row)
    if (this.frontalSince != null && !v.frontal) { const p = Math.min(1, (performance.now() - this.frontalSince) / 500); ctx.fillStyle = '#3dff7a'; ctx.fillRect(0, Math.round(W / 36) * 3.2, W * p, 6); }
    const line = `${this.posture === 'stand' ? '🧍 עומדת' : this.posture === 'sit' ? '🪑 יושבת' : '? תנוחה'}  ${v.face ? '✓' : '✗'} פנים  ${v.frontal ? '✓' : '✗'} מבט  ${v.shoulders ? '✓' : '✗'} כתפיים  ${v.hands ? '✓' : '✗'} ידיים  ${v.body ? '✓' : '✗'} גוף`;
    const fs = Math.round(W / 36); ctx.font = `700 ${fs}px system-ui`; ctx.textAlign = 'center'; ctx.direction = 'rtl';
    ctx.fillStyle = '#000a'; ctx.fillRect(0, 0, W, fs * 3.2);
    ctx.fillStyle = '#fff'; ctx.fillText(line, W / 2, fs * 1.2);
    ctx.fillStyle = lock ? '#3dff7a' : '#ff5a5a'; ctx.fillText(lock ? '● נעול — אפשר להפעיל' : '○ מחפש…', W / 2, fs * 2.6);
    ctx.textAlign = 'start'; ctx.direction = 'inherit';
  }

  // ---------- frame ----------
  frame(ts) {
    if (!this.ready || this.video.readyState < 2) return;
    this.setup(); this.track(ts);
    if (this.active?.remix) return this.drawRemix();
    const ctx = this.ctx, W = this.W, H = this.H, st = this.active;
    let personA = 1, layerA = 1, pBlur = 0, pGlow = 0, returnFlash = 0; const draw = [];
    if (st) {
      const t = (performance.now() - st.t0) / 1000;
      for (const s of st.fx.timeline) {
        const k = (t - s.t) / s.d;
        // vanish: she dissolves into blurred light; return: she condenses back from light to sharp
        if (s.do === 'vanish' && t >= s.t) { const p = clamp(k); personA = Math.min(personA, 1 - p); layerA = Math.min(layerA, 1 - p); pBlur = Math.max(pBlur, ease(p) * W / 28); pGlow = Math.max(pGlow, Math.sin(Math.PI * p) * 0.8); if (!st.vanishing) { st.vanishing = true; if (!this.transparent) { this.fillPlate(); this.filledReady = true; } } } // (a transparent program never shows her room's plate: she dissolves over the stage page)
        if (s.do === 'return' && t >= s.t) { const p = clamp(k); personA = Math.max(personA, ease(p)); layerA = 0; pBlur = (1 - ease(p)) * W / 22; pGlow = (1 - p) * 0.9; returnFlash = Math.sin(Math.PI * Math.min(1, p * 1.6)); }
        if (k >= 0 && (k <= 1 || PERSIST.includes(s.do))) draw.push({ s, k });
      }
      if (t > st.fx.duration) { this.active = null; st.vanishing = false; personA = 1; }
      else if (st.fx.timeline.some(s => s.do === 'return' && t >= s.t + s.d)) { st.vanishing = false; }
    }
    if (this.maskFresh) this.updatePlate(); // the clean plate is refreshed whenever a new body mask arrived
    // optional background swap: {do:"background", image:"room"} fades her room into the effect's room
    let bg = null;
    if (st) { const t = (performance.now() - st.t0) / 1000; for (const s of st.fx.timeline) if (s.do === 'background' && t >= s.t && t <= s.t + s.d) { const im = st.fx.img[s.image]; if (im?.naturalWidth) bg = { im, a: Math.min(ease((t - s.t) / (s.fade || 0.6)), ease((s.t + s.d - t) / (s.fade || 0.6))) }; } }
    ctx.globalCompositeOperation = 'source-over';
    // transparent program (?stage=): the canvas is cleared and only her cut-out goes on it — the stage page behind the canvas
    // is the background. The effect's room still fades in over the stage; her own room (camera / plate) is never painted.
    const cut = !!this.transparent; if (cut) ctx.clearRect(0, 0, W, H);
    if (bg) {
      const im = bg.im, sc = Math.max(W / im.naturalWidth, H / im.naturalHeight), iw = im.naturalWidth * sc, ih = im.naturalHeight * sc;
      if (!cut) ctx.drawImage(this.video, 0, 0, W, H);
      ctx.globalAlpha = bg.a; ctx.drawImage(im, (W - iw) / 2, (H - ih) / 2, iw, ih); ctx.globalAlpha = 1;
      this.personLayer(ctx, personA, { blur: pBlur, glow: pGlow, grade: bg });
      this.plateDirty = true; // tmp was used for the rim light; updatePlate redraws it next frame anyway
    }
    else if (personA >= 0.999 && pBlur < 0.5) { if (cut) this.personLayer(ctx, 1); else ctx.drawImage(this.video, 0, 0, W, H); }
    else { if (!cut) { if (!this.filledReady) { this.fillPlate(); this.filledReady = true; } ctx.drawImage(this.filled, 0, 0); } this.personLayer(ctx, personA, { blur: pBlur, glow: pGlow }); }
    if (personA >= 0.999 && pBlur < 0.5) this.filledReady = false;
    if (returnFlash > 0.01) { const at = this.bbox ? { x: this.bbox.cx, y: this.bbox.cy } : { x: W / 2, y: H / 2 }; this.drawGlowBurst(ctx, at, Math.max(W, H) * 0.55, st?.fx.returnColor || '#a259ff', returnFlash * 0.75); }
    if (!st) { this.lastMesh = null; if (this.debug) this.drawDebug(ctx); return; }
    const fx = st.fx;
    const onPerson = d => PERSIST.includes(d) || d === 'sparkle';
    for (const { s, k } of draw) {
      const a = { ...s, alpha: (s.alpha ?? 1) * (onPerson(s.do) ? layerA : 1) };
      if (a.alpha <= 0.01) continue;
      if (s.do === 'bodyTexture') this.drawBodyTexture(ctx, a, k, fx);
      else if (s.do === 'faceMorph') this.drawFaceMorph(ctx, a, k);
      else if (s.do === 'bodyTint') this.drawBodyTint(ctx, a, k);
    }
    for (const { s, k } of draw) {
      const a = { ...s, alpha: (s.alpha ?? 1) * (onPerson(s.do) ? layerA : 1) };
      if (a.alpha <= 0.01 && s.do !== 'clip' && s.do !== 'flash') continue;
      if (s.do === 'hat' || s.do === 'attach') this.drawAttach(ctx, a, k, fx);
      else if (s.do === 'eyesGlow') this.drawEyes(ctx, a, k);
      else if (s.do === 'sparkle') this.drawSparkle(ctx, a, k);
      else if (s.do === 'flash') { const at = this.bbox ? { x: this.bbox.cx, y: this.bbox.cy } : { x: W / 2, y: H / 2 }; this.drawGlowBurst(ctx, at, Math.max(W, H) * (0.3 + k * 0.7), s.color || '#a259ff', Math.sin(Math.PI * clamp(k))); }
      else if (s.do === 'clip') this.drawClip(ctx, a, k, fx, st);
      else if (s.do === 'layer') this.drawLayer(ctx, a, k, fx, st);
    }
    if (this.debug) this.drawDebug(ctx);
  }

  // ---------- SCREEN PUNCHES: a glove hits the camera, the whole picture shakes/jumps, flash + cracked glass ----------
  // screenHits(n): n punches in a row (×2 = 2, ×3 = 3).  startDouble(mult, sec): while the double runs he keeps punching.
  // THE GNOME hits the screen: his clip plays over the picture and at each of his hit times (from the clip's sound)
  // the camera jumps/shakes and the glass cracks. ×2 = slap clip, ×3 = "one two three", ×5 = frenzy, 1 = short punch.
  async loadGnome() {
    if (this.gnomeClips) return this.gnomeClips;
    try {
      const j = await (await fetch('/api/battle')).json(), by = Object.fromEntries(j.clips.map(c => [c.id, c]));
      const pick = id => by[id] && { id, url: by[id].url, hits: by[id].meta?.hits || [] };
      this.gnomeClips = { 1: pick('gnome_punch_short'), 2: pick('multiplier_x2'), 3: pick('multiplier_x3'), 5: pick('glove_x5') };
      for (const c of Object.values(this.gnomeClips)) if (c) { const v = document.createElement('video'); v.src = c.url; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.load(); c.v = v; }
    } catch { this.gnomeClips = {}; }
    return this.gnomeClips;
  }
  playGnome(n, from = 0, until = null) {
    const c = this.gnomeClips?.[n] || this.gnomeClips?.[1]; if (!c?.v) return false;
    c.v.currentTime = from; c.v.play().catch(() => {});
    // hits before the start point are already "fired"
    this.gnomeA = { c, until, fired: new Set(c.hits.map((t, i) => t < from ? i : -1).filter(i => i >= 0)) }; return true;
  }

  // ---------- TOMATO ON A HEAD: pick a head (click), every rose throws a tomato that splats on that head ----------
  pickHeadAt(nx, ny) {
    const hs = this.heads || []; let best = null, bd = 1e9;
    for (const h of hs) { const d = Math.hypot(h.cx - nx, h.cy - ny); if (d < bd) { bd = d; best = h; } }
    if (!best || bd > Math.max(0.15, best.w)) { this.target = null; this.log('🎯 אין ראש כאן — בוטל'); return null; }
    this.target = { cx: best.cx, cy: best.cy, w: best.w, h: best.h, seen: performance.now() }; this.log('🎯 נבחר ראש למטרה'); return this.target;
  }
  async loadTomato() {
    if (this.tomatoClip) return this.tomatoClip;
    try { const j = await (await fetch('/api/battle')).json(), t = j.clips.find(c => c.id === 'tomato'); if (t) { const v = document.createElement('video'); v.src = t.url; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.load(); this.tomatoClip = { url: t.url, face: t.meta?.face || { x: 0.5, y: 0.38, size: 0.4 }, v }; } } catch {}
    return this.tomatoClip;
  }
  // ---- THE BATTLE TARGET: the live head of whoever is facing us (opponent.js) ----
  // His video is TikTok's (it is not in our broadcast), so his head is taken from the PHONE's battle screen.
  // Automatic = the one facing us (the biggest head on the right half; the host is on the left). The operator can pick
  // any other head on that screen (2v2: one of the four). The same head feeds everything: battle clips
  // (battle-stage.js), the tomatoes, and the small round face of the head-tomato.
  // src: nothing = the phone over ADB;  a video file (.mp4/.webm) = a stand-in for the phone screen (tests).
  watchOpponent(src) {
    if (this.opp || !Opponent) return this.opp || null;
    const qs = new URLSearchParams(location.search), o = { log: this.log };
    if (qs.get('oppRegion')) o.region = qs.get('oppRegion').split(',').map(Number);
    if (qs.get('oppHost') === '0') o.needHost = false;
    if (src && /\.(mp4|webm|mov)(\?|$)/i.test(src)) o.video = src;
    else if (src) { o.snap = src; o.stream = src.includes('phone.jpg') ? src.replace('phone.jpg', 'phone.mjpeg') : null; }
    const opp = this.opp = new Opponent(o);
    opp.onStill = k => { this.oppFace = k; this.oppFaceAt = performance.now(); };
    opp.enabled = this.useOppFace !== false;
    opp.start(); this.battle.opp = opp;
    this.log('👤 מחפש את מי שמולך במסך הקרב בטלפון');
    return opp;
  }
  // a battle clip on the target (snipe, diaper, gloves…): his head is used when there is one, otherwise the clip plays as it is
  async playBattle(id, opt = {}) { await this.battle.load();
    // never twice: the same clip was started a moment ago (two rules on one event), or it already runs as the double's own
    // clip — on the head (only the double's chain carries onEnd) or as the gnome punching the screen
    // (a supporter effect — layer "fan" — is about a person: the stage itself drops the same one twice and lines the others up)
    const fan = this.battle.clips[id]?.head?.layer === 'fan';
    const same = !fan && this.battle.live.find(I => I.id === id && (performance.now() - I.t0 < 2000 || I.onEnd)); if (same) return same;
    if (!fan && this.double && !this.double.onHead && this.gnomeA?.c.id === id) return null;
    const I = this.battle.play(id, { tag: 'special', ...opt }); if (I) this.log(fan ? '💛 ' + (this.battle.clips[id].name || id).replace('×N', opt.vars?.mult ? '×' + opt.vars.mult : '') + (opt.who?.name ? ' · ' + opt.who.name : '') : '⚔ ' + (this.battle.clips[id].name || id) + (this.battle.target() ? ' על הראש של המתחרה' : '')); return I; }
  // a hit inside a battle clip: our picture jolts. On his head: no cracked glass (it is HIS head that is hit, not our
  // screen). A clip playing alone (no target): the gnome punches our screen like he always did — glass cracks and flashes.
  battleHit(h) {
    const a = !!h.alone;
    (this.punches ||= []).push({ at: performance.now(), side: 1, x: a ? 0.5 + (Math.random() - 0.5) * 0.35 : 0.5, y: a ? 0.38 + (Math.random() - 0.5) * 0.2 : 0.4, seed: Math.random() * 1e6, big: h.big, noGlove: true, noCrack: !a, noFlash: !a && !h.big, small: h.soft && !h.splat });
    if (h.splat && h.muted) this.splatSound();
  }
  // the face stored on the server (found by another open panel / the clean program) -> use it here too
  setOpponentFace(url, at) {
    const im = new Image();
    im.onload = () => { const S = 320, o = canvas(S, S); o.getContext('2d').drawImage(im, 0, 0, S, S); this.oppFace = o; this.oppFaceAt = performance.now() - Math.max(0, Date.now() - (at || Date.now())); };
    im.src = url;
  }
  // a face is used only while it is fresh (the battle is still on the phone screen) and the switch is on
  oppFaceNow() { return this.useOppFace !== false && this.oppFace && performance.now() - (this.oppFaceAt || 0) < 30000 ? this.oppFace : null; }

  // ---- throwing tomatoes ----
  //  1) a head in OUR picture was chosen ("בחר ראש")  -> a normal tomato flies to that head
  //  2) there is a battle target                       -> his LIVE head comes up on our screen and the tomatoes land on it
  //     (style "head": a HEAD-TOMATO instead — the tomato itself has his face and smashes on our screen)
  //  3) otherwise                                       -> a normal tomato smashes on our screen
  throwTomato(count = 1, style) {
    count = Math.max(1, Math.min(10, count | 0)); style ||= this.tomatoStyle || 'live';
    // the target's LIVE head is on our screen and the tomatoes are thrown at it (style "head" = the tomato itself has his face)
    if (!this.target && style !== 'head' && this.battle.clips.tomato?.head && this.battle.target()) {
      for (let i = 0; i < count; i++) setTimeout(() => this.battle.play('tomato', { jitter: i ? (Math.random() - 0.5) * 0.06 : 0, tag: 'tomato' }), i * 550);
      return;
    }
    if (!this.target && this.oppFaceNow()) {
      for (let i = 0; i < count; i++) setTimeout(() => { const f = this.oppFaceNow(); if (f) (this.headTomatoes ||= []).push(newHeadTomato(f)); }, i * 550);
      return;
    }
    const tc = this.tomatoClip; if (!tc) { this.loadTomato().then(c => c && this.throwTomato(count)); return; }
    const head = this.target || { screen: true, cx: 0.5, cy: 0.42, w: 0.46, h: 0.4 };
    this.tomatoes ||= [];
    for (let i = 0; i < count; i++) setTimeout(() => {
      const v = document.createElement('video'); v.src = tc.url; v.muted = true; v.playsInline = true; v.play().catch(() => {});
      this.tomatoes.push({ v, head: head.screen ? { ...head, cx: 0.5 + (Math.random() - 0.5) * 0.3, cy: 0.42 + (Math.random() - 0.5) * 0.2 } : (this.target || head), t0: performance.now(), seed: Math.random() * 1e6, hit: false, jitter: (Math.random() - 0.5) * 0.25 });
    }, i * 450);
  }
  drawHeadTomatoes(ctx, now) {
    this.headTomatoes = this.headTomatoes.filter(T => {
      const st = drawHeadTomato(ctx, this.W, this.H, T, now);
      // the moment it lands: the screen takes the hit (a jolt, no cracked glass) + a wet splat sound
      if (st === 'hit') { (this.punches ||= []).push({ at: now, side: 1, x: T.x, y: T.y, seed: T.seed, noGlove: true, noCrack: true, noFlash: true }); this.splatSound(); }
      return st !== 'done';
    });
  }
  drawTomatoes(ctx, now) {
    const W = this.W, H = this.H;
    this.tomatoes = (this.tomatoes || []).filter(T => !T.v.ended);
    for (const T of this.tomatoes) {
      const v = T.v; if (!v.videoWidth) continue;
      // follow the chosen head live while the tomato flies
      const h = this.target && T.head === this.target ? this.target : T.head, f = this.tomatoClip.face;
      const headW = h.w * W * 1.25, sc = headW / (f.size * v.videoWidth), w = v.videoWidth * sc, hh = v.videoHeight * sc;
      const x = h.cx * W - f.x * w + T.jitter * headW * 0.3, y = h.cy * H - f.y * hh;
      ctx.drawImage(v, x, y, w, hh);
      // the splat moment in the clip (1.1 s): on a head a small jolt; on the screen a real hit on the glass
      if (!T.hit && v.currentTime >= 1.1) { T.hit = true; (this.punches ||= []).push({ at: now, side: 1, x: h.cx, y: h.cy, seed: T.seed, noGlove: true, noCrack: true, noFlash: true, small: !h.screen }); this.splatSound(); }
    }
  }
  // a short wet splat (a filtered noise burst + a low thud), synthesized — no file needed
  splatSound() {
    try {
      const ac = this.ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime, n = ac.createBufferSource(), b = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.35), ac.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(220, t + 0.3); f.Q.value = 0.8;
      const g = ac.createGain(); g.gain.value = 0.9; n.buffer = b; n.connect(f).connect(g).connect(ac.destination); n.start(t);
      const o = ac.createOscillator(), og = ac.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.18);
      og.gain.setValueAtTime(0.7, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.22); o.connect(og).connect(ac.destination); o.start(t); o.stop(t + 0.25);
    } catch {}
  }

  // WAKE UP: everyone fell asleep -> the gnome bursts in slapping the screen, "WAKE UP!", and ends with one huge BOOM
  wakeUp() {
    this.wake = { t0: performance.now(), stage: 'sleep' };
    this.log('😴 → 🥊 WAKE UP');
  }
  drawWake(ctx, now) {
    const w = this.wake, W = this.W, H = this.H, t = (now - w.t0) / 1000;
    const SLEEP = 1.4, BOOM = 3.4, END = 5.0;
    if (t > END) { this.wake = null; return; }
    // 1) sleeping: the picture dims, Z z z floats up
    const dim = t < SLEEP ? Math.min(0.55, t / SLEEP * 0.55) : Math.max(0, 0.55 - (t - SLEEP) * 2.5);
    if (dim > 0) { ctx.fillStyle = `rgba(5,5,20,${dim})`; ctx.fillRect(0, 0, W, H); }
    if (t < SLEEP + 0.2) {
      ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = '#c9d4ff';
      for (let i = 0; i < 3; i++) { const k = ((t * 0.9 + i * 0.33) % 1); ctx.globalAlpha = Math.sin(Math.PI * k) * 0.9; ctx.font = `800 ${Math.round(W / (10 - i * 2))}px system-ui`; ctx.fillText('Z', W * (0.62 + i * 0.08), H * (0.34 - k * 0.18 - i * 0.05)); }
      ctx.restore();
    }
    // 2) the gnome bursts in slapping (from his slap clip, just before the slaps start)
    // the gnome bursts in and SHOUTS "WAKE UP!" (voice, no text on screen)
    if (t >= SLEEP && w.stage === 'sleep') { w.stage = 'slap'; this.playGnome(2, 1.25, 3.3); this.wakeVoice(); }
    // 3) the last giant slap — boom sound, strong flash, big crack, the whole screen shakes hard (no text)
    if (t >= BOOM && w.stage === 'slap') {
      w.stage = 'boom'; if (this.gnomeA) { this.gnomeA.c.v.pause(); this.gnomeA = null; } this.boomSound();
      (this.punches ||= []).push({ at: now, side: 1, x: 0.5, y: 0.45, seed: Math.random() * 1e6, big: true, mega: true, noGlove: true });
    }
  }

  wakeVoice() { try { const a = new Audio('/media/fx/assets/wake-up.mp3'); a.volume = 1; a.play().catch(() => {}); } catch {} }

  // the BOOM is a SOUND (deep thump + rumble), not text — synthesized, no file needed
  boomSound() {
    try {
      const ac = this.ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime, out = ac.createGain(); out.gain.value = 0.9; out.connect(ac.destination);
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(32, t + 0.9);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6); o.connect(g).connect(out); o.start(t); o.stop(t + 1.7);
      const n = ac.createBufferSource(), b = ac.createBuffer(1, ac.sampleRate * 1.8, ac.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.5);
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; const ng = ac.createGain(); ng.gain.value = 0.8;
      n.buffer = b; n.connect(lp).connect(ng).connect(out); n.start(t);
    } catch {}
  }
  screenHits(count = 1, gap = 380) {
    if (this.gnomeClips && this.playGnome(count)) return; // the gnome does it
    const now = performance.now(), APPROACH = 230; this.punches ||= [];
    const last = this.punches.reduce((m, p) => Math.max(m, p.at), 0);
    for (let i = 0; i < count; i++) {
      const at = Math.max(now + APPROACH, last + gap) + i * gap;
      // alternate left/right gloves, aim around the middle of the frame
      this.punches.push({ at, side: (this.punchSide = -(this.punchSide || 1)), x: 0.5 + (Math.random() - 0.5) * 0.3, y: 0.42 + (Math.random() - 0.5) * 0.18, seed: Math.random() * 1e6, big: i === count - 1 });
    }
  }
  startDouble(mult = 2, seconds = 30) {
    const now = performance.now(), id = { 2: 'multiplier_x2', 3: 'multiplier_x3', 5: 'glove_x5' }[mult];
    // with a battle target the gnome hits HIS head for the whole double (battle-stage.js); without one he hits our screen
    const onHead = !!(id && this.battle.clips[id]?.head && this.battle.target());
    const D = this.double = { mult, start: now, until: now + seconds * 1000, gap: { 2: 1500, 3: 1100, 5: 750 }[mult] || 1200, next: now + 300, gnome: onHead || !!this.gnomeClips, onHead };
    if (onHead) {
      if (this.gnomeA) { this.gnomeA.c.v.pause(); this.gnomeA = null; } // a gnome still on the screen from an earlier double makes way
      // the clip plays again and again while THIS double is the current one. A copy that already plays (the "special" of
      // the same gift, or the previous double's clip) is taken over instead of starting a second gnome on the head.
      const again = () => { if (this.double === D && performance.now() < D.until) this.battle.play(id, { tag: 'double', onEnd: again }); };
      const running = this.battle.live.find(I => I.id === id); this.battle.stop('double', running);
      if (running) running.onEnd = again; else again();
    } else {
      this.battle.stop('double'); // an on-head double that was running is replaced
      // the gnome keeps hitting the screen, clip after clip, until the double ends. One gnome only: a copy of the same
      // clip that the "special" rule started a moment ago makes way for him.
      if (D.gnome && this.playGnome(mult)) this.battle.end(id);
    }
    this.log(`🥊 דאבל ×${mult} ל-${seconds} שניות`);
  }
  stopDouble() { this.double = null; this.battle.stop('double'); if (this.gnomeA) { this.gnomeA.c.v.pause(); this.gnomeA = null; } }
  glove() { if (!this._glove) { this._glove = new Image(); this._glove.src = new URL('assets/glove.png', document.baseURI).href; } return this._glove; }

  drawCrack(ctx, x, y, R, seed, alpha) {
    let s = seed; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = '#ffffff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.lineCap = 'round';
    const rays = 9 + Math.floor(rnd() * 5);
    for (let i = 0; i < rays; i++) {
      let a = (i / rays) * Math.PI * 2 + rnd() * 0.4, px = x, py = y, len = R * (0.45 + rnd() * 0.65);
      ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(px, py);
      for (let k = 0; k < 5; k++) { a += (rnd() - 0.5) * 0.5; px += Math.cos(a) * len / 5; py += Math.sin(a) * len / 5; ctx.lineTo(px, py);
        if (rnd() < 0.35) { const b = a + (rnd() - 0.5) * 1.6; ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(b) * len * 0.18, py + Math.sin(b) * len * 0.18); ctx.moveTo(px, py); } }
      ctx.stroke();
    }
    ctx.lineWidth = 1.2; for (let r = 0.12; r < 0.5; r += 0.16) { ctx.beginPath(); for (let i = 0; i <= rays; i++) { const a = (i / rays) * Math.PI * 2, rr = R * r * (0.85 + rnd() * 0.3); i ? ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.stroke(); }
    ctx.restore();
  }

  postFX() {
    if (!this.W) return;
    const now = performance.now(), W = this.W, H = this.H, ctx = this.ctx;
    // double mode: keep punching until the time runs out
    const D = this.double;
    if (D) {
      if (now >= D.until) { this.double = null; this.battle.stop('double'); if (this.gnomeA) { this.gnomeA.c.v.pause(); this.gnomeA = null; } this.log('דאבל נגמר'); }
      else if (!D.gnome && now >= D.next) { this.screenHits(1); D.next += D.gap; }
    }
    // the gnome clip on top of the picture; each of his hits = an impact on the camera
    const G = this.gnomeA;
    if (G) {
      const v = G.c.v;
      if (v.videoWidth) { const sc = Math.max(W / v.videoWidth, H / v.videoHeight), w = v.videoWidth * sc, h = v.videoHeight * sc; ctx.drawImage(v, (W - w) / 2, H - h, w, h); }
      G.c.hits.forEach((t, i) => { if (!G.fired.has(i) && v.currentTime >= t) { G.fired.add(i); (this.punches ||= []).push({ at: now, side: 1, x: 0.5 + (Math.random() - 0.5) * 0.35, y: 0.38 + (Math.random() - 0.5) * 0.2, seed: Math.random() * 1e6, big: i === G.c.hits.length - 1 || i % 3 === 2, noGlove: true }); } });
      if (v.ended || (v.duration && v.currentTime >= v.duration - 0.04) || (G.until && v.currentTime >= G.until)) { if (G.until) v.pause(); if (this.double?.gnome && !this.double.onHead) this.playGnome(this.double.mult); else this.gnomeA = null; }
    }
    if (this.battle.busy) this.battle.draw(ctx, W, H, now);
    if (this.tomatoes?.length) this.drawTomatoes(ctx, now);
    if (this.headTomatoes?.length) this.drawHeadTomatoes(ctx, now);
    if (this.wake) this.drawWake(ctx, now);
    this.punches = (this.punches || []).filter(p => now - p.at < (p.mega ? 2600 : 1600));
    if (!this.punches.length && !this.double && !this.wake && !this.headTomatoes?.length) return;
    // camera reaction to the latest impacts: shake + punch-zoom
    let sx = 0, sy = 0, zoom = 1, flash = 0;
    for (const p of this.punches) {
      const t = now - p.at; if (t < 0) continue;
      // mega = the WAKE UP boom: much stronger and longer earthquake
      const k = Math.exp(-t / (p.mega ? 520 : p.big ? 130 : 95)), amp = (p.mega ? 0.075 : p.big ? 0.05 : p.small ? 0.014 : 0.032) * W;
      sx += Math.sin(t / (p.mega ? 22 : 16) + p.seed) * amp * k; sy += Math.cos(t / (p.mega ? 19 : 13) + p.seed) * amp * 0.8 * k;
      zoom = Math.max(zoom, 1 + (p.mega ? 0.16 : p.big ? 0.11 : p.small ? 0.025 : 0.07) * Math.exp(-t / (p.mega ? 260 : 140))); if (!p.small && !p.noFlash) flash = Math.max(flash, (p.mega ? 0.95 : p.big ? 0.7 : 0.5) * Math.exp(-t / (p.mega ? 140 : 70)));
    }
    if (sx || sy || zoom > 1.0005) {
      if (!this.post || this.post.width !== W) { this.post = canvas(W, H); this.postCtx = this.post.getContext('2d'); }
      if (this.transparent) this.postCtx.clearRect(0, 0, W, H); // a transparent picture must not pile up on last frame's copy
      this.postCtx.drawImage(this.out, 0, 0);
      const z = zoom + Math.hypot(sx, sy) / W * 2.2; // zoom a bit more than the shake so no edges show
      ctx.save(); ctx.globalCompositeOperation = 'copy'; ctx.translate(W / 2 + sx, H / 2 + sy); ctx.scale(z, z); ctx.drawImage(this.post, -W / 2, -H / 2); ctx.restore();
    }
    // cracked glass where each punch landed (fades over 1.4 s)
    for (const p of this.punches) { const t = now - p.at; if (t >= 0 && !p.noCrack) this.drawCrack(ctx, p.x * W, p.y * H, W * (p.mega ? 0.75 : p.big ? 0.42 : 0.3), p.seed, Math.max(0, 1 - t / (p.mega ? 2400 : 1400)) * 0.9); }
    // the glove flying at the lens and pulling back
    const g = this.glove();
    if (g.naturalWidth) for (const p of this.punches) {
      const t = now - p.at; if (p.noGlove || t < -230 || t > 170) continue;
      const k = t < 0 ? 1 - (-t / 230) : 1 - t / 170, e = t < 0 ? k * k : k; // accelerate in, ease out
      const size = W * (0.35 + 0.95 * e) * (p.big ? 1.15 : 1), gx = p.x * W + p.side * (1 - e) * W * 0.9, gy = p.y * H + (1 - e) * H * 0.35;
      ctx.save(); ctx.globalAlpha = Math.min(1, 0.4 + e); ctx.translate(gx, gy); if (p.side < 0) ctx.scale(-1, 1); ctx.rotate(-0.35 * (1 - e));
      ctx.drawImage(g, -size / 2, -size / 2, size, size); ctx.restore();
    }
    if (flash > 0.01) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = flash; ctx.fillStyle = '#fff3e0'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    // double banner + time bar
    if (this.double) {
      const left = (this.double.until - now) / (this.double.until - this.double.start), pulse = 1 + 0.06 * Math.sin(now / 90), fs = Math.round(W / 9 * pulse);
      ctx.save(); ctx.direction = 'ltr'; ctx.textAlign = 'center'; ctx.font = `900 ${fs}px system-ui, Arial`; ctx.lineWidth = fs / 9; ctx.strokeStyle = '#000'; ctx.fillStyle = '#ffcf33';
      const y = H * 0.12; ctx.strokeText(`×${this.double.mult} 🥊`, W / 2, y); ctx.fillText(`×${this.double.mult} 🥊`, W / 2, y);
      ctx.fillStyle = '#0008'; ctx.fillRect(W * 0.2, y + fs * 0.25, W * 0.6, 10); ctx.fillStyle = '#ffcf33'; ctx.fillRect(W * 0.2, y + fs * 0.25, W * 0.6 * left, 10); ctx.restore();
    }
  }

  start() {
    const loop = () => { try { this.frame(performance.now()); this.postFX(); } catch (e) { this.log('frame error ' + e.message); } this.raf = requestAnimationFrame(loop); };
    loop();
  }
}
