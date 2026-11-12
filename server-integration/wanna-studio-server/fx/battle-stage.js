// BATTLE CLIPS ON THE TARGET'S HEAD — shared by the live panel (fx-engine.js) and the clean foreground layer.
//
// Every battle clip (media/battle/<id>.webm) can say in media/battle/heads.json where the target's head goes:
//   layer "under": the head is shown on OUR screen and the clip plays over it — things are thrown / punched at it
//                  (tomato, diaper, the gnome's kicks and slaps). The head pops in, jolts on every hit, leaves at the end.
//   layer "over" : the clip has a BODY (the sniper's dancer in the skirt, the dancer, the tiny one on the palm…): the
//                  body's own head is erased and the target's head sits on it, following the body frame by frame.
// The head itself comes from opponent.js (the one facing us, or the head the operator picked) and is LIVE video.
// With no target (no battle on the phone, or the switch off) the clips simply play as they are.
//   layer "fan"  : a SUPPORTER's effect (×2 / ×3 / ×50, MVP…): whoever gave is in it — the profile picture becomes a
//                  cut-out head inside the clip (AvatarHeads in opponent.js), with what is written and the name. See _fan().
//
// All positions in heads.json are in CLIP pixels:  head/track x,y = the cheek midpoint (centre of the skull),
// h = face height (forehead top -> chin), roll in radians.  "place" says how the clip sits on a 9:16 stage.
// Other keys: placeAlone (layout when there is no head), src (a lighter copy of the clip), mask (soft edges), blend
// ("lighter" = a clip on black that is added to the picture), texts (big captions drawn by us), hits / impacts / show /
// lead / fade (timing), erase / lens / front / shape / back / track / step (bodies) — each explained where it is used.
import { AvatarHeads } from './opponent.js';
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const backOut = t => { t = clamp(t); const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }; // pops a little past full size

export class BattleStage {
  constructor({ opp = null, onHit = () => {}, log = () => {}, sound = true } = {}) {
    this.opp = opp; this.onHit = onHit; this.log = log; this.sound = sound;
    this.clips = {}; this.imgs = {}; this.masks = {}; this.live = []; this.jolts = []; this.loaded = null; this.spr = null;
    this.avatars = new AvatarHeads(() => this.opp);        // heads cut from supporters' profile pictures ("fan" clips)
  }
  load() {
    return this.loaded ||= (async () => {
      const j = await (await fetch('/api/battle')).json();
      for (const c of j.clips) {
        this.clips[c.id] = c;
        for (const fr of c.head?.front || []) if (fr.img && !this.imgs[fr.img]) { const im = new Image(); im.src = `/media/battle/${fr.img}`; this.imgs[fr.img] = im; }
      }
      return this;
    })().catch(e => { this.loaded = null; this.log('קליפי הקרב לא נטענו: ' + e.message); return this; });
  }
  has(id) { return !!this.clips[id]; }
  get busy() { return this.live.length > 0; }
  // can the target's head be used right now?
  target(now = performance.now()) { return this.opp ? this.opp.head(now) : null; }

