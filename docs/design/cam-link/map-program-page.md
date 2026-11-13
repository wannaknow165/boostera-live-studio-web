# MAP: program-page

# PROGRAM PAGE MAP (for adding `src=live`)

ROOT = `C:\My Web Sites\boostera-live-studio-web\server-integration\wanna-studio-server` (branch `integration/stage-and-ingest`, HEAD b03aa14, clean tree). OLD = `C:\Users\shk\wanna-studio-server`. Line numbers are ROOT unless prefixed OLD. Nothing was modified, started or stopped; no .env/server.env opened; no adb. Browser-behaviour statements marked (expected) were not run-tested.

## 0. State of the two copies (diff, CRLF ignored)
- Identical in ROOT and OLD: `fx/fx-engine.js`, `fx/stage-url.js`, `fx/phone-stream-worker.js`, `server.mjs`.
- OLD `fx/index.html` = ROOT + 26 lines (`useServer()` at OLD:125-149 and its branch at OLD:229). `useServer` is on no branch of the repo (git grep on main / integration / origin/main: 0 hits).
- OLD `mobile-gateway.mjs` has the CORS hunk at OLD:41-42 (quoted in section 7); otherwise it is the older v1.1.0 file.
- Runtime (read-only check): :8800 listens on `::` (`node server.mjs`), :8801 on `127.0.0.1` (`node mobile-gateway.mjs --open`, no `--tunnel`). `OLD\data\db.json` is rewritten every minute, so the RUNNING :8800 is the OLD copy; edits in ROOT are not served until ROOT is the one running.
- `fx/serve.mjs` is a legacy standalone server (port 8795); `server.mjs` does not use it (it uses `lib/fx-routes.mjs`).
- `fx/fx-engine.js` is SHARED with the phone PWA: `public/mobile/app.js:62` `const {FxEngine}=await import('/fx/fx-engine.js');` (gateway allowlist `mobile-gateway.mjs:17`). `fx/index.html` and `fx/stage-url.js` are not in that allowlist, so the program page exists only on :8800.

## 1. URL params and the source branch chain
`fx/index.html` (`const qs = new URLSearchParams(location.search);` line 92):
- `clean` (93) `if (qs.get('clean')) document.body.classList.add('clean');` — any non-empty value, even `0`.
- `streamer` (94) -> `localStorage['fx-streamer']` -> `#streamer` input (153) -> remix lookups and the filter at 287 `if (L.streamer && L.streamer !== streamerName()) return;`.
- `stage` (99, via `stage-url.js:22-25`, only when `clean` is set).
- `src` (203-205): `phone` | `camera` | anything else = a media URL for `useSrc()`.
- `cropTop`, `cropBottom` (119; phone source only; defaults 0.09 / 0.15).
- `debug` (127) `if (qs.get('debug')) fx.debug = true;` — paints a debug overlay INTO the canvas.
- `plate` (129) `setTimeout(() => fx.plateFromUrl(qs.get('plate')), 3000)`.
- `ws` (182) WebSocket trigger source (`{type:'TRIGGER', effect}`).
- `opp`, `oppsrc` (245) `if (qs.get('opp') !== '0') fx.watchOpponent(qs.get('oppsrc') || undefined);`.
- `fanpic` (253).
- In `fx-engine.js`: `cpu` (73), `oppRegion` (816), `oppHost` (817).
- NOT read by the program page: `sound` (only `/clean/foreground` and `/clean/background`), `audio`, `room`.

Chain in ROOT (`fx/index.html:200-207`):
```js
await loadAll(); refreshRemix();
log('טוען MediaPipe…'); await fx.init(); fx.start();
// live sources only: phone (ADB) or the computer camera
if (qs.get('src') === 'phone') usePhone();
else if (qs.get('src') === 'camera') $('#cam').onclick().catch(e => log('מצלמה: ' + e.message)); // the computer camera, as the button does (before: a file named "camera", i.e. nothing)
else if (qs.get('src')) useSrc(qs.get('src'));
log('מוכן');
window.fxReady = true;
```
Today `?src=live` (and `?src=server`) falls into `useSrc('live')` -> `video.src='live'` -> `/fx/live` 404 -> unhandled play() rejection, black picture. The new branch must sit BEFORE the generic `else if (qs.get('src'))`. The sources are started without `await` (non-blocking); keep that so lines 209-294 (SSE subscription, opponent watcher, buttons) still run.

The three existing sources (`fx/index.html:113-124`):
```js
async function useSrc(src) { video.srcObject = null; video.src = src; await video.play(); log('מקור: ' + src); }
$('#cam').onclick = async () => { video.src = ''; video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' } }); await video.play(); log('מצלמה פעילה'); };
// Phone over ADB: MJPEG <img> -> canvas (cropping the app's top/bottom bars) -> captureStream -> the engine's <video>
async function usePhone() {
  const img = new Image(); img.src = '/phone.mjpeg?' + Date.now();
  await new Promise((r, j) => { img.onload = r; img.onerror = j; setTimeout(r, 6000); });
  const top = Number(qs.get('cropTop') ?? 0.09), bottom = Number(qs.get('cropBottom') ?? 0.15);
  const c = document.createElement('canvas'); c.width = 720; c.height = Math.round(1600 * (1 - top - bottom)); const cx = c.getContext('2d');
  const draw = () => { if (img.naturalWidth) cx.drawImage(img, 0, img.naturalHeight * top, img.naturalWidth, img.naturalHeight * (1 - top - bottom), 0, 0, c.width, c.height); requestAnimationFrame(draw); }; draw();
  video.src = ''; video.srcObject = c.captureStream(30); await video.play(); log('טלפון מחובר דרך ADB');
}
$('#phone').onclick = usePhone;
```

