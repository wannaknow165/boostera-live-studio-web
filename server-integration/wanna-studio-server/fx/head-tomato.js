// HEAD-TOMATO — a tomato shaped like a head: the face IS the tomato.
// It flies at the screen spinning, smashes, and the face smears and drips down with the tomato juice.
// Shared by the live panel engine (fx-engine.js) and the clean foreground layer (/clean/foreground),
// so both draw exactly the same thing.
//   const T = newHeadTomato(faceCanvas)            // faceCanvas: square canvas/image with the face (circle-cut)
//   state = drawHeadTomato(ctx, W, H, T, now)      // 'fly' | 'hit' (once, the frame it lands) | 'smear' | 'done'
export const FLY = 0.5, END = 3.5; // seconds: flight time, total life
const BURST = new URL('assets/tomato-burst.webm', import.meta.url).href; // juice explosion clip (starts at the splat)
const ease = k => 1 - (1 - k) * (1 - k);
let scratch = null, sctx = null, bcan = null, bctx = null, bmask = null;
// The juice clip is a square video: drawn as it is, the splash is cut along straight lines at the square's edges.
// So it is drawn through a round soft mask (full in the middle, fading to nothing before the edges).
function softBurst(b) {
  const w = b.videoWidth, h = b.videoHeight;
  if (!bcan || bcan.width !== w || bcan.height !== h) {
    bcan = document.createElement('canvas'); bcan.width = w; bcan.height = h; bctx = bcan.getContext('2d');
    bmask = bctx.createRadialGradient(w * 0.5, h * 0.47, w * 0.31, w * 0.5, h * 0.47, w * 0.47);
    bmask.addColorStop(0, 'rgba(0,0,0,1)'); bmask.addColorStop(0.55, 'rgba(0,0,0,0.75)'); bmask.addColorStop(1, 'rgba(0,0,0,0)');
  }
  bctx.globalCompositeOperation = 'copy'; bctx.drawImage(b, 0, 0, w, h);
  bctx.globalCompositeOperation = 'destination-in'; bctx.fillStyle = bmask; bctx.fillRect(0, 0, w, h);
  return bcan;
}

export function newHeadTomato(face) {
  // the juice clip is loaded now (while the tomato flies) so it starts the instant it lands
  const burst = document.createElement('video');
  burst.src = BURST; burst.muted = true; burst.playsInline = true; burst.preload = 'auto'; burst.load();
  return { t0: performance.now(), seed: 1 + Math.floor(Math.random() * 233279), x: 0.5 + (Math.random() - 0.5) * 0.24, y: 0.42 + (Math.random() - 0.5) * 0.14, face, burst, hit: false };
}