  // play(id): start a battle clip. jitter = small sideways offset (several tomatoes in a row don't land on one spot)
  // who = { name, avatar } and vars = { mult, … }: the supporter a "fan" clip is about, and what is written in it
  play(id, opt = {}) {
    const { from = 0, jitter = 0, tag = null, onEnd = null, who = null, vars = null } = opt;
    const c = this.clips[id]; if (!c) return null;
    const hd = c.head || null, now = performance.now(), fan = hd?.layer === 'fan', alone = fan ? false : !this.target(now);
    if (fan && !opt.queued) {
      // one supporter effect at a time: the same one again within 2.5 s is the same event (two rules on one gift) and is
      // dropped; a different one waits its turn (at most 8 wait)
      const key = id + '|' + (who?.name || '') + '|' + (vars?.mult ?? ''), running = this.live.find(J => J.hd?.layer === 'fan');
      if (this.fanLast?.key === key && now - this.fanLast.at < 2500) return running || null;
      this.fanLast = { key, at: now };
      if (running) { (this.fanQ ||= []).push([id, { ...opt, queued: true }]); if (this.fanQ.length > 8) this.fanQ.shift(); return null; }
    }
    // heads.json "src": a lighter copy of the clip (media/battle/<src>) — positions stay in the ORIGINAL clip's pixels (vw x vh)
    const v = document.createElement('video'); v.src = hd?.src ? '/media/battle/' + hd.src : c.url; v.playsInline = true; v.preload = 'auto'; v.muted = !this.sound;
    if (from) v.currentTime = from;
    // "lead": a thrown clip waits a moment so the head is seen before the thing hits it. The first clip onto an empty
    // stage gets it; clips thrown right after it (a burst of tomatoes) wait the same time, so their spacing is kept.
    let lead = 0;
    if (hd?.layer === 'under' && !alone && !from) {
      const first = this.live.find(J => J.led && now - J.t0 < 2500);
      lead = first ? first.led : (hd.lead && !this.live.some(J => J.hd?.layer === 'under' && !J.alone) ? hd.lead * 1000 : 0);
    }
    const I = { id, c, v, hd, tag, onEnd, t0: now, jitter, alone, led: lead, seenAt: now + lead, fired: new Set(), sounded: new Set(), release: hd && !fan && this.opp ? this.opp.hold() : null, who, vars: vars || {} };
    if (fan) {
      const fill = s => String(s).replace(/\{(\w+)\}/g, (_, k) => I.vars[k] ?? (k === 'name' ? (who?.name || '') : ''));
      I.texts = (hd.texts || []).map(T => ({ ...T, str: fill(T.str) })).filter(T => T.str.replace(/[×x@\s]/g, '')); // "×{mult}" with no multiplier given is not written
      // his head is made once from the profile picture; the clip waits for it for a moment (at most 1.2 s)
      const src = this._avatarUrl(who?.avatar);
      I.ready = Promise.race([src ? this.avatars.get(src).then(h => { I.fan = h; }) : Promise.resolve(), new Promise(r => setTimeout(r, 1200))]);
    }
    // what already happened before "from" is not fired again
    const hl = !alone && hd?.hits ? hd.hits.map(h => h[0]) : c.meta?.hits || [];
    hl.forEach((t, i) => { if (t < from) I.fired.add('h' + i); }); (hd?.impacts || []).forEach((t, i) => { if (t < from) I.fired.add('i' + i); }); (hd?.sounds || []).forEach((s, i) => { if (s.t < from) I.sounded.add(i); });
    // the clip ends by itself, on an error, or — whatever happens (hidden tab, a file that never loads) — when its time is up
    v.addEventListener('ended', () => this._end(I)); v.addEventListener('error', () => { I.onEnd = null; this._end(I); }); // (a clip that cannot load is not started again by a double's chain)
    I.kill = setTimeout(() => this._end(I), ((hd?.dur || 12) + lead / 1000 + 4) * 1000);
    // the media time of the frame that is really on screen (more exact than currentTime for a fast-moving body)
    if (v.requestVideoFrameCallback) { const cb = (_, m) => { I.mt = m.mediaTime; if (this.live.includes(I)) v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
    const go = () => { if (this.live.includes(I)) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }; // sound needs a click on the page first; without one it plays silent
    this.live.push(I);
    if (I.ready) { v.load(); I.ready.then(go); } else if (lead) { v.load(); setTimeout(go, lead); } else go();
    return I;
  }
  stop(tag = null, keep = null) { if (!tag || tag === 'special') this.fanQ = []; for (const I of [...this.live]) if ((!tag || I.tag === tag) && I !== keep) this._end(I); } // keep = one clip that stays (a "stop" also empties the line of waiting supporter effects)
  end(id) { for (const I of [...this.live]) if (I.id === id) this._end(I); } // every playing copy of one clip
  _end(I) {
    const i = this.live.indexOf(I); if (i < 0) return; this.live.splice(i, 1); clearTimeout(I.kill);
    try { I.v.pause(); I.v.removeAttribute('src'); I.v.load(); } catch {} // free the decoder (browsers allow only so many players)
    if (!this.live.some(J => J.hd?.layer === 'under' && !J.alone)) this.spr = null; // nothing is thrown any more: the next run places the head afresh
    I.release?.(); I.onEnd?.();
    if (I.hd?.layer === 'fan' && this.fanQ?.length) { const [id, o] = this.fanQ.shift(); setTimeout(() => this.play(id, o), 200); } // the next supporter in line
  }

  // the 9:16 stage inside any canvas (a wide webcam picture gets a portrait stage in its middle)
  _stage(W, H) { const sw = Math.min(W, H * 9 / 16), sh = sw * 16 / 9; return { x: (W - sw) / 2, y: (H - sh) / 2, w: sw, h: sh }; }
  _dims(I) { return [I.hd?.vw || I.v.videoWidth || 0, I.hd?.vh || I.v.videoHeight || 0]; } // the clip's size (known from heads.json before the video has loaded)
  _rect(I, S) {
    const [vw, vh] = this._dims(I), p = (I.alone && I.hd?.placeAlone) || I.hd?.place || { cover: true }; // placeAlone: how the clip sits when there is no head to hit (the gnome then punches the screen itself)
    if (p.cover) { const sc = Math.max(S.w / vw, S.h / vh), w = vw * sc, h = vh * sc; return { x: S.x + (S.w - w) / 2, y: S.y + S.h - h, w, h, k: sc }; }
    const w = S.w * (p.w || 1), h = w * vh / vw;
    return { x: S.x + S.w * (p.cx ?? 0.5) - w / 2, y: S.y + S.h * (p.cy ?? 0.5) - h / 2, w, h, k: w / vw };
  }
  _back(ctx, I, r) { // heads.json "back": [["ring", cx, cy, r0, r1, colour | [[radius, colour], …]]] in clip pixels
    const k = r.k;
    for (const s of I.hd?.back || []) if (s[0] === 'ring') { ctx.save(); ctx.beginPath(); ctx.arc(r.x + s[1] * k, r.y + s[2] * k, s[4] * k, 0, Math.PI * 2); ctx.arc(r.x + s[1] * k, r.y + s[2] * k, s[3] * k, 0, Math.PI * 2, true); let fill = s[5] || '#0b0b0d'; if (Array.isArray(fill)) { const g = ctx.createRadialGradient(r.x + s[1] * k, r.y + s[2] * k, s[3] * k, r.x + s[1] * k, r.y + s[2] * k, s[4] * k); for (const [rr, col] of fill) g.addColorStop(Math.max(0, Math.min(1, (rr - s[3]) / (s[4] - s[3]))), col); fill = g; } ctx.fillStyle = fill; ctx.fill(); ctx.restore(); }
  }
  _shape(ctx, I, r) { // clip the drawing to the clip's shape (heads.json "shape": circles / rects in clip pixels); returns true if a save() was made
    const sh = I.hd?.shape; if (!sh) return false; const k = r.k; ctx.save(); ctx.beginPath();
    for (const s of sh) { if (s[0] === 'circle') { ctx.moveTo(r.x + (s[1] + s[3]) * k, r.y + s[2] * k); ctx.arc(r.x + s[1] * k, r.y + s[2] * k, s[3] * k, 0, Math.PI * 2); } else ctx.rect(r.x + s[1] * k, r.y + s[2] * k, s[3] * k, s[4] * k); }
    ctx.clip(); return true;
  }
  // heads.json "mask": soft edges for a clip whose splash runs into its own frame (the frame must never show as a straight line)
  //   { round: [cx, cy, r0, r1] }  full inside r0, nothing beyond r1 (cx, cy, radii = fractions of the clip WIDTH / HEIGHT / WIDTH)
  //   { v: [a0, a1, b0, b1] }      fades in from the top over a0..a1 and out to the bottom over b0..b1 (fractions of the height)
  //   { h: [a0, a1, b0, b1] }      the same from left to right (can be combined with v)
  // A clip that goes full screen when it plays alone (placeAlone) is not masked then: its frame is outside the picture anyway.
  _masked(I, r) {
    const m = I.hd?.mask; if (!m || (I.alone && I.hd.placeAlone)) return I.v;
    // never bigger than the video itself: the final drawImage stretches it, and the mask is defined in fractions
    const w = Math.max(2, Math.min(Math.round(r.w), I.v.videoWidth)), h = Math.max(2, Math.min(Math.round(r.h), I.v.videoHeight)), key = I.id + ':' + w + 'x' + h;
    let mk = this.masks[key];
    if (!mk) {
      for (const k of Object.keys(this.masks)) if (k.startsWith(I.id + ':')) delete this.masks[k]; // one size per clip is kept
      mk = this.masks[key] = canvas(w, h); const x = mk.getContext('2d');
      const lin = ([a0, a1, b0, b1], x1, y1) => { const g = x.createLinearGradient(0, 0, x1, y1), T = 'rgba(0,0,0,0)', B = '#000'; g.addColorStop(0, a1 > 0 ? T : B); g.addColorStop(clamp(a0), a1 > a0 ? T : B); g.addColorStop(clamp(a1), B); g.addColorStop(clamp(b0), B); g.addColorStop(clamp(b1), b1 > b0 ? T : B); return g; };
      x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.globalCompositeOperation = 'destination-in';
      if (m.round) { const [cx, cy, r0, r1] = m.round, g = x.createRadialGradient(cx * w, cy * h, r0 * w, cx * w, cy * h, r1 * w); g.addColorStop(0, '#000'); g.addColorStop(0.6, 'rgba(0,0,0,0.7)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); }
      if (m.v) { x.fillStyle = lin(m.v, 0, h); x.fillRect(0, 0, w, h); }
      if (m.h) { x.fillStyle = lin(m.h, w, 0); x.fillRect(0, 0, w, h); }
      x.globalCompositeOperation = 'source-over';
    }
    const c = I.mc ||= canvas(w, h); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const x = c.getContext('2d'); x.globalCompositeOperation = 'copy'; x.drawImage(I.v, 0, 0, w, h); x.globalCompositeOperation = 'destination-in'; x.drawImage(mk, 0, 0); x.globalCompositeOperation = 'source-over';
    return c;
  }
  // the track at time t.  mode "frame": t is the media time of the frame on screen -> exactly that frame;
  // "step": t is currentTime -> the frame being displayed, no gliding;  otherwise glide between frames (centred on (i + 0.5) / fps).
  // vis (and f, the frame number for the "front" layers) always belong to the frame that is on screen.
  _sample(tr, t, mode = null) {
    const n = tr.x.length, fi = clamp(mode === 'frame' ? Math.round(t * tr.fps) : Math.floor(t * tr.fps + 0.02), 0, n - 1);
    const u = mode ? fi : clamp(t * tr.fps - 0.5, 0, n - 1), i = Math.floor(u), j = Math.min(n - 1, i + 1), a = u - i, L = k => tr[k][i] + (tr[k][j] - tr[k][i]) * a;
    return { x: L('x'), y: L('y'), h: L('h'), roll: tr.roll ? L('roll') : 0, vis: tr.vis ? tr.vis[fi] : 1, chin: tr.chin ? L('chin') : 0.62, f: fi };
  }
  _head(ctx, head, x, y, h, roll = 0, alpha = 1, sticker = false) { // draw the cut-out head: cheek midpoint at x,y; face height h. sticker = with the white cut-out edge (a head floating on its own)
    const k = h / head.fh; ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); if (roll) ctx.rotate(roll); ctx.scale(k, k); ctx.drawImage(sticker && head.sticker ? head.sticker() : head.canvas, -head.ax, -head.ay); ctx.restore();
  }
  // seconds until the clip ends (a clip still waiting for its "lead" counts as full length)
  _left(I) { return (I.v.duration || I.hd?.dur || 99) - I.v.currentTime; }
  // heads.json "texts": [{ str, from, to, x, y, size }] — a big caption drawn by us (x, y = fractions of the stage, size = of its width)
  _text(ctx, S, T, t) {
    const k = clamp((t - T.from) / 0.28), out = clamp((T.to - t) / 0.35); if (k <= 0 || out <= 0) return;
    // the caption is painted ONCE at its full size (its glow is a wide blur: painting it every frame costs half the
    // frame rate) and then only scaled and faded
    const size = Math.max(8, Math.round(S.w * (T.size || 0.3) / 8) * 8), key = T.str + '|' + size; let c = (this.txt ||= {})[key];
    if (!c) {
      const font = `900 ${size}px Impact, "Arial Black", system-ui, sans-serif`, pad = Math.ceil(size * 0.4), m = canvas(8, 8).getContext('2d'); m.font = font;
      c = canvas(Math.ceil(m.measureText(T.str).width) + pad * 2, Math.ceil(size * 1.25) + pad * 2); const x = c.getContext('2d'), cx = c.width / 2, cy = c.height / 2;
      x.direction = 'ltr'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round'; x.font = font;
      x.shadowColor = 'rgba(255,160,30,0.95)'; x.shadowBlur = size * 0.22; x.lineWidth = size * 0.12; x.strokeStyle = '#2a1200'; x.strokeText(T.str, cx, cy);
      x.shadowBlur = 0; const g = x.createLinearGradient(0, cy - size / 2, 0, cy + size / 2); g.addColorStop(0, '#fff6c2'); g.addColorStop(0.45, '#ffcf33'); g.addColorStop(1, '#ff7a00'); x.fillStyle = g; x.fillText(T.str, cx, cy);
      const keys = Object.keys(this.txt); if (keys.length > 16) delete this.txt[keys[0]];
      this.txt[key] = c;
    }
    const sc = (0.4 + 0.6 * backOut(k)) * (S.w * (T.size || 0.3) / size), w = c.width * sc, h = c.height * sc;
    ctx.save(); ctx.globalAlpha *= out; ctx.drawImage(c, S.x + S.w * (T.x ?? 0.5) - w / 2, S.y + S.h * (T.y ?? 0.2) - h / 2, w, h); ctx.restore();
  }
  // one emoji as a small picture (drawn once, then only stamped: a colour glyph through fillText every frame is slow)
  _emoji(ch, px) {
    const s = Math.max(16, Math.round(px / 8) * 8), key = ch + s; let c = (this.emo ||= {})[key];
    if (!c) { c = this.emo[key] = canvas(Math.ceil(s * 1.4), Math.ceil(s * 1.4)); const x = c.getContext('2d'); x.font = s + 'px ' + EMOJI; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, c.width / 2, c.height / 2 + s * 0.04); }
    return c;
  }

  // draw(): everything that is playing. Call once per frame, over the picture.
  draw(ctx, W, H, now = performance.now()) {
    if (!this.live.length) { this.spr = null; return; }
    const S = this._stage(W, H), head = this.target(now);
    // hit times -> the page shakes its picture; the head jolts
    for (const I of this.live) {
      const t = I.v.currentTime, hits = I.c.meta?.hits || [], imp = I.hd?.impacts || [];
      // heads.json "hits": [[time, dx, dy, strength]] = the moments something lands ON THE HEAD and which way it is pushed
      // (strength 0.5 soft · 1 · 2 big). Without them (or without a head): the clip's sound peaks from meta.json, alternating sides.
      // alone = the clip plays without a head, so the hit is on OUR screen (the page may crack its glass).
      const own = !I.alone && I.hd?.hits;
      if (own) own.forEach(([ht, dx, dy, s = 1], i) => { if (!I.fired.has('h' + i) && t >= ht) { I.fired.add('h' + i); (I.hd.layer === 'fan' ? (I.jolts ||= []) : this.jolts).push({ at: now, dx, dy, s }); this.onHit({ id: I.id, i, big: s >= 2, soft: s < 1, splat: false, alone: false, muted: I.v.muted }); } });
      else hits.forEach((ht, i) => { if (!I.fired.has('h' + i) && t >= ht) { I.fired.add('h' + i); const big = i === hits.length - 1 || i % 3 === 2; this.jolts.push({ at: now, dx: i % 2 ? -1 : 1, dy: -0.25, s: big ? 2 : 1 }); this.onHit({ id: I.id, i, big, soft: false, splat: false, alone: I.alone || !I.hd, muted: I.v.muted }); } });
      imp.forEach((it, i) => { if (!I.fired.has('i' + i) && t >= it) { I.fired.add('i' + i); this.jolts.push({ at: now, dx: 0, dy: 0.5, s: 1 }); this.onHit({ id: I.id, i, big: false, soft: true, splat: true, alone: false, muted: I.v.muted }); } });
      for (const [i, s] of (I.hd?.sounds || []).entries()) if (!I.sounded.has(i) && t >= s.t) { I.sounded.add(i); if (!I.v.muted || this.sound) this._sound(s); }
      // a clip whose video stopped advancing (file missing, connection lost) is let go after 4 s
      if (I.seen !== t) { I.seen = t; I.seenAt = Math.max(now, I.seenAt); }
    }
    this.jolts = this.jolts.filter(j => now - j.at < 600);

    // ---- "under" clips: ONE head, every thrown thing lands on it ----
    // Clips that started without a head stay as they are (their layout was chosen for the whole clip).
    // The head's place is the one its LONGEST thrown clip gives it (the gnome's, not a passing tomato's), and every thrown
    // clip lines its own anchor up with the head. When that clip changes — a longer one joins, or it ends while another
    // is still flying — the head glides to its new place in 0.35 s: nothing ever jumps.
    const under = this.live.filter(I => I.hd?.layer === 'under' && !I.alone && this._dims(I)[0]);
    let spr = null;
    if (!under.length) this.spr = null;
    else {
      const len = I => I.v.duration || I.hd.dur || 0, A = under.reduce((a, b) => len(b) > len(a) ? b : a), r = this._rect(A, S), a = A.hd.head;
      const to = { nx: (r.x + a.x * r.k - S.x) / S.w, ny: (r.y + a.y * r.k - S.y) / S.w, nh: a.h * r.k * (A.hd.scale || 1) / S.w };
      const at = () => { const s = this.spr, t = s.from ? clamp((now - s.g0) / 350) : 1, e = t * t * (3 - 2 * t), m = k => s.from ? s.from[k] + (s.to[k] - s.from[k]) * e : s.to[k]; return { nx: m('nx'), ny: m('ny'), nh: m('nh') }; };
      if (!this.spr) this.spr = { own: A, t0: now, to, from: null, g0: 0 };
      else if (this.spr.own !== A) this.spr = { ...this.spr, own: A, from: at(), to, g0: now };
      this.spr.roll = a.roll || 0; this.spr.fade = A.hd.fade || 0.28;
      const P = at(); spr = { x: S.x + P.nx * S.w, y: S.y + P.ny * S.w, h: P.nh * S.w };
    }
    if (spr && head) {
      // "show": [from, to] = the seconds of a clip during which the head belongs on screen; it is hidden only when
      // every thrown clip is outside its window. It pops in with the first clip and shrinks away while the last one ends.
      const gone = Math.max(...under.map(I => { const sh = I.hd.show, t = I.v.currentTime; return sh ? clamp((sh[1] - t) / 0.25) * (t >= sh[0] ? 1 : 0) : 1; }));
      const left = Math.max(...under.map(I => this._left(I))), out = clamp(left / Math.max(0.2, this.spr.fade)) * gone, sc = backOut((now - this.spr.t0) / 320) * (0.6 + 0.4 * out);
      let ox = 0, oy = 0, rot = 0;
      for (const j of this.jolts) { const t = now - j.at, e = Math.exp(-t / 110), amp = 0.075 * Math.pow(j.s, 0.6) * spr.h; ox += j.dx * amp * e * Math.cos(t / 45); oy += j.dy * amp * e * Math.cos(t / 45); rot += j.dx * 0.1 * Math.pow(j.s, 0.6) * e * Math.cos(t / 60); }
      if (sc > 0.02 && out > 0.01) this._head(ctx, head, spr.x + ox, spr.y + oy, spr.h * sc, this.spr.roll + rot, out, true);
    }
    for (const I of this.live) {
      const v = I.v; if (!v.videoWidth) continue;
      if (I.hd?.layer === 'fan') { this._fan(ctx, I, S, now); continue; }
      if (I.hd?.layer === 'over') { this._over(ctx, I, S, head, now); continue; }
      if (v.paused && !v.currentTime) continue; // still waiting for its lead
      let r = this._rect(I, S);
      if (spr && under.includes(I)) { // every thrown clip lines its own anchor up with the head (for the clip that gives the head its place this is its own normal place)
        const a = I.hd.head, k = spr.h / ((I.hd.scale || 1) * a.h), [vw, vh] = this._dims(I); r = { x: spr.x - a.x * k, y: spr.y - a.y * k, w: vw * k, h: vh * k, k };
      }
      const fade = I.hd?.fade ? clamp(this._left(I) / I.hd.fade) : 1;
      this._back(ctx, I, r); const sv = this._shape(ctx, I, r);
      ctx.save(); if (fade < 1) ctx.globalAlpha *= fade;
      if (I.hd?.blend) ctx.globalCompositeOperation = I.hd.blend; // "lighter": a clip on black (fire, lightning) is added to the picture, no keying needed
      ctx.drawImage(this._masked(I, r), r.x + I.jitter * r.w, r.y, r.w, r.h);
      ctx.restore();
      if (sv) ctx.restore();
    }
    for (const I of this.live) if (I.hd?.layer !== 'fan') for (const T of I.hd?.texts || []) this._text(ctx, S, T, I.v.currentTime);
    for (const I of [...this.live]) { const v = I.v; if (v.ended || (v.duration && v.currentTime >= v.duration - 0.04) || now - I.seenAt > 4000) this._end(I); }
  }

  // ---- "over": the clip's body gets the target's head ----
  // Positions (track, erase, lens, front lines) are in the ORIGINAL clip's pixels (heads.json vw x vh); the video actually
  // playing may be a lighter copy. "step": the track is read per displayed video frame, with no gliding between frames
  // (a body that swings fast would otherwise leave the head behind).
  _over(ctx, I, S, head, now) {
    const v = I.v, hd = I.hd, r = this._rect(I, S), k = r.k, [cw] = this._dims(I);
    const p = hd.track ? this._sample(hd.track, I.mt ?? v.currentTime, I.mt != null ? 'frame' : hd.step ? 'step' : null) : { ...hd.head, vis: 1, chin: 0.62, f: Math.floor(v.currentTime * 24) };
    const fade = hd.fade ? clamp(this._left(I) / hd.fade) : 1;
    this._back(ctx, I, r); const sv = this._shape(ctx, I, r);
    if (fade < 1) { ctx.save(); ctx.globalAlpha *= fade; }
    const done = () => { if (fade < 1) ctx.restore(); };
    if (!head || p.vis < 0.5) { ctx.drawImage(v, r.x, r.y, r.w, r.h); if (sv) ctx.restore(); done(); return; }
    const fronts = (hd.front || []).filter(fr => p.f >= fr.from && p.f <= fr.to), lens = hd.lens, er = hd.erase;
    // 1) the clip frame, without its own head when it has one (what is in front of that head — reticle, cracked glass, text — is put back)
    if (er) {
      const vw = v.videoWidth, vh = v.videoHeight, q = vw / cw; // q: clip pixels -> pixels of the playing video
      const wk = this.work ||= canvas(vw, vh); if (wk.width !== vw || wk.height !== vh) { wk.width = vw; wk.height = vh; }
      const wx = wk.getContext('2d'); wx.setTransform(1, 0, 0, 1, 0, 0); wx.globalCompositeOperation = 'copy'; wx.drawImage(v, 0, 0, vw, vh);
      const top = p.y - er.top * p.h, bot = p.y + (p.chin + er.bottom) * p.h, cy = (top + bot) / 2, ry = (bot - top) / 2, rx = er.rx * p.h;
      const ell = soft => { wx.save(); wx.scale(q, q); if (lens) { wx.beginPath(); wx.arc(lens[0], lens[1], lens[2], 0, 7); wx.clip(); } wx.translate(p.x, cy); wx.rotate(p.roll || 0); wx.scale(rx, ry);
        if (soft) { const g = wx.createRadialGradient(0, 0, 0.86, 0, 0, 1); g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)'); wx.fillStyle = g; wx.fillRect(-1, -1, 2, 2); }
        else { wx.beginPath(); wx.arc(0, 0, 0.9, 0, 7); wx.clip(); wx.setTransform(1, 0, 0, 1, 0, 0); for (const fr of fronts) { const im = fr.img && this.imgs[fr.img]; if (im?.naturalWidth) wx.drawImage(im, 0, 0, vw, vh); } }
        wx.restore(); };
      wx.globalCompositeOperation = 'destination-out'; ell(true);
      wx.globalCompositeOperation = 'source-over'; ell(false);
      ctx.drawImage(wk, r.x, r.y, r.w, r.h);
    } else ctx.drawImage(v, r.x, r.y, r.w, r.h);
    if (sv) ctx.restore();
    // 2) the target's head, at output sharpness
    const hx0 = p.x * k, hy0 = (p.y + (hd.dy || 0) * p.h) * k, hh0 = p.h * k * (hd.scale || 1);
    if (!fronts.length && !lens) { this._head(ctx, head, r.x + hx0, r.y + hy0, hh0, p.roll || 0); done(); return; } // nothing in front of it: straight onto the picture
    // … with the front things painted onto it, and seen only through the lens
    const hw = Math.ceil(r.w), hh = Math.ceil(r.h), hl = this.headL ||= canvas(hw, hh); if (hl.width !== hw || hl.height !== hh) { hl.width = hw; hl.height = hh; }
    const hx = hl.getContext('2d'); hx.setTransform(1, 0, 0, 1, 0, 0); hx.globalCompositeOperation = 'source-over'; hx.clearRect(0, 0, hw, hh);
    this._head(hx, head, hx0, hy0, hh0, p.roll || 0);
    hx.globalCompositeOperation = 'source-atop';
    for (const fr of fronts) {
      const im = fr.img && this.imgs[fr.img]; if (im?.naturalWidth) hx.drawImage(im, 0, 0, hw, hh);
      for (const [x0, y0, x1, y1, lw, al] of fr.lines || []) { hx.globalAlpha = al ?? 1; hx.strokeStyle = fr.color || '#000'; hx.lineWidth = lw * k; hx.beginPath(); hx.moveTo(x0 * k, y0 * k); hx.lineTo(x1 * k, y1 * k); hx.stroke(); hx.globalAlpha = 1; }
    }
    if (lens) { hx.globalCompositeOperation = 'destination-in'; hx.beginPath(); hx.arc(lens[0] * k, lens[1] * k, lens[2] * k, 0, 7); hx.fill(); }
    ctx.drawImage(hl, r.x, r.y); done();
  }

  // ---- "fan": a supporter's effect — whoever gave is IN it: the profile picture is a cut-out head inside the clip ----
  // heads.json "fan": { x, y = the head's place (fractions of the clip), h0 / h1 = face height before / after the "pop"
  // (fractions of the clip width), in / pop = seconds, crown, rain: [emoji…] }. "texts" are in fractions of the clip and
  // may hold {mult} / {name}. The clip itself is on black and is added to the picture ("blend").
  _fan(ctx, I, S, now) {
    const v = I.v, hd = I.hd, F = hd.fan || {}; if (!v.videoWidth || (v.paused && !v.currentTime)) return;
    const r = this._rect(I, S), t = v.currentTime, dur = v.duration || hd.dur || 5, end = clamp((dur - t) / (hd.fade || 0.5));
    const pop = F.pop ?? 1.75, pk = clamp((t - pop) / 0.25), grow = pk > 0 ? backOut(pk) : 0, inK = backOut((t - (F.in ?? 0.15)) / 0.3);
    const cx = r.x + (F.x ?? 0.5) * r.w, cy = r.y + (F.y ?? 0.5) * r.h, h0 = F.h0 ?? 0.09, fh = r.w * (h0 + ((F.h1 ?? 0.2) - h0) * grow);
    ctx.save(); ctx.globalAlpha *= end;
    // rays turning behind the head, from the pop on
    if (pk > 0) {
      const RR = r.w * 0.8, n = 14, g = ctx.createRadialGradient(cx, cy, fh * 0.5, cx, cy, RR); g.addColorStop(0, 'rgba(255,220,110,0.5)'); g.addColorStop(1, 'rgba(255,170,40,0)');
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha *= 0.55 * pk; ctx.fillStyle = g; ctx.beginPath();
      for (let i = 0; i < n; i++) { const a = now / 2600 + i / n * Math.PI * 2; ctx.moveTo(cx, cy); ctx.arc(cx, cy, RR, a - 0.08, a + 0.08); ctx.closePath(); }
      ctx.fill(); ctx.restore();
    }
    // the clip (on black) is added to the picture
    const m = this._masked(I, r), blend = hd.blend || 'lighter';
    ctx.save(); ctx.globalCompositeOperation = blend; ctx.globalAlpha *= F.gain ?? 0.8; ctx.drawImage(m, r.x, r.y, r.w, r.h); ctx.restore(); // (a little under full strength: at its peak the fire would otherwise white the whole picture out)
    // the head: shakes with the lightning, jumps out at the pop, floats afterwards
    let ox = 0, oy = 0, rot = 0;
    I.jolts = (I.jolts || []).filter(j => now - j.at < 600);
    for (const j of I.jolts) { const q = now - j.at, e = Math.exp(-q / 110), amp = 0.09 * Math.pow(j.s, 0.6) * fh; ox += j.dx * amp * e * Math.cos(q / 45); oy += j.dy * amp * e * Math.cos(q / 45); rot += j.dx * 0.12 * e * Math.cos(q / 60); }
    if (pk >= 1) { oy += Math.sin(now / 420) * fh * 0.035; rot += Math.sin(now / 610) * 0.035; }
    if (inK > 0.02) {
      if (I.fan) this._head(ctx, I.fan, cx + ox, cy + oy, fh * inK, rot, 1, true); else this._initial(ctx, I.who?.name, cx + ox, cy + oy, fh * inK);
      if (F.crown && pk > 0) { const e = this._emoji('👑', r.w * (F.h1 ?? 0.2) * 1.1), s = fh * 1.1 * backOut(pk) * 1.4; ctx.save(); ctx.translate(cx + ox, cy + oy - fh * 1.0); ctx.rotate(rot - 0.1); ctx.drawImage(e, -s / 2, -s / 2, s, s); ctx.restore(); }
    }
    // a little of the clip again, over the head: its sparks and glow pass in front of him
    ctx.save(); ctx.globalCompositeOperation = blend; ctx.globalAlpha *= 0.22; ctx.drawImage(m, r.x, r.y, r.w, r.h); ctx.restore();
    // what is written ("×3", "MVP" …)
    for (const T of I.texts || []) this._text(ctx, r, T, t);
    // … and who it is, under the head
    const name = I.who?.name ? String(I.who.name).replace(/^@/, '') : '';
    if (name && inK > 0.5) {
      const fs = Math.max(12, r.w * 0.058), y = cy + fh * 0.98 + fs, label = /^[\w.]+$/.test(name) ? '@' + name : name; // a TikTok user name gets its @, a display name (Hebrew, spaces) is written as it is
      ctx.save(); ctx.direction = 'ltr'; ctx.font = '800 ' + Math.round(fs) + 'px system-ui, "Segoe UI", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = Math.min(r.w * 0.8, ctx.measureText(label).width), pw = tw + fs * 1.4, ph = fs * 1.7;
      ctx.beginPath(); ctx.roundRect(cx - pw / 2, y - ph / 2, pw, ph, ph / 2); ctx.fillStyle = 'rgba(15,10,0,0.72)'; ctx.fill(); ctx.lineWidth = Math.max(1.5, fs * 0.09); ctx.strokeStyle = '#ffcf33'; ctx.stroke();
      ctx.fillStyle = '#fff6c2'; ctx.fillText(label, cx, y + fs * 0.04, r.w * 0.8); ctx.restore();
    }
    // things raining down after the pop (the same "random" places every time a piece is drawn)
    if (F.rain?.length && pk > 0) {
      const el = t - pop, fs = r.w * 0.075, pics = F.rain.map(ch => this._emoji(ch, fs)), ps = fs * 1.4; ctx.save();
      for (let i = 0; i < 26; i++) {
        const a = Math.sin(i * 12.9898) * 43758.5453, u = a - Math.floor(a), b = Math.sin(i * 78.233) * 12543.123, w = b - Math.floor(b), q = el - u * 1.1; if (q < 0) continue;
        const y = S.y - fs + (0.55 + 0.6 * u) * S.h * q / 1.6; if (y > S.y + S.h + fs) continue;
        ctx.save(); ctx.translate(r.x + r.w * (0.06 + 0.88 * w) + Math.sin(q * 3 + i) * fs * 0.4, y); ctx.rotate(q * (w - 0.5) * 5); ctx.drawImage(pics[i % pics.length], -ps / 2, -ps / 2, ps, ps); ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  }
  // no picture of the supporter: a gold badge with the first letter of the name
  _initial(ctx, name, x, y, h) {
    const RR = h * 0.8, ch = (String(name || '').replace(/^@/, '').trim()[0] || '★').toUpperCase();
    ctx.save(); const g = ctx.createRadialGradient(x - RR * 0.3, y - RR * 0.3, RR * 0.1, x, y, RR); g.addColorStop(0, '#fff3b0'); g.addColorStop(1, '#f0a000');
    ctx.beginPath(); ctx.arc(x, y, RR, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = RR * 0.09; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#3a2000'; ctx.font = '900 ' + Math.round(RR * 1.15) + 'px system-ui, "Segoe UI", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ch, x, y + RR * 0.06); ctx.restore();
  }
  // a profile picture must come from this server (a picture from another site cannot be read by the page): pictures
  // from elsewhere are fetched through /api/avatar, which only passes TikTok's own picture servers
  _avatarUrl(a) {
    if (!a) return null;
    try { const u = new URL(a, location.href); return u.origin === location.origin || u.protocol === 'data:' || u.protocol === 'blob:' ? u.href : '/api/avatar?u=' + encodeURIComponent(u.href); } catch { return null; }
  }

  // ---- synthesized sounds for clips that have no sound of their own ----
  _sound(s) {
    try {
      if (s.file) { const a = new Audio(s.file); a.volume = s.volume ?? 1; a.play().catch(() => {}); return; }
      const ac = this.ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime, out = ac.createGain(); out.gain.value = s.volume ?? 0.9; out.connect(ac.destination);
      if (s.type === 'shot') { // a rifle crack: a very short bright noise burst + a low thump, then glass falling
        const n = ac.createBufferSource(), b = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.5), ac.sampleRate), d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 7);
        const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500; n.buffer = b; n.connect(hp).connect(out); n.start(t);
        const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25); g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3); o.connect(g).connect(out); o.start(t); o.stop(t + 0.32);
        for (let i = 0; i < 14; i++) { const tt = t + 0.12 + Math.random() * 0.7, og = ac.createGain(), oo = ac.createOscillator(); oo.type = 'triangle'; oo.frequency.value = 2200 + Math.random() * 5200; og.gain.setValueAtTime(0.0001, tt); og.gain.exponentialRampToValueAtTime(0.16, tt + 0.004); og.gain.exponentialRampToValueAtTime(0.0001, tt + 0.07 + Math.random() * 0.1); oo.connect(og).connect(out); oo.start(tt); oo.stop(tt + 0.2); }
      } else if (s.type === 'boom') { // a deep thump with a rumble (multiplier bursts)
        const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.8); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3); o.connect(g).connect(out); o.start(t); o.stop(t + 1.4);
        const n = ac.createBufferSource(), b = ac.createBuffer(1, Math.floor(ac.sampleRate * 1.4), ac.sampleRate), d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.4);
        const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; const ng = ac.createGain(); ng.gain.value = 0.7; n.buffer = b; n.connect(lp).connect(ng).connect(out); n.start(t);
      }
    } catch {}
  }
}