OLD chain (OLD `fx/index.html:228-231`):
```js
if (qs.get('src') === 'phone') usePhone();
else if (qs.get('src') === 'server') useServer(); // the phone's PWA stream via the mobile gateway (HLS)
else if (qs.get('src') === 'camera') $('#cam').onclick().catch(e => log('מצלמה: ' + e.message)); // the computer camera, as the button does (before: a file named "camera", i.e. nothing)
else if (qs.get('src')) useSrc(qs.get('src'));
```
Whole `useServer()` to port (OLD `fx/index.html:125-149`, sits right after `$('#phone').onclick = usePhone;`, i.e. after ROOT line 124):
```js
// Phone over the mobile gateway (:8801): the PWA on the phone sends its processed video to the server ("שלח וידאו לשרת"),
// the gateway turns it into HLS, and we play that HLS into the engine's <video> (hls.js, as /mobile/viewer does).
async function useServer() {
  const base = `http://${location.hostname === 'localhost' ? 'localhost' : '127.0.0.1'}:8801`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + '/api/workspace/overview', { cache: 'no-store' }); const d = await r.json();
      const s = (d.broadcasts || []).filter(b => b.mode === 'preview' && b.state === 'running').sort((a, b) => b.startedAt - a.startedAt)[0];
      if (s && s.playback) {
        const url = base + s.playback; const probe = await fetch(url, { cache: 'no-store' });
        if (probe.ok) {
          const { default: Hls } = await import('https://cdn.jsdelivr.net/npm/hls.js@1.6.15/+esm');
          if (window._hls) { window._hls.destroy(); window._hls = null; }
          video.srcObject = null; video.src = ''; video.muted = true;
          const h = window._hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 }); h.loadSource(url); h.attachMedia(video);
          h.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
          log('מקור: הטלפון דרך השרת (' + s.id.slice(0, 6) + ')'); return;
        }
      }
    } catch (e) { /* gateway not up yet or no stream */ }
    if (i % 3 === 0) log('ממתין לשידור מהטלפון… (באפליקציה: "שלח וידאו לשרת")');
    await new Promise(r => setTimeout(r, 3000));
  }
  log('לא התקבל שידור מהטלפון');
}
```
What it consumes on the gateway: `GET /api/workspace/overview` (`lib/mobile-workspace.mjs:81`, returns `broadcasts: broadcasts.list()`); `playback` = `'/api/workspace/broadcast/'+s.id+'/files/live.m3u8'`, only for `mode==='preview'` (`lib/mobile-broadcast.mjs:11`); files `live.m3u8 | init.mp4 | part-NNNNNN.m4s` served with `Cache-Control: no-store` (`lib/mobile-workspace.mjs:140`). Encoder (`lib/mobile-broadcast.mjs:18-19`): libx264 ultrafast zerolatency, `-r 30 -g 60 -b:v 2500k`, aac 128k, fMP4 HLS `-hls_time 2 -hls_list_size 6 -hls_flags delete_segments+independent_segments`.
Weak points of `useServer()` as written: gives up after 100 x 3 s (about 5 min) and never retries; no `Hls.Events.ERROR` handler; never re-polls when the broadcast id changes; takes the newest running preview of ANY device; port 8801 hard-coded (real port is `MOBILE_PORT`); does nothing with audio (`video.muted = true`).

## 2. The `<video>` element and how frames are read
- Declaration (`fx/index.html:45`): `<div id="stage"><canvas id="out"></canvas><div id="heads"></div><video id="src" playsinline muted loop></video>`; CSS line 13 `#src { display: none; }`. Attributes: `playsinline`, `muted`, `loop`; no `autoplay`, no `crossorigin`.
- Wiring (87-88): `const video = $('#src'), out = $('#out');` `const fx = new FxEngine(video, out, { log }); window.fx = fx;`
- Who calls `play()`: only the page's source functions (`useSrc`, `#cam` handler, `usePhone`, OLD `useServer` on `MANIFEST_PARSED`). The engine never calls play() and never touches `src`/`srcObject`; it only reads `this.video.readyState`, `videoWidth/Height` and passes the element to MediaPipe and `drawImage`. Every use is `this.video` looked up per frame (constructor `fx-engine.js:50`).
- No `requestVideoFrameCallback` anywhere and no media-event listeners on the main video (no resize/ended/stalled/waiting/error), no `visibilitychange` handling. The loop is requestAnimationFrame (`fx-engine.js:1061-1064`):
```js
start() {
  const loop = () => { try { this.frame(performance.now()); this.postFX(); } catch (e) { this.log('frame error ' + e.message); } this.raf = requestAnimationFrame(loop); };
  loop();
}
```
  The timestamp given to MediaPipe is `performance.now()`, not media time, so a source swap or HLS restart cannot break the "increasing timestamp" rule. There is no new-frame check: every display refresh reprocesses the current frame.
- Gate and per-frame reads (`fx-engine.js:714-716`):
```js
frame(ts) {
  if (!this.ready || this.video.readyState < 2) return;
  this.setup(); this.track(ts);
```
  Reads: `this.faceLm.detectForVideo(v, ts)` every frame (422); `this.poseLm.detectForVideo(v, ts)` on even frames (457-458); `this.segCtx.drawImage(v, 0, 0, this.segIn.width, this.segIn.height)` then `this.seg.segmentForVideo(this.segIn, ts)` on mask frames (472-473); output `ctx.drawImage(this.video, 0, 0, W, H)` or `personLayer()` (747-748); `updatePlate()` (525).