export function drawHeadTomato(ctx, W, H, T, now) {
  const t = (now - T.t0) / 1000;
  if (t >= END) { try { T.burst.pause(); T.burst.removeAttribute('src'); T.burst.load(); } catch {} return 'done'; }
  const f = T.face, cx = T.x * W, cy = T.y * H, R = W * 0.3;
  let s = T.seed; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280; // same "random" values every frame

  // ---- 1) flying in from the bottom corner: growing, spinning, a red glossy ball with the face on it ----
  if (t < FLY) {
    const k = t / FLY, e = k * k, r = R * (0.2 + 0.8 * e), rot = (1 - e) * 4.2;
    const x = cx + (1 - e) * W * 0.5, y = cy + (1 - e) * H * 0.34 - Math.sin(Math.PI * k) * H * 0.1;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.94, 0, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(f, -r, -r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgba(235,45,35,0.6)'; ctx.fillRect(-r, -r, r * 2, r * 2); // tomato red
    ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.42, r * 0.04, -r * 0.15, -r * 0.2, r * 1.15);               // gloss + dark rim
    g.addColorStop(0, 'rgba(255,255,255,0.6)'); g.addColorStop(0.3, 'rgba(255,255,255,0)'); g.addColorStop(0.75, 'rgba(120,0,0,0.12)'); g.addColorStop(1, 'rgba(80,0,0,0.6)');
    ctx.fillStyle = g; ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
    // the green stem on top
    ctx.translate(0, -r * 0.9);
    ctx.fillStyle = '#2f8f2f'; ctx.strokeStyle = '#1c5c1c'; ctx.lineWidth = Math.max(1, r * 0.012);
    for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i - 2) * 0.62; ctx.beginPath(); ctx.ellipse(Math.cos(a) * r * 0.17, Math.sin(a) * r * 0.17 + r * 0.06, r * 0.19, r * 0.055, a, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = '#3d6b23'; ctx.fillRect(-r * 0.03, -r * 0.13, r * 0.06, r * 0.16);
    ctx.restore();
    return 'fly';
  }

  // ---- 2) smashed on the screen ----
  let state = 'smear';
  if (!T.hit) { T.hit = true; try { T.burst.currentTime = 0; } catch {} T.burst.play().catch(() => {}); state = 'hit'; }
  const dt = t - FLY, k = dt / (END - FLY), d = ease(k), fade = k < 0.62 ? 1 : Math.max(0, 1 - (k - 0.62) / 0.38);
  // the real juice explosion (video) under the face
  const b = T.burst;
  if (b.videoWidth) { const bw = W * 1.12, bh = bw * b.videoHeight / b.videoWidth; ctx.save(); ctx.globalAlpha = fade; ctx.drawImage(softBurst(b), cx - bw * 0.5, cy - bh * 0.43, bw, bh); ctx.restore(); }
  // the face: squashed flat on impact, then cut into strips that stretch and run down like thick juice
  if (!scratch || scratch.width !== W || scratch.height !== H) { scratch = document.createElement('canvas'); scratch.width = W; scratch.height = H; sctx = scratch.getContext('2d'); }
  const c = sctx; c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.clearRect(0, 0, W, H);
  const sq = Math.max(0, 1 - dt / 0.16), RX = R * (1.08 + 0.3 * sq), RY = R * (1 - 0.24 * sq), N = 96, sw = RX * 2 / N;
  // how far each strip runs changes SMOOTHLY from strip to strip (a few waves), so it reads as liquid running down
  // in tongues, not as separate bars; the middle of the face runs more than its edges
  const p1 = rnd() * 6.28, p2 = rnd() * 6.28, p3 = rnd() * 6.28;
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N, sp = Math.max(0.15, 0.8 + 0.5 * Math.sin(u * 7 + p1) + 0.3 * Math.sin(u * 15 + p2) + 0.12 * Math.sin(u * 29 + p3));
    const drop = d * H * 0.42 * sp * (0.3 + 0.7 * Math.sin(Math.PI * u)), wob = Math.sin(u * 9 + dt * 2.2) * R * 0.02 * k;
    c.drawImage(f, i / N * f.width, 0, f.width / N, f.height, cx - RX + i * sw + wob, cy - RY + drop * 0.1, sw + 1, RY * 2 + drop);
  }
  c.globalCompositeOperation = 'source-atop'; c.fillStyle = `rgba(205,24,20,${0.32 + 0.26 * k})`; c.fillRect(0, 0, W, H); // gets redder as it runs
  c.globalCompositeOperation = 'source-over';
  // juice drips running down from the smear
  for (let i = 0; i < 9; i++) {
    const x = cx + (rnd() - 0.5) * RX * 1.9, w = R * (0.045 + rnd() * 0.06), len = d * H * (0.18 + rnd() * 0.45), y0 = cy + RY * (0.2 + rnd() * 0.6);
    c.fillStyle = rnd() < 0.5 ? '#b5121b' : '#d3261f';
    // a drip: wide where it starts, a thin neck, a heavy drop at its end
    c.beginPath(); c.moveTo(x - w / 2, y0); c.quadraticCurveTo(x - w * 0.16, y0 + len * 0.45, x - w * 0.24, y0 + len);
    c.arc(x, y0 + len, w * 0.72, Math.PI, 0, true); c.quadraticCurveTo(x + w * 0.16, y0 + len * 0.45, x + w / 2, y0); c.closePath(); c.fill();
    c.beginPath(); c.arc(x, y0, w / 2, 0, Math.PI * 2); c.fill();
  }
  // splatter (and a few seeds) thrown out around the hit
  const out = 1 - Math.exp(-dt * 9);
  for (let i = 0; i < 30; i++) {
    const a = rnd() * Math.PI * 2, dist = R * (0.85 + rnd() * 1.5) * out, rr = R * (0.025 + rnd() * 0.09), slide = k * H * 0.07 * rnd(), seedDot = rnd() < 0.18, dark = rnd() < 0.5;
    c.fillStyle = seedDot ? '#f3d98a' : dark ? '#8f0e14' : '#c4161c';
    c.beginPath(); c.arc(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist * 0.85 + slide, seedDot ? rr * 0.35 : rr, 0, Math.PI * 2); c.fill();
  }
  // the further it runs the softer it gets (a wet smear, no hard seams between the strips)
  ctx.save(); ctx.globalAlpha = fade; ctx.filter = `blur(${(W / 900 * (1.1 + 3 * k)).toFixed(1)}px)`; ctx.drawImage(scratch, 0, 0); ctx.restore();
  return state;
}