- Dimension handling — `setup()` runs EVERY frame and re-allocates when the size changes (`fx-engine.js:337-348`):
```js
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
```
  So a mid-stream size change is survived. Every place that caches size or pixel-space state:
  1. `setup()` buffers above: follow the change, but `out` is cleared and `mask`, `plate`, `filled` restart EMPTY.
  2. `maskSmall/maskData/maskA/maskB` (477-480): keyed on mask width AND height; `maskHas=false` (first mask unsmoothed).
  3. `personCanvas` (561) `if (!this.personCanvas || this.personCanvas.width !== W)` — WIDTH only.
  4. `post` (1034) `if (!this.post || this.post.width !== W)` — WIDTH only. A change keeping width but not height leaves a stale-height buffer (cropped shake copy, distorted face-melt source).
  5. Pixel-space state from the old size: `this.face`, `this.pose`, `this.bbox`, `this.ptsSmooth` (300 ms smoothing), and inside a running effect `st.frozen[asset]` (647), `st.lastFace` (228), `st.lastM`/`st.blendFrom` (236-239), which stay wrong until that effect ends. `this.target`, `this.heads`, `this.punches` are normalised.
  6. `plateLocked` survives while the plate canvas is wiped; `filledReady` may stay true over an empty `filled` (matters only without `?stage=`: 725 and 748 skip the plate when transparent).
  7. `usePhone()` canvas sized once and hard-coded: `c.width = 720; c.height = Math.round(1600 * (1 - top - bottom))`.
  8. `record()` (188) `out.captureStream(30)` + MediaRecorder: resolution changes mid-recording.
  9. `picRect()` (216-219) reads `out.width/height` per call. `battle-stage.js:101` `_stage(W, H)` and its head canvas (279) are size-safe.
  10. Presentation: `#out { width: 100%; height: 100%; object-fit: contain; }` (line 12). A non-9:16 stream is letterboxed in the 9:16 stage; her size relative to the wall changes with the stream's aspect.
  Visible effect in transparent mode: the new `mask` is empty until the next mask frame (masks only on odd frames), so at most ONE rendered frame shows the wall without her.
  MediaPipe gets the element (face/pose) or `segIn` (mask) each call and the code handles any returned mask size; a GPU-delegate hiccup on a size change was not run-tested.

## 3. Stall, end, swapping the source
- Stall with frames kept (WebRTC freeze, HLS underrun at readyState 2): the gate passes, the engine keeps compositing the last frame; effects keep animating. Nothing detects it.
- `readyState < 2` (srcObject null/just swapped, hls attached before first data): `frame()` returns before drawing, the canvas keeps the LAST composite; the last cut-out stays frozen over the wall. `postFX()` STILL runs (`if (!this.W) return;` 1002) and draws gnome/battle/tomato/WAKE dim/shake/double banner onto the uncleared canvas, so an effect in flight smears, re-zooms or darkens until frames return.
- Ended: no listener, the engine does nothing. The `loop` attribute: an HLS stream that ends would make the element seek back and replay its last buffered seconds forever (expected; verify).
- Switching MediaStream A -> B on `#src`: engine-safe (no per-stream state; `setup()` re-checks size; timestamps are wall-clock). Element side (expected, HTML load algorithm): changing `srcObject` resets the element to paused, so call `video.play()` after every swap; a play() pending from before rejects with AbortError; for a MediaStream play() stays pending until the first frame, so do not `await` it before other setup.
- srcObject <-> hls.js: `srcObject` wins over `src`, so set `video.srcObject = null` before `attachMedia` (OLD code does) and `hls.destroy()` before assigning a MediaStream. hls.js uses MSE (blob: URL), so the canvas stays untainted; a direct cross-origin `video.src='http://127.0.0.1:8801/...'` would taint it (no `crossorigin` attribute) and break MediaPipe GPU upload, `grabFrame()` and `record()`.
- Gap-free alternative: `fx.video` is a plain property read every frame, so a second hidden `<video>` can be prepared and `fx.video` flipped to it once it has frames. Verified by reading only.
- Zero-size hazard: the gate checks only `readyState`. An element at readyState >= 2 with `videoWidth === 0` (e.g. a stream that so far has only an audio track) makes `setup()` create 0x0 canvases and MediaPipe/drawImage throw every frame, i.e. `log('frame error …')` 60 times a second into an unbounded log string.
- To really empty the picture when the feed is gone: `video.srcObject = null` and then clear `fx.ctx` yourself; nothing in the engine does it.
- HLS fallback is seconds behind (2 s segments, `liveSyncDurationCount: 2`), so a WebRTC -> HLS switch replays recent seconds and may arrive at another resolution.

## 4. `log()` and clean mode
- `fx/index.html:86`: `const logEl = $('#log'); const log = m => { logEl.textContent = `${new Date().toLocaleTimeString('he-IL')} ${m}\n` + logEl.textContent; console.log(m); };` — prepends to `#log` (inside `<aside>`) and console.log. Never trimmed.
- Clean CSS (36-37): `body.clean { padding:0; background:#000 } body.clean aside { display:none }` / `body.clean #stage { height:100vh; width:100vw; border-radius:0 } body.clean #toast { display:none !important }`.
- Visible in clean mode: only `#stage` (black) with the optional wall iframe, the canvas and the empty `#heads` layer (boxes only when an operator picked a target, impossible in clean mode). The log, the buttons and the reject toast (`fx.onReject`, line 89) are hidden. No DOM text reaches the broadcast.
- Text painted INTO the canvas: debug overlay (`?debug=1`, `drawDebug` 679-711), WAKE UP "Z" letters (925), the double banner `×N 🥊` (1053-1058), battle/fan captions (`battle-stage.js`). No log or status text.
- Handles for diagnosis: `window.fx`, `window.fxReady`, `window.fxStage`, `window.fxAllLoaded`, `window.recordRun` (OLD also `window._hls`).

## 5. `?stage=` wall and transparent mode
- Validation (`stage-url.js:11-18`): https always; http only on loopback or the page's own host; only with `clean`. `STAGE_TIMEOUT_MS = 15000`.
- Creation (`fx/index.html:100-111`): iframe `className='wall'`, `allow="autoplay; fullscreen"`, `scrolling="no"`, `tabIndex=-1`, `aria-hidden`, then `stageEl.classList.add('staged'); f.src = stageUrl; stageEl.prepend(f);`. Gate:
```js
onOpen: () => { fx.transparent = true; log('קיר מהענן מאחורי המצלמה: ' + stageUrl); },
onClose: why => { f.remove(); stageEl.classList.remove('staged'); fx.transparent = false; log(`הקיר מהענן לא נטען (${why}) — ממשיכים עם המצלמה כרגיל`); },
```
  It opens only when the iframe `load` fired AND `fetch(stageUrl, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(STAGE_TIMEOUT_MS) })` resolved. One shot: on failure/timeout the iframe is removed for good; a wall that dies later, or refuses framing, is not detected.
- CSS (40-41): `#stage iframe.wall { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:min(100%, calc(100vh * 9 / 16)); height:min(100%, calc(100vw * 16 / 9)); border:0; margin:0; padding:0; overflow:hidden; pointer-events:none; background:transparent; display:block }` and `#stage.staged #out { position:relative }`.
- Order bottom to top, no z-index anywhere (DOM order among positioned boxes): body `#000` -> `#stage` (`position: relative; background: #000; overflow: hidden`) -> `iframe.wall` -> `canvas#out` -> `div#heads` (`position:absolute; inset:0; pointer-events:none`) -> `video#src` (display:none) -> `div#toast` (hidden).
- Pointer events: the iframe and `#heads` take none; a click anywhere lands on the top document.
- Canvas alpha: `out.getContext('2d')` (default alpha). In transparent mode each frame (739, 747): `const cut = !!this.transparent; if (cut) ctx.clearRect(0, 0, W, H);` then `if (cut) this.personLayer(ctx, 1); else ctx.drawImage(this.video, 0, 0, W, H);`. `personLayer` (543-546): video into `tmp2`, then `destination-in` with the mask under `blur(2px)`. Mask alpha (483): `d[p] = c > 0.65 ? 255 : c > 0.45 ? (c - 0.45) * 1275 : 0` with `c = prev*0.35 + new*0.65`, then scaled up to WxH (489). Result: opaque person, soft edge, fully transparent elsewhere. Remixes, an effect's room image and foreground effects paint opaque over the wall; the shake path clears first (1035).
- Before the first video frame the canvas is empty, so with an open gate the wall shows alone. Without `stage`, `fx.transparent` stays false and the full opaque frame is drawn.
- Link helper `programUrlWithStage(stage, { src = 'phone', streamer = '' })` (`stage-url.js:42-45`) knows only `src` and `streamer`; an `&` inside the wall URL is written `%26`.

## 6. Segmentation, tracking, mirroring, phone vs camera
- Library: `@mediapipe/tasks-vision@0.10.14` from jsDelivr (`fx-engine.js:4`, wasm at line 12).
- Models (13-15): face `face_landmarker/float16/1/face_landmarker.task`; pose `pose_landmarker_lite/float16/1/pose_landmarker_lite.task`; mask `image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`, created with `runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false` (69).
- Delegate (73-74): `let m, delegate = new URLSearchParams(location.search).get('cpu') ? 'CPU' : 'GPU';` then `try { m = await make(delegate); } catch (e) { this.log(`GPU נכשל (${e.message}) – עובר למעבד`); delegate = 'CPU'; m = await make('CPU'); }`; each attempt has a 20 s timeout (65).
- Input: face and pose get the `<video>` at full size; the mask model gets `segIn` at HALF size (360x640 for 720x1280). Code comment 408: "the model itself works at 256 px".
- Cadence (416-471): face every frame; pose `if (n % 2 === 0 && !remix)`; mask `if ((!remix || cut) && n % 2 === 1 && (busy || cut || n % 6 === 1))` = every 2nd frame while transparent or during an effect, every 6th when idle and opaque. Comment 410: "Each model call blocks ~10 ms waiting for its result, so no frame ever runs more than two of them."
- Per-mask-frame path (472-492): half-size drawImage -> `segmentForVideo` -> `m.getAsFloat32Array()` (GPU readback) -> JS loop over all mask pixels -> sparse bbox scan -> `putImageData` -> upscale into `this.mask`. Then line 732 `if (this.maskFresh) this.updatePlate();` runs even in transparent mode: full-size video draw plus five mask draws under `blur(W/18 px)` (525-530), although the plate is never shown there. Every frame in transparent mode: `clearRect` + `personLayer` (full-size video draw, blurred mask, a full-size copy into `personCanvas`, draw to output).
- Mirroring: none in the program page or engine (the only `scale(-1, 1)` is the glove sprite, 1048; no CSS transform). The phone PWA mirrors the front camera BEFORE sending: `public/mobile/app.js:50` `if(facing==='user'){ctx.translate(output.width,0);ctx.scale(-1,1);}paintCover(source,ctx,output.width,output.height)`; its output canvas is fixed portrait, `app.js:193` `output.width=value==='720'?720:1080;output.height=value==='720'?1280:1920`.
- `src=camera`: PC webcam, 1280x720 requested, video only, landscape, unmirrored, uncropped; letterboxed in the 9:16 stage.
- `src=phone`: server `/phone.mjpeg` = `adb exec-out screenrecord --size 720x1600` through ffmpeg to MJPEG (`lib/fx-routes.mjs:97-98`, `SIZE = process.env.PHONE_SIZE || '720x1600'`); the page crops top 9% and bottom 15% into a fixed 720x1216 canvas and feeds `captureStream(30)`. Portrait, constant size. Neither existing source ever changes size mid-stream; `src=live` will be the first.
- `fx/phone-stream-worker.js`: used only by `fx/opponent.js:135`, not by the main video. Protocol (header 8-10): page -> worker `{ url, id, crop, fps }` or `{ stop: true }`; worker -> page `{ id, bmp, t, n, w, h, oy }` or `{ id, end: true, status, error }`. It fetches the multipart JPEG stream, decodes off the main thread (max 3 at once), optionally crops.
- Opponent watcher (on by default, line 245): loads three more GPU models (`opponent.js:87-91`) and fetches `/fx/phone.jpg?need=tiktok` every 2.5 s (`opponent.js:182-193`); the server runs adb for each request (`lib/fx-routes.mjs:62-79, 170-185`).

## 7. Script type, top-level await, external URLs, CSP
- One inline `<script type="module">` (`fx/index.html:82-295`), no classic script. Top-level await at 200 and 201; `fx-engine.js:9` also uses it: `try { ({ Opponent } = await import('./opponent.js')); ({ BattleStage } = await import('./battle-stage.js')); } catch { Opponent = BattleStage = null; }`. Everything after line 201 waits for the MediaPipe models; if `fx.init()` rejects on GPU and CPU, the source chain never runs.
- External URLs: jsDelivr `vision_bundle.mjs` (STATIC import, so no CDN = dead page) and wasm; `storage.googleapis.com/mediapipe-models/...` (three models, plus `selfie_multiclass_256x256` in `opponent.js:32`); the wall URL and its HEAD probe; OLD only: `https://cdn.jsdelivr.net/npm/hls.js@1.6.15/+esm` (same URL as `public/mobile/viewer.js:4`; hls.js is not in node_modules).
- CSP on :8800: NONE. No response sets Content-Security-Policy, X-Frame-Options, COOP/COEP or Permissions-Policy, and `fx/index.html` has no CSP meta. Nothing on :8800 blocks fetch to `http://127.0.0.1:8801`, the hls.js import, or RTCPeerConnection. The CSP at `mobile-gateway.mjs:71` applies only to `/mobile/*` documents.
- What does block, on the gateway side (ROOT `mobile-gateway.mjs`):
  - No CORS header at all in ROOT, so the :8800 page cannot read any :8801 response. OLD hunk to port (OLD:41-42, between the Permissions-Policy line and `try{`):
```js
// The effects panel on :8800 (same computer) reads the phone's preview stream (overview + HLS files) from here: allow that origin only, GET only.
{const o=req.headers.origin;if(o&&req.method==='GET'&&/^http:\/\/(localhost|127\.0\.0\.1):8800$/.test(o)){res.setHeader('Access-Control-Allow-Origin',o);res.setHeader('Vary','Origin');}}
```
  - Line 43: `if(['POST','PUT','DELETE'].includes(req.method)&&!sameOrigin(req))return send(res,403,{error:'ORIGIN_REJECTED'});` and `sameOrigin` (26) needs `origin.host===req.headers.host||origin.origin===publicUrl`: a POST from the :8800 page gets 403.
  - Line 44: `if(req.method==='OPTIONS'){res.writeHead(405);return res.end();}` — every preflight fails. `jsonBody` (14) requires `application/json`.
  - Auth is fine for the local page: `auth` (25) returns the local session when `localRequest` (11) holds (loopback peer, no proxy headers, Host `127.0.0.1:8801` or `localhost:8801`).
  - No WebSocket server and no WebRTC stack exist on either server (no `upgrade` handler; only `ws` in node_modules).

## 8. server.mjs
- `/clean/program` (200): `if (p === '/clean/program') { res.writeHead(302, { Location: '/fx/?clean=1' + (url.search ? '&' + url.search.slice(1) : '') }); return res.end(); } // camera + everything` — the WHOLE query string is forwarded verbatim; no auth, no filtering.
- Other `/clean/*`: `/clean/foreground` and `/clean/background` serve `public/clean-*.html` (198-199); `/clean` returns an index JSON with `program: '/clean/program?src=phone|camera&streamer=<name>', size: '1080x1920 (9:16)'` (257); anything else 404.
- `/fx` -> 302 `/fx/` (287). `/fx/*` (288-289): `if (fx.handle(req, res, url, studioAuthed(req))) return;` then `serveFile(req, res, FX, decodeURIComponent(p.slice(4)) || 'index.html')`.
- `/fx/*` headers (`serveFile` 48-49): `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *`, and `'Cache-Control': /\.(html|json|js)$|[\\/]opponent[\\/]/.test(file) ? 'no-store' : 'public, max-age=300'`. So html/js/json are never cached; media/images 5 min; Range replies are 206 without Cache-Control.
- Dynamic routes of `fx.handle` (`lib/fx-routes.mjs:209-220`, path with or without `/fx`): `POST /remix`, `/remix-status`, `/phone.mjpeg`, `/phone.jpg`, `/phone-info`, `POST /save`; 401 unless local or studio key. `/phone.mjpeg` (153-169): `multipart/x-mixed-replace; boundary=frame`, `no-store`, about 35 fps cap, `?need=tiktok` variant answers 409 when TikTok is not in front.
- Other routes the page calls: `GET /api/stage-events` (SSE, 334-337), `GET /api/battle` (333), `GET|POST /api/opponent-face` (203-224), `POST /api/opponent-pick` (226-230), `/media/...` static (303), `/media/fx/assets/wake-up.mp3` (301). `/remix-status` is fetched for each of the 28 effects every 4 s (`fx/index.html:166-175`).
- Auth (39-40): `isLocal` = loopback peer without `cf-connecting-ip`/`x-forwarded-for`; `studioAuthed` = no `STUDIO_CLIENT_KEY`, or local, or `?ck=` / `x-key` / cookie `bk` / `x-api-key`.
- CORS: `OPTIONS` -> 204 with `Access-Control-Allow-Origin: *`, headers `*`, methods `GET,POST,PUT,DELETE` (192); JSON replies carry `Access-Control-Allow-Origin: *` (29).
- Listening (450): `server.listen(PORT, () => { ... })` with no host = ALL interfaces (confirmed `::` at runtime). `PORT` default 8800 (23). There is no proxy from :8800 to :8801.
- Env variable NAMES: `PORT`, `PUBLIC_BASE_URL`, `DRY_RUN` (server.env.example); `OPENROUTER_API_KEY`, `KLING_API_KEY`, `SIGN_API_KEY`, `TIKTOOLS_API_KEY`, `API_TOKEN`, `STUDIO_CLIENT_KEY` (.env.example); from code also `GALLERY_TITLE`, `KLING_CONCURRENCY`, `ADB_SERIAL`, `PHONE_SIZE`, `MOBILE_PORT`.

## 9. Existing audio in the page
- Main `<video id="src">` is muted. All effect, remix, gnome and tomato videos are `muted = true` (`fx-engine.js:86, 93, 291, 784, 804, 872`).
- Battle clips are created UNMUTED in the program page: `battle-stage.js:25` `constructor({ ..., sound = true } = {})`, line 60 `v.muted = !this.sound;`, and the engine passes no `sound` (`fx-engine.js:56`). Fallback (85): `v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); // sound needs a click on the page first; without one it plays silent`.
- Synthesised sounds use two separate lazily created AudioContexts: `FxEngine.splatSound()` (899-909) and `boomSound()` (941-952) with `const ac = this.ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume();`, and `BattleStage._sound()` (`battle-stage.js:360-363`), which can also do `new Audio(s.file)`.
- `wakeVoice()` (938): `new Audio('/media/fx/assets/wake-up.mp3')`.
- No `createMediaElementSource`, `createMediaStreamSource`, `MediaStreamDestination` or `setSinkId` in the program page. Everything goes to the default output device.
- Extra `<audio>` with a remote track: no technical conflict; it just adds to the same output. The real issues:
  1. Autoplay policy: without a user gesture or a launch flag `audio.play()` rejects.
  2. Do not unmute `#src` instead: a rejected play() or a script unmute of a muted-autoplaying video pauses it (expected Chrome behaviour) and the picture stops. Give `#src` only the video and a separate `<audio>` the audio track.
  3. In the HLS fallback the audio is inside the stream on the muted `#src`, so it is silent.
  4. The phone's outgoing audio already contains the phone-side effect sounds: `public/mobile/audio.js:3-7` routes `engine.ac`, `engine.battle.ac`, `engine.battle._sound` and `engine.wakeVoice` into a `MediaStreamDestination` mixed with the mic. With `audio=1` the same effect can sound twice (phone mix + the program page's own sounds).
- `fx-engine.js:61`: "never give a page element id="dbg": it becomes window.dbg and breaks this".

## 10. How the Studio is expected to capture it; launchers
- What the docs say (the only statements found): `STUDIO-CONNECT.md:18` heading "השכבות הנקיות (מקור דפדפן / מצלמה וירטואלית, 1080x1920)" (clean layers = browser source / virtual camera, 1080x1920); `STUDIO-CONNECT.md:24` `http://localhost:8800/clean/program?src=phone&streamer=<שם>` = everything together, no buttons; `STUDIO-CONNECT.md:26` "`?sound=1` בסוף כתובת של שכבה = עם סאונד הקליפים" (applies to foreground/background only); `public/links.html:66-71` group "📺 שכבות נקיות (מקור דפדפן)" and "מקור דפדפן אחד ב-Studio"; `fx/index.html:35` "for the Studio / virtual camera" and 38-39 "(= full bleed in the Studio's 1080x1920 source)"; `server.mjs:257` `size: '1080x1920 (9:16)'`.
- "Window capture of a Chrome window": NOT FOUND in README.md, MOBILE.md, STUDIO-CONNECT.md or the repo-root `docs/`. `docs/STUDIO.md:14` only starts LIVE Studio 1.39.6 with `--devtoolsMcp=1 --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` for the control panel.
- Launchers (none starts Chrome with flags; all use the default browser via `start ""`):
  - `ROOT\start.cmd`: `start "" http://localhost:8800/` then `node server.mjs`.
  - `ROOT\start-mobile.cmd` -> `node start-mobile.mjs`: starts `server.mjs` if `/health` is down, then `mobile-gateway.mjs --open [--tunnel]`; the gateway opens `/mobile/pair` (`mobile-gateway.mjs:132`).
  - `ROOT\install-mobile.cmd`: `npm.cmd install --omit=dev` then start-mobile.cmd.
  - Repo-root `START.cmd`: `node server.mjs --open` (control panel on 127.0.0.1:47831).
  - OLD has the same three .cmd files, no others.
- Chrome flags anywhere: only in Playwright tests of the PWA — `test/mobile-browser.py:15` and `test/workspace-browser.py:15`: `args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']`. No test opens `/clean/program` or `/fx/`; only `test/stage-url.test.mjs` covers the helpers.
- STUDIO-CONNECT.md in ROOT holds a `<CONFIGURE_LOCALLY>` placeholder, not a key (viewed through a masking filter).

## Where `src=live` plugs in
- Function next to `usePhone` (after line 124); branch before the generic one at line 205; call it un-awaited.
- Give the engine a video-only MediaStream on `#src` (keep it muted), `video.play().catch(...)` after every assignment; audio on a separate element.
- Status through `log()` only; expose state on `window` like `window.fxStage`.
- For fallback port `useServer()` plus the gateway CORS hunk; destroy hls before assigning a MediaStream and clear `srcObject` before attaching hls.

## GOTCHAS
- The running :8800/:8801 processes are the OLD copy (C:\Users\shk\wanna-studio-server): its data\db.json is rewritten every minute and the repo copy's is not. Edits to the repo's fx/index.html are not served at http://localhost:8800 until the repo copy is the one running. html/js/json are served no-store, so static edits need no restart once it is.
- Source selection happens only after `await loadAll()` and `await fx.init()` (fx/index.html:200-201, top-level await). Unknown src values fall into `useSrc()`: today `?src=live` and `?src=server` load `/fx/live` / `/fx/server` (404) and leave an unhandled play() rejection. Put the new branch before `else if (qs.get('src')) useSrc(...)` at line 205 and do not await it.
- The repo gateway sends no CORS headers, so the :8800 page cannot read anything from :8801 until the OLD hunk (OLD mobile-gateway.mjs:41-42, GET only, origins http://localhost:8800 and http://127.0.0.1:8800) is ported. Even then cross-origin POST is rejected (mobile-gateway.mjs:43 `ORIGIN_REJECTED` via sameOrigin, line 26) and every preflight fails (line 44 answers OPTIONS with 405). An SDP offer/answer POST from the program page needs a gateway change or a same-origin proxy on :8800 (none exists).
- There is no CSP on :8800 (no header, no meta): nothing there blocks 127.0.0.1:8801, the hls.js CDN import or WebRTC. The CSP in mobile-gateway.mjs:71 applies only to /mobile/* documents.
- fx/fx-engine.js is shared with the phone PWA (public/mobile/app.js:62) and public/mobile/audio.js:5-7 monkey-patches `engine.ac`, `engine.battle.ac`, `engine.battle._sound` and `engine.wakeVoice`. Any engine edit (zero-size guard, skipping updatePlate when transparent, audio changes) also changes the phone app.
- A mid-stream size change is survived because `setup()` runs every frame (fx-engine.js:337-348), but: (a) in transparent mode up to one frame shows the wall without her (new empty mask until the next odd frame); (b) `personCanvas` (561) and `post` (1034) are re-created only when the WIDTH changes; (c) pixel-space state of a running effect (`st.frozen`, `st.lastFace`, `st.lastM/blendFrom`) and `ptsSmooth` stay in the old size; (d) the plate is wiped while `plateLocked` stays true (matters without ?stage=); (e) `#out` is `object-fit: contain`, so any non-9:16 frame is letterboxed and her size against the wall changes.
- `frame()` gates only on `readyState < 2` (fx-engine.js:715). If `#src` reaches readyState >= 2 with videoWidth 0 (e.g. a MediaStream that so far holds only the audio track), `setup()` makes 0x0 canvases and every frame throws; each throw calls `log('frame error …')` and the log string is never trimmed (fx/index.html:86). Assign only a stream that already has the video track, and never log per frame or per retry without a bound.
- The engine never notices a dead feed: there are no listeners on the main video and it keeps compositing the last frame (or the canvas keeps the last composite when readyState < 2). In transparent mode her last cut-out stays frozen on the live wall. The new code must run its own watchdog and, to remove her, set `video.srcObject = null` and clear `fx.ctx` itself.
- While `frame()` is skipped (source gap), `postFX()` still draws every frame onto the uncleared canvas (fx-engine.js:1062, 1002): a gnome/battle clip, WAKE UP dim, shake zoom or double banner in flight will smear, re-zoom or darken until frames return.
- After every `srcObject` change the element is paused again and needs `video.play()`; a pending play() rejects with AbortError; for a MediaStream play() stays pending until the first frame, so awaiting it blocks the function (expected HTML/Chrome behaviour, not run-tested). Existing callers have no catch.
- hls.js and srcObject cannot be mixed: `srcObject` wins over `src`, so clear it before `attachMedia` and destroy hls before assigning a MediaStream. Use hls.js (MSE) only: a direct cross-origin `video.src` to :8801 would taint the canvas (`#src` has no crossorigin attribute) and break MediaPipe GPU upload, `grabFrame()` and `record()`. The `loop` attribute on `#src` would replay the last buffered seconds of an ended HLS stream (expected; verify).
- Audio: keep `#src` muted and play the phone audio on a separate `<audio>` with only the audio track. Without a gesture or a launch flag `audio.play()` rejects; unmuting a muted-autoplaying video by script pauses it and would freeze the picture (expected Chrome behaviour). In the HLS fallback the audio sits inside the muted video, so `audio=1` is silent there.
- The phone's outgoing audio already carries phone-side effect sounds (public/mobile/audio.js mixes the engine's sounds with the mic), and the program page plays its own effect sounds too: battle clips are created unmuted (battle-stage.js:25, 60; fx-engine.js:56), plus two AudioContexts and `new Audio()` for WAKE UP. With `audio=1` an effect running on both sides is heard twice. `?sound=1` is not read by the program page.
- The engine is driven by requestAnimationFrame with no new-frame check (fx-engine.js:1061-1064): a hidden, minimised or fully covered Chrome window stops the picture (expected Chrome window-occlusion behaviour), and a high-refresh display multiplies the work. No launcher in either copy starts Chrome with any flag.
- Unless the link carries `opp=0`, the program page starts the opponent watcher (fx/index.html:245): three more GPU models and a fetch of `/fx/phone.jpg?need=tiktok` every 2.5 s, each of which makes the :8800 server run adb against the attached phones (lib/fx-routes.mjs:62-79). For a phone-only `src=live` program add `&opp=0`.
- In transparent mode `updatePlate()` still runs on every mask frame (fx-engine.js:732, 522-531): a full-size video draw plus five heavily blurred mask draws for a plate that is never shown there. With face + pose + mask models and a WebRTC decode this is the first cost to cut, but the fix is in the shared engine.
- The stage gate is one-shot (stage-url.js:32-38, 15 s): a slow wall at page load removes the iframe for good and the opaque camera is broadcast; a wall that fails later or refuses framing is not detected and she is cut out over whatever the iframe shows. Any non-empty `clean` value is clean (`clean=0` too) and `debug=1` paints debug text into the broadcast.
- Mirroring is done on the phone, not on the program page: the PWA flips its output canvas for the front camera (public/mobile/app.js:50) and that canvas is fixed portrait 720x1280 or 1080x1920 (app.js:193). The program page draws frames as received, so she may be mirrored while the wall and effect text are not.
- `useServer()` as written gives up after about 5 minutes and never retries, has no hls error recovery, never follows a new broadcast id, picks the newest running preview of ANY paired device and hard-codes port 8801. Fix these when it becomes the fallback.
- :8800 listens on all interfaces and treats any loopback request as trusted, with `Access-Control-Allow-Origin: *` on its JSON replies and an open OPTIONS handler (server.mjs:29, 39-40, 192, 450). The embedded cloud wall and any local web page can call its APIs. Do not let a new signalling or viewer route rely on 'local = trusted' alone.
- The gateway is bound to 127.0.0.1 and reaches phones only through an HTTP tunnel (mobile-gateway.mjs:124-131; the running instance has no --tunnel flag). WebRTC media cannot travel through that tunnel: it needs a direct LAN path or STUN/TURN, and neither server has a WebSocket or WebRTC component today.

## OPEN QUESTIONS
- How is the program page really captured: as a LIVE Studio browser source (what STUDIO-CONNECT.md and links.html describe, 1080x1920) or as a Chrome window capture plus desktop audio (the premise of this task)? It decides autoplay (flag or click needed), the occlusion risk and where audio comes from. No Chrome launcher or flag set exists in either copy.
- Where does WebRTC signalling live and from which origin does the program page reach it: a relaxed gateway (CORS + POST + OPTIONS for the :8800 origin) or a same-origin proxy added to server.mjs?
- Which phone does the program page show when several devices or creators are paired? Nothing binds `streamer` / the Vardyverse creator to a gateway session or broadcast id; `useServer()` just takes the newest running preview.
- What does the phone send over WebRTC: the raw camera, or the PWA's composited output canvas (fixed portrait, mirrored for the front camera, with phone-side effects and effect sounds mixed in)? This decides resolution changes, mirroring, doubled effects and doubled sound.
- Must the HLS preview run permanently next to WebRTC so the fallback is instant (double encoding and uplink on the phone), or is it started only when WebRTC fails (many seconds of gap)?
- What should the broadcast show when the feed is lost in transparent mode: frozen last cut-out, empty wall, or the HLS fallback picture? The engine has no built-in behaviour for any of them.
- With `audio=1` during the HLS fallback, how should audio be played (the stream's audio is on the muted engine video)? And should the program page's own effect sounds be silenced when the phone mix already contains them?
- Who supplies ICE servers (STUN/TURN) to the program page, and is the phone always on the same LAN as the Windows machine?
- Not run-tested here: whether MediaPipe tasks-vision 0.10.14 on the GPU delegate takes a mid-stream input size change without a hitch, and whether `requestVideoFrameCallback` fires for the `display:none` `#src` element (relevant if it is used as a stall watchdog).
- Is it acceptable to change the shared engine (zero-size guard in `frame()`, skip `updatePlate()` when transparent, width+height cache keys), given that the phone PWA loads the same file?
- Should the default program links (public/links.html:68-71, server.mjs:257, `programUrlWithStage` in stage-url.js:42-45) gain `src=live`, `audio` and `opp=0` variants?
