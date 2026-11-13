# MAP: phone-client

# Phone client map: public/mobile (WANNA FX Mobile 1.2.0)

Everything below was read, not run. No file was created or changed, no server touched, and `.env` / `server.env` were not opened.

- Canonical: `C:\My Web Sites\boostera-live-studio-web\server-integration\wanna-studio-server\public\mobile` (branch `integration/stage-and-ingest`, HEAD `b03aa14`, tree clean). `core.autocrlf=true`, so the working tree is CRLF and the index LF.
- Old running copy: `C:\Users\shk\wanna-studio-server\public\mobile` (LF).
- Server side read for context: `mobile-gateway.mjs`, `lib/mobile-workspace.mjs`, `lib/mobile-broadcast.mjs`, `lib/mobile-session.mjs`.
- Neither tree contains `live.html`, `live-capture.js` or any `/mobile/live` reference, so there is no naming conflict.

## 0. What decides how the new page must be added

**a) The gateway serves /mobile/ from a hard-coded allowlist.** New files return 404 until added. `mobile-gateway.mjs:61-72`:
```js
if(p==='/mobile/manifest.webmanifest'||p==='/mobile/sw.js'||p.startsWith('/mobile/')){
  let name=p==='/mobile/'?'index.html':p.slice('/mobile/'.length);
  if(name==='pair')name='pair.html';
  if(name==='manage'||name==='manage/')name='manage.html';
  if(name==='viewer'||name==='viewer/')name='viewer.html';
  if(name==='pair.html'&&!localRequest(req,port))return send(res,403,{error:'LOCAL_SETUP_ONLY'});
  if(!['index.html','pair.html','app.js','app.css','manage.html','manage.js','workspace.css','render.js','battle.js','chat.js','audio.js','viewer.html','viewer.js','pair.js','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png','icon.svg'].includes(name))return send(res,404,{error:'NOT_FOUND'});
```
- Static files are served before the auth gate (`:74`), so they need no session. Only `pair.html` is local-only.
- `TYPES` (`:10`) knows `.html .js .css .json .webmanifest .png .svg`; anything else is `application/octet-stream` with `nosniff`.
- `/mobile` without the trailing slash is not a static route.

**b) Headers on every /mobile/ file** (`:69-71`, plus `:39-40` on every response):
- `Cache-Control: no-cache` (the ternary `name==='sw.js'?'no-cache':'no-cache'` is the same both ways). No ETag or Last-Modified, so every load is a full 200.
- `Service-Worker-Allowed: /mobile/`
- `Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`
- `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`.

Consequences for `live.html`:
- No inline `<script>` or `onclick=""`; inline `<style>` is allowed.
- fetch/XHR only to the gateway origin (plus jsDelivr and storage.googleapis.com). The phone page cannot call Vardyverse directly.
- It cannot be iframed by another origin and cannot get the camera inside a cross-origin iframe. It must be a top-level page on the gateway origin.

**c) Auth is a pairing cookie.**
- `auth(req)` (`:25`): `localRequest(req,port)?localSession:sessions.get(cookies(req).wm_sid)`.
- Cookie set by `POST /api/mobile/pair` (`:57`): `wm_sid=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, plus `; Secure` behind Cloudflare or https.
- Sessions are in memory (`lib/mobile-session.mjs:3`, ttl 12 h, max 12 devices `:11`). A gateway restart signs every phone out.
- Codes: 8 digits, valid 180 s, one at a time (`:4`); 8 bad tries per IP per 60 s gives `TOO_MANY_ATTEMPTS` (`:8`).
- A request from 127.0.0.1/localhost:8801 with no `cf-connecting-ip` / `x-forwarded-for` is auto-authenticated as `{id:'local-desktop',label:'המחשב'}` (`:11`, `:23`).
- POST/PUT/DELETE must be same-origin (`:26`, `:43`, else 403 `ORIGIN_REJECTED`). `OPTIONS` returns 405 (`:44`).

## 1. Boot sequence of app.js

`index.html:1` loads `<script type="module" src="/mobile/app.js">`. Static imports (`app.js:1-3`): `/mobile/battle.js` (which imports `/mobile/chat.js`), `/mobile/audio.js`, `/mobile/render.js`. All paths are absolute.

Order:
1. `:4-18` helpers and state. `:7` grabs `#camera`, `#output` (2D context, `{alpha:false}`), `#fx-output`, `#overlay`. `:8` `createAudioMixer()` (no AudioContext yet).
2. `:10` `createMobileWorkspace({...})` binds its DOM handlers at once and starts three timers (2 s broadcast status, 800 ms commands, 8 s overview).
3. `:13` `const secure=window.isSecureContext&&Boolean(navigator.mediaDevices?.getUserMedia);`
4. `:57` `requestAnimationFrame(draw)` starts painting immediately.
5. `:191` `if('serviceWorker'in navigator)navigator.serviceWorker.register('/mobile/sw.js',{scope:'/mobile/'}).catch(()=>{});`
6. `:192` `await checkSession();if(session?.authenticated){await loadCatalog();connectEvents();}setInterval(checkSession,12000);`
7. Only after that top-level await: `:193` `#output-quality` handler, `:195` `#effect-audio` handler, `:197` `mountBattle(...)`.

The camera never auto-starts. It needs a tap on `#start-camera-main` or `#camera-toggle` (`:96`).

**Status call.** `/api/mobile/status` does not exist anywhere (client or server; grep found nothing). The call is `GET /api/mobile/session` (`app.js:31-34`):
```js
async function checkSession(){
  try{const response=await fetch('/api/mobile/session',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(response.status===401){applyAuth(null);return;}if(!response.ok)throw Error();applyAuth(await response.json());}
  catch{set('server-state','אין חיבור לשרת');$('server-state').classList.remove('ok');}
}
```
- Runs at boot, every 12 s, on the `online` event (`:190`) and on `#test-server` (`:178`).
- Response (`mobile-gateway.mjs:79`): `{authenticated:true,local,device:{id,label},effectsServer,counts:{effects,templates},serverTime,stats:{frames,bytes,audioTests,lastFrameAt},platform:{tiktokConnected,battlesConnected},version:'1.2.0'}`. Without a session: 401 `{error:'PAIRING_REQUIRED'}` (`:74`).

**No pairing redirect in the client.** The only redirect is the gateway's `/` to `/mobile/` (`:46`).
- `applyAuth(value)` (`app.js:19-24`) toggles the inline `#pair-card`, sets `#server-state`, and disables `#start-camera-main` / `#camera-toggle` when unauthenticated.
- Pair form (`:35-40`): `POST /api/mobile/pair` with `{code,label}` (label is `'iPhone / iPad'`, `'Android'` or `'דפדפן'`), then `checkSession()`, `loadCatalog()`, `connectEvents()`.
- `manage.html:4` shows `#auth-needed` with a link to `/mobile/`; the viewer only prints text.
- Logout (`:185`): `POST /api/mobile/logout`.

**api() helpers.** There are four, each module-private:
- `app.js:25-30`, full path, returns the Response:
```js
async function api(path,options={}){
  const response=await fetch(path,{cache:'no-store',...options});
  if(response.status===401){applyAuth(null);stopProbe();throw new Error('PAIRING_REQUIRED');}
  if(!response.ok){let j={};try{j=await response.json();}catch{}throw new Error(j.error||'SERVER_ERROR');}
  return response;
}
```
- `app.js:99`: `async function post(path,value){return(await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).json();}`
- `render.js:2`, base `/api/workspace/`, returns JSON, no 401 handling, parses JSON before checking `ok`:
```js
async function api(route,method='GET',data){const response=await fetch('/api/workspace/'+route,{method,cache:'no-store',...(data!==undefined?{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});const value=await response.json();if(!response.ok)throw Error(value.error||'SERVER_ERROR');return value;}
```
- `manage.js:10`: `api(route,{method,data,raw,mime})`, `BASE='/api/workspace/'`; on 401 it shows `#auth-needed` and sets `#connection` to `'נדרש צימוד'`.
- `battle.js:19`: `request(route,body)` on `/api/workspace/tiktok`, `AbortSignal.timeout(25000)`, throws `Error('REQUEST_FAILED')`.

Server errors are JSON `{error:'CODE'}` (`mobile-gateway.mjs:115`).

**toast()** (`app.js:15`; same idea at `manage.js:8`). The element is `<div id="toast" class="toast" role="status" hidden></div>` (`index.html:23`):
```js
function toast(message){set('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},5000);}
```

## 2. Camera and microphone today

`startCamera()` is `app.js:72-87`. Two separate getUserMedia calls, video first (`:76-78`):
```js
const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:720},height:{ideal:1280},frameRate:{ideal:targetFps,max:targetFps}},audio:false});
cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=next;video.srcObject=next;await video.play();
if(!micStream)try{micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});}catch{toast('המצלמה פעילה ללא מיקרופון. אפשר לאשר הרשאה בהגדרות הדפדפן.');}
```
- `facing='user'` initially, `targetFps=30` (60 only with the `1080-60` quality option). The request is always ideal 720×1280 whatever the output quality.
- Guards (`:73`): `if(cameraBusy)return;if(!secure){toast('המצלמה דורשת פתיחה בקישור HTTPS, ב־Safari או Chrome.');return;}`
- Then `:79` `mixer.start(micStream);mixer.attach(engine);`, UI state, `:83` wake lock, `:84` `initEngine()`.

**Permission denial.**
- Camera (`:85`): `toast(error.name==='NotAllowedError'?'יש לאשר גישה למצלמה בדפדפן.':'לא ניתן לפתוח את המצלמה. סגור אפליקציה אחרת שמשתמשת בה ונסה שוב.')`. The UI stays "camera off" and the mic is never requested.
- Mic: any error gives the toast above and continues video-only; `#mic-toggle` and `#test-audio` stay disabled (`:80`). The mic is retried on the next `startCamera()`, including a flip.

**Facing switch** (`:97`):
```js
$('flip-camera').onclick=async()=>{if(recording?.state==='recording'){toast('עצור את ההקלטה לפני החלפת מצלמה.');return;}cameraStream?.getVideoTracks().forEach(t=>t.stop());cameraStream=null;video.srcObject=null;facing=facing==='user'?'environment':'user';await startCamera();};
```
- Blocked only during a local recording, not during a broadcast. A broadcast survives a flip because the recorder captures the canvas, not the camera track.

**The picture is a canvas, mirrored for the front camera** (`:50`): `ctx.save();if(facing==='user'){ctx.translate(output.width,0);ctx.scale(-1,1);}paintCover(source,ctx,output.width,output.height);ctx.restore();`
- Canvas is 720×1280 by default; `:193` switches to 1080×1920 at 30 or 60 fps. The select is disabled while the camera is on.

**micStream handling.**
- Declared `:6`; acquired `:78` only if not already held; survives flips.
- Mute (`:98`): `micStream.getAudioTracks().forEach(t=>t.enabled=on);if(!mixer.active){recordStream?.getAudioTracks().forEach(t=>t.enabled=on);workspaceUI.mute(on);}`
- Stopped in `stopCamera()` (`:88-95`), which also calls `mixer.stopMic()` and `workspaceUI.stopBroadcast()` and releases the wake lock.
- `getMic:()=>micStream` is passed to render.js (`:10`) but render.js never uses it.

**audio.js mixer** (11 lines, no DOM dependencies). `createAudioMixer()` returns `{start,attach,update,stopMic(),get active(),track(),toggleEffects()}`.
- `audio.js:3`: `function start(stream){try{if(!context){context=new (window.AudioContext||window.webkitAudioContext)();destination=context.createMediaStreamDestination();effects=context.createGain();effects.connect(destination);effects.connect(context.destination);}void context.resume();micSource?.disconnect();micSource=stream?.getAudioTracks().length?context.createMediaStreamSource(stream):null;micSource?.connect(destination);}catch{}}`
- The mic goes only to the mix, never to the speakers. Effect sounds go to both.
- `audio.js:10`: `track(){return destination?.stream.getAudioTracks()[0]?.clone()||null;}`. That is a clone of the mixed mic-plus-effects track, or `null` if the mixer never started.
- `get active(){return Boolean(destination);}`. With the mic denied the mixer is still active, so a broadcast still carries an audio track (effects or silence).

## 3. "Send video to server" flow

All of it lives in closures inside `createMobileWorkspace` (`render.js:4`). Only `stopBroadcast` and `mute` are exposed (`:89`).

**The stream** (`app.js:154-156`):
```js
function createRecordStream(){
  const stream=output.captureStream(targetFps);const mixed=mixer.track();if(mixed)stream.addTrack(mixed);else for(const track of micStream?.getAudioTracks()||[])stream.addTrack(track.clone());return stream;
}
```

**startBroadcast(mode)** (`render.js:72-82`; buttons at `:84`: `#send-server` is `'preview'`, `#send-rtmp` is `'rtmp'`):
```js
if(broadcastStarting)return;if(broadcast)return stopBroadcast();if(!getCamera())return toast('הפעל קודם מצלמה.');if(!window.MediaRecorder||!output.captureStream)return toast('הדפדפן אינו תומך בהעברת וידאו.');
broadcastStarting=true;
try{
  const types=['video/webm;codecs=vp8,opus','video/webm','video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4'],mime=types.find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw Error();
  broadcastStream=createStream();broadcast=await api('broadcast/start','POST',{mode,mime});broadcastRecorder=new MediaRecorder(broadcastStream,{mimeType:mime,videoBitsPerSecond:2500000});sequence=0;pending=0;failed=false;uploadQueue=Promise.resolve();broadcastRecorder.ondataavailable=e=>enqueue(e.data);
  broadcastRecorder.onstop=()=>{const stream=broadcast,id=stream?.id;uploadQueue.finally(async()=>{if(id)try{await api('broadcast/'+id+'/stop','POST');}catch{}broadcastStream?.getTracks().forEach(t=>t.stop());broadcast=null;broadcastRecorder=null;broadcastStream=null; /* then UI reset */ });};
  broadcastRecorder.onerror=()=>{failed=true;void stopBroadcast();};broadcastRecorder.start(1000);
```
- Mime order is WebM/VP8+Opus first, MP4/H.264 as fallback. Local recording uses the opposite order (`app.js:18`, MP4 first, 3 Mbps).
- Timeslice 1000 ms. Video 2.5 Mbps. No audio bitrate set.
- The catch (`:81`) stops an orphan (`if(broadcast)try{await api('broadcast/'+broadcast.id+'/stop','POST');}catch{}`) and shows one of two generic toasts. It does not look at the error code.

**enqueue(blob)** (`:68-71`), a strictly serial upload with back-pressure:
```js
function enqueue(blob){if(!blob.size||!broadcast)return;pending++;if(pending>8){pending--;failed=true;el('server-stream-state').textContent='החיבור איטי מדי. השידור נעצר.';toast('החיבור איטי מדי. שידור הווידאו נעצר.');void stopBroadcast();return;}
  const streamId=broadcast.id,n=sequence++;
  uploadQueue=uploadQueue.then(async()=>{if(failed)return;for(let attempt=0;attempt<3;attempt++){try{const r=await fetch('/api/workspace/broadcast/'+streamId+'/chunk',{method:'POST',headers:{'Content-Type':blob.type||'application/octet-stream','x-sequence':String(n)},body:blob,signal:AbortSignal.timeout(20000)});const ack=await r.json();if(!r.ok)throw Error(ack.error);showBroadcastStatus(ack);return;}catch(e){if(attempt===2)throw e;}}}).catch(()=>{failed=true; /* state text + toast */ if(broadcastRecorder?.state==='recording')broadcastRecorder.stop();}).finally(()=>pending--);
}
```
Rules:
- More than 8 chunks waiting: abort the whole broadcast.
- Each chunk: up to 3 immediate attempts, 20 s timeout each; the third failure aborts.
- Nothing is dropped, adapted or auto-restarted.

**stopBroadcast()** (`:83`): `async function stopBroadcast(){if(broadcastRecorder?.state==='recording')broadcastRecorder.stop();}`. The server stop is sent from `onstop` after the queue drains.

**Status.**
- `showBroadcastStatus(s)` (`:60-67`) treats `failed|stopped|stopping` as a stop. Otherwise it writes `#server-stream-state` and sets `#preview-label` to `CONNECTING`, `SERVER OUTPUT` or `RTMP OUTPUT` from `s.outputConfirmed`.
- A 2 s poll (`:85-86`) calls `api('overview')`, finds its own broadcast, and stops after 3 failed polls in a row.
- Every chunk ack already carries the full broadcast view, so a thin client can run on acks alone.

**Server contract.**
- `POST /api/workspace/broadcast/start` (`lib/mobile-workspace.mjs:135`), body `{mode,mime}`, returns 201 with the view (`lib/mobile-broadcast.mjs:11`): `{id,mode,state,mime,bytes,sequence,startedAt,lastChunkAt,outputConfirmed,outputFrames,lastOutputAt,error,playback}`. `playback` is `/api/workspace/broadcast/<id>/files/live.m3u8` for `preview`, else null.
- Start errors: `MEDIA_TOOLS_REQUIRED` 409; `INVALID_BROADCAST_FORMAT` 400 (mode must be `preview|rtmp|record`, mime must match `/^video\/(mp4|webm)(;|$)/`); `BROADCAST_LIMIT` 409 (at most 2 starting/running/stopping for the whole gateway, `:15`); `RTMP_NOT_CONFIGURED` 409.
- `POST …/<id>/chunk` (`mobile-workspace.mjs:138`), body up to 8 MiB, header `x-sequence`. From `mobile-broadcast.mjs:35-46`:
  - `BROADCAST_NOT_FOUND` 404 if the session is not the owner.
  - 409 with `s.error||'BROADCAST_STOPPED'` if not active.
  - A replayed chunk with the same hash returns `{accepted:true,repeated:true}`.
  - `SEQUENCE_MISMATCH` 409, `BACKPRESSURE` 429 (a write is still in flight), `INVALID_CHUNK_SIZE` 413.
- `POST …/<id>/stop`; `GET …/<id>/files/(live.m3u8|init.mp4|part-N.m4s|recording.mp4)`.
- States: `starting`, then `running` once ffmpeg reports `frame>0 && out_time_us>0`, then `stopping`, then `stopped` or `failed`.
- Watchdog (`:9`): `INPUT_TIMEOUT` after 60 s without a chunk, `OUTPUT_TIMEOUT` after 60 s without encoder output; folders are deleted 30 min after stop.
- Encoder (`:18-19`): stdin to libx264 ultrafast/zerolatency, `-r 30 -g 60 -b:v 2500k`, AAC 128k. `preview` writes HLS fMP4 with `-hls_time 2 -hls_list_size 6` under `runtime/mobile-broadcast/<id>/`.

## 4. Wake lock, visibility, orientation, fullscreen

- **Wake lock.** Acquired in `startCamera` (`app.js:83`): `if(navigator.wakeLock)try{wakeLock=await navigator.wakeLock.request('screen');}catch{}`. Released in `stopCamera` (`:94`). Re-acquired on return (`:189`):
```js
document.addEventListener('visibilitychange',()=>{if(document.hidden&&probe)set('video-test-details','האפליקציה ברקע. הדגימות יתחדשו כשחוזרים אליה.');if(!document.hidden&&cameraStream&&navigator.wakeLock)navigator.wakeLock.request('screen').then(lock=>wakeLock=lock).catch(()=>{});});
```
- **Hidden page.** `document.hidden` only pauses polling (`app.js:172`, `render.js:16`, `render.js:87`, `battle.js:20`, `manage.js:57`). Nothing pauses or stops a broadcast. `draw()` runs on requestAnimationFrame, which browsers suspend for hidden pages (platform behaviour, not tested here).
- **No** `pagehide`, `beforeunload`, `sendBeacon` or `keepalive` anywhere. A closed tab leaves the broadcast to the server's 60 s `INPUT_TIMEOUT`.
- **Orientation.** Only `"orientation": "portrait"` in the manifest. No `screen.orientation.lock`, no listeners. The fixed 9:16 canvas plus `paintCover` crops whatever the camera gives.
- **Fullscreen.** No `requestFullscreen`. The app relies on `display: standalone`, `viewport-fit=cover` and `env(safe-area-inset-*)` on `header`, `.toast`, `footer`.
- `online` / `offline` (`:190`): re-check session, or show `'אין רשת'`.

## 5. Service worker sw.js (whole file, 4 lines)
```js
const CACHE='wanna-fx-mobile-v5';const SHELL=['/mobile/','/mobile/app.js','/mobile/app.css','/mobile/render.js','/mobile/battle.js','/mobile/chat.js','/mobile/audio.js','/mobile/manage','/mobile/manage.js','/mobile/workspace.css','/mobile/viewer','/mobile/viewer.js','/mobile/manifest.webmanifest','/mobile/icon-192.png','/mobile/icon-512.png','/mobile/apple-touch-icon.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;const u=new URL(event.request.url);if(u.origin!==location.origin||!SHELL.includes(u.pathname))return;event.respondWith(fetch(event.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));}return r;}).catch(()=>caches.match(event.request)));});
```
- **Strategy:** network-first with cache fallback, only for same-origin GETs whose pathname is exactly in `SHELL`. Everything else is not intercepted: APIs, `/fx/`, `/media/`, POST chunks, and also `/mobile/pair`, `/mobile/pair.js`, `/mobile/icon.svg`, `/mobile/manage.html`, `/mobile/viewer.html`.
- The cache is read only when `fetch()` rejects. An HTTP error such as a tunnel 502 is passed through.
- Install precaches `SHELL` and calls `skipWaiting`; activate deletes other caches and claims clients.
- Registered from `app.js:191` and `manage.js:58` only.

**Will a new file be fresh?** Yes. `/mobile/live.html` and `/mobile/live-capture.js` are not in `SHELL`, so the worker ignores them, and the gateway sends `no-cache` with no validators. A stale cache cannot hide them. What does hide them is the gateway allowlist (section 0a).

**What must change in sw.js?** Nothing is required. To follow the 1.2.0 convention (offline fallback):
- Add the exact pathname users open (`'/mobile/live'` if you add the alias) and `'/mobile/live-capture.js'` to `SHELL`.
- Bump `CACHE` to `'wanna-fx-mobile-v6'` (1.2.0 went v2 to v5 when it added battle.js and chat.js).
- `cache.addAll` is all-or-nothing. If any `SHELL` URL is not a 200 for an unauthenticated remote request, the install fails silently (`register(...).catch(()=>{})`) and the old worker stays. Ship the allowlist change in the same deploy. This is why `/mobile/pair` (403 remotely) is not in `SHELL`.
- Entries are keyed by full URL, so a page opened with a query string is cached with that query, tokens included.

## 6. Manifest and iOS meta tags

`manifest.webmanifest` (same in both trees):
```json
{"id":"/mobile/","name":"WANNA Live FX","short_name":"WANNA FX","description":"המצלמה והאפקטים שלך, מחוברים לפאנל WANNA הקיים.","lang":"he","dir":"rtl","start_url":"/mobile/","scope":"/mobile/","display":"standalone","background_color":"#111019","theme_color":"#111019","orientation":"portrait","icons":[{"src":"/mobile/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any"},{"src":"/mobile/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any maskable"}]}
```
- No `shortcuts`.
- `test/mobile.test.mjs:30-36` asserts `display==='standalone'`, `scope==='/mobile/'`, `start_url==='/mobile/'`, icon pixel sizes, a 180 px apple-touch-icon, and that index.html contains `apple-mobile-web-app-capable` and `playsinline`.

Head of `index.html:1`:
```html
<html lang="he" dir="rtl"><head><base href="/fx/"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#111019"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="WANNA FX"><meta name="description" content="פאנל האפקטים של WANNA, עכשיו בטלפון."><link rel="manifest" href="/mobile/manifest.webmanifest"><link rel="apple-touch-icon" href="/mobile/apple-touch-icon.png"><link rel="icon" href="/mobile/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/mobile/app.css"><link rel="stylesheet" href="/mobile/workspace.css">
```
- `<base href="/fx/">` exists only in index.html, for the effects engine's relative assets. Do not copy it into live.html.
- The three `apple-mobile-web-app-*` metas are only in index.html. `manage.html` has viewport, theme-color, manifest and apple-touch-icon. `viewer.html` has viewport, theme-color and manifest. `pair.html` has a plain viewport and app.css only.

## 7. CSS design tokens

`app.css:1`:
```css
:root{color-scheme:dark;--bg:#111019;--panel:#1c1a29;--line:#353044;--text:#f6f3ff;--muted:#a5a0b8;--purple:#b58bff;--mint:#c6f2d8;--pink:#ff6a96;font:16px "Segoe UI",Arial,sans-serif}
```
`workspace.css` defines no variables. There are no web fonts.

Resets:
```css
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}button,input,a{font:inherit}button,a{-webkit-tap-highlight-color:transparent}a{color:inherit;text-decoration:none}button{cursor:pointer;color:inherit}button:disabled{opacity:.4;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--mint);outline-offset:3px}[hidden]{display:none!important}
```

**RTL.** `<html lang="he" dir="rtl">` on every page. Latin parts use `dir="ltr"` in markup or `direction:ltr` in CSS (`.brand-icon`, `.eyebrow`, `.number`, `.test-stats strong`, `.record-badge b`).

**Buttons.**
```css
.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;border:1px solid var(--line);border-radius:11px;padding:11px 17px;background:none;font-size:13px;font-weight:600}.button.primary{background:var(--purple);color:#20152f;border-color:var(--purple)}.button.subtle{background:#282337}
.tool-button{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;background:#201c2d;border:1px solid var(--line);border-radius:10px;padding:13px 2px;font-size:20px;min-height:72px;color:#d9cfe8}.tool-button.active{color:var(--mint);border-color:#5d8f74;background:#20332a}.tool-button.recording{color:var(--pink);border-color:#945274;background:#3b2434}
```
- Also `.round-button` (35×35, radius 9).
- From workspace.css: `.broadcast-on{color:#ff85a5!important;border-color:#d85580!important}`, `.broadcast-controls`, `.actions`, `.server-flag{font-size:11px;color:var(--mint);line-height:1.8;margin-top:10px}`.

**Blocks to reuse.**
```css
.status{font-size:12px;color:#c9b8ee;display:flex;gap:7px;align-items:center}.status:before{content:"";width:6px;height:6px;background:currentColor;border-radius:50%}.status.ok{color:var(--mint)}
.card{border:1px solid var(--line);border-radius:15px;background:var(--panel);padding:23px;margin-bottom:18px}
.stage{position:relative;width:100%;aspect-ratio:9/16;background:#08080e;border:1px solid #343043;border-radius:18px;overflow:hidden;max-height:72vh}.stage canvas{display:block;width:100%;height:100%;object-fit:contain}
.toast{position:fixed;z-index:10;bottom:max(24px,env(safe-area-inset-bottom));right:50%;transform:translateX(50%);background:#332443;border:1px solid #795593;border-radius:12px;color:#f4eafa;padding:15px 21px;font-size:14px;line-height:1.6;max-width:90vw;width:max-content;box-shadow:0 7px 35px #0008}
```
- Also `.camera-placeholder`, `.camera-symbol`, `.preview-label`, `.record-badge`, `.connection-strip` (`i.on` is the mint dot), `.eyebrow`, `.muted`, `.intro`, `.pair-card`, `.pair-row`, `.privacy-note`.
- `.stage` styles only a `canvas` child. A `<video>` preview needs its own rule; workspace.css has `.server-video{width:100%;max-height:72vh;background:#060609;border-radius:15px}`.

**Radii:** 5 to 20 px (button 11, card 15, stage 18, dialog 20, toast 12, inputs 9 to 12).

**Breakpoints:** 900 px and 700 px in app.css, `@media(display-mode:standalone)` at `app.css:4`, 750 px in workspace.css.

**Header markup** (`index.html:2`): `<header><a class="brand" href="/mobile/"><span class="brand-icon">W<span>•</span></span><span dir="ltr">WANNA <b>FX</b><small>MOBILE STUDIO</small></span></a>…</header>`.

## 8. viewer.html / viewer.js

It is the "server player" (`נגן השרת`): it plays back what the gateway received from a phone. `viewer.html` has `<select id="stream">`, `<p id="viewer-state">`, `<video id="server-video" class="server-video" controls playsinline autoplay muted>` and `<button id="load-stream">טען נגן</button>`.

`viewer.js` (5 lines):
- `:2` `refresh()` fetches `/api/workspace/overview` (401 gives `'נדרש צימוד למחשב.'`), keeps `data.broadcasts.filter(s=>s.mode==='preview'||s.mode==='record')`, fills the select. It runs at load and every 4000 ms (`:5`).
- `:3-4` `play()`:
```js
if(stream.mode==='record'){video.src='/api/workspace/broadcast/'+stream.id+'/files/recording.mp4';return;}const response=await fetch(stream.playback,{cache:'no-store'});if(!response.ok){status.textContent='השרת עדיין מכין את מקטעי הווידאו הראשונים. נסה שוב בעוד כמה שניות.';return;}
current=stream.id;hls?.destroy();hls=null;if(video.canPlayType('application/vnd.apple.mpegurl'))video.src=stream.playback;else{const {default:Hls}=await import('https://cdn.jsdelivr.net/npm/hls.js@1.6.15/+esm');if(!Hls.isSupported()){status.textContent='הנגן אינו נתמך בדפדפן הזה.';return;}hls=new Hls({lowLatencyMode:true,liveSyncDurationCount:2});hls.loadSource(stream.playback);hls.attachMedia(video);}video.play().catch(()=>{});status.textContent='מנגן את הווידאו שהתקבל בשרת.';
```
- Native HLS where the browser supports it, otherwise hls.js 1.6.15 loaded from jsDelivr at runtime.
- Playback starts only on the button or a select change.
- The viewer does not register the service worker.

## 9. Who talks to overview, status and SSE

**`/api/workspace/overview`** (`lib/mobile-workspace.mjs:81`) returns `{config,clients,recipes,jobs,templates,avatars,broadcasts}`. `broadcasts` lists every owner's streams.
- `render.js:17`, `refresh()`: every 8000 ms (`:88`) and on each `setAuth(true)`, which fires on every 12 s session check.
- `render.js:86`: every 2000 ms while a broadcast exists.
- `manage.js:17`: at load, after each mutation, every 5000 ms when visible (`:57`).
- `viewer.js:2`: every 4000 ms.
- A lighter `GET /api/workspace/config` exists (`mobile-workspace.mjs:80`); no client file uses it.

**`/api/mobile/status`:** not found. `/api/mobile/session` is the equivalent and only `app.js:32` calls it.

**SSE:** exactly one EventSource, and no WebSocket anywhere in public/mobile. `app.js:135`:
```js
function connectEvents(){eventSource?.close();if(!session?.authenticated)return;eventSource=new EventSource('/api/mobile/events');eventSource.onmessage=event=>{try{applyStage(JSON.parse(event.data));}catch{}};}
```
- The gateway proxies it to the studio server's `/api/stage-events` (`mobile-gateway.mjs:102`) with a 180 s upstream socket timeout (`:34`).
- The upstream (`server.mjs:334-336`) sends one `data:` snapshot on connect and then only on changes; there is no heartbeat.
- There is no `onerror` handler. It is opened at boot and after pairing, closed on logout.

**Other calls.**
- `app.js`: `/api/mobile/pair`, `/api/mobile/screen`, `/api/mobile/stop`, `/api/mobile/effects`, `/api/mobile/catalog`, `/api/mobile/frame` (JPEG probe every 500 ms while testing), `/api/mobile/audio-test`, `/api/mobile/logout`, dynamic `import('/fx/fx-engine.js')`.
- `render.js`: `commands?after=N` every 800 ms when authenticated and visible (`:87`), `broadcast/start`, `broadcast/<id>/chunk`, `broadcast/<id>/stop`, `/api/mobile/effects`.
- `battle.js:23`: `/api/workspace/tiktok` every 2000 ms.
- `chat.js:31,46`: `/api/workspace/tiktok/provider`.
- `pair.js`: `/api/mobile/public-url` every 4000 ms, `POST /api/mobile/pairing-code`.
- `manage.js`: `clients`, `recipes`, `upload`, `play`, `generate`, `balance`, `automations`, `test-event`, `tiktok`, `tiktok/connect`, `tiktok/disconnect`, `rtmp`, `rtmp/import`, `video-models`, `templates`, `/api/mobile/catalog`.

## 10. Hebrew strings in use (verbatim)

**Server state** (`#server-state`):
- `מתחבר לשרת` · `מחובר לשרת האפקטים` · `שרת האפקטים לא זמין` · `נדרש צימוד` · `אין חיבור לשרת` · `אין רשת`
- manage: `מתחבר` / `מחובר לשרת` / `נדרש צימוד`
- `#server-details`: `ממתין לבדיקה`, `'שרת האפקטים מחובר · '+N+' אפקטים חיים'`

**Pairing:**
- `מחברים את הטלפון לשרת` · `הזן את הקוד שמוצג במסך הצימוד במחשב.` · `קוד צימוד` · `חיבור לשרת`
- `הטלפון מחובר לפאנל שלך.` · `המתן דקה לפני ניסיון נוסף.` · `הקוד שגוי או פג תוקף. צור קוד חדש במסך הצימוד במחשב.`
- `נדרש צימוד מחדש.` · `נדרש צימוד מחדש למחשב.` · `נדרש צימוד למחשב.` · `פתח מסך חיבור`
- `ניתוק הטלפון מהשרת` · `הטלפון נותק מהשרת.`

**Camera:**
- Button `הפעל מצלמה ומיקרופון`; state `מצלמה פעילה` / `מצלמה כבויה`; tool labels `מצלמה`, `החלף`, `מיקרופון`, `הקלט`, `נקה אפקטים`.
- `המצלמה דורשת פתיחה בקישור HTTPS, ב־Safari או Chrome.`
- `יש לאשר גישה למצלמה בדפדפן.`
- `לא ניתן לפתוח את המצלמה. סגור אפליקציה אחרת שמשתמשת בה ונסה שוב.`
- `הפעל קודם את המצלמה.` / `הפעל קודם מצלמה.` · `עצור את ההקלטה לפני החלפת מצלמה.`
- `תצוגה מקדימה` · `PREVIEW · לא משודר לטיקטוק` · `הבמה שלך מחכה`
- `מצלמה ומיקרופון פועלים בחיבור HTTPS. השאר את האפליקציה פתוחה בזמן הצילום.`

**Microphone:**
- `המצלמה פעילה ללא מיקרופון. אפשר לאשר הרשאה בהגדרות הדפדפן.`
- `המיקרופון פעיל.` / `המיקרופון מושתק.`
- `בדוק מיקרופון` · `מיקרופון לשרת` · `בדיקת המיקרופון לא הושלמה.`
- `השתק קול אפקטים` / `הפעל קול אפקטים`

**Sending to the server:**
- Buttons: `שלח וידאו לשרת` · `שדר ל־RTMP` · `עצור שידור`
- `#server-stream-state`:
  - `בודק את יכולות השרת.`
  - `שידור לשרת זמין · יעד RTMP שמור · עלייה ל־TikTok טרם אומתה`
  - `שידור לשרת זמין · חסר יעד RTMP לשידור חיצוני`
  - `כלי הווידאו בשרת אינם זמינים.`
  - `ממתין לאישור יציאת וידאו מהמקודד`
  - `המקודד מפיק וידאו לנגן השרת`
  - `המקודד שולח וידאו ליעד RTMP · הופעה ב־TikTok עדיין דורשת אימות`
  - suffix `' · התקבלו '+X+' MB'`
  - `'השידור נעצר: '+(s.error||s.state)`
  - `החיבור לשרת אבד. השידור נעצר.`
- Toasts:
  - `מתחבר לשרת וממתין לאישור יציאת וידאו.`
  - `החיבור איטי מדי. שידור הווידאו נעצר.`
  - `השרת לא אישר את מקטע הווידאו. השידור נעצר.`
  - `השידור נעצר בשרת. בדוק את החיבור ויעד השידור.`
  - `הדפדפן אינו תומך בהעברת וידאו.`
  - `לא ניתן להתחיל העברת וידאו. בדוק את כלי הווידאו בשרת.`
- `#preview-label` (English): `PREVIEW`, `CONNECTING`, `SERVER OUTPUT`, `RTMP OUTPUT`.
- Viewer:
  - `ממתין לשידור. במסך המצלמה בחר ״שלח וידאו לשרת״.`
  - `ממתין לשידור מהטלפון.`
  - `מנגן את הווידאו שהתקבל בשרת.`
  - `לא ניתן לטעון את השידור כרגע.`

**Vocabulary and style:**
- `צימוד` = pairing, `שרת האפקטים` = the :8800 server, `מקודד` = encoder, `מקטע` = chunk, `דגימה` = probe sample, `נגן השרת` = viewer, `שידור` = sending/broadcast, `לייב` = TikTok LIVE.
- Masculine-singular imperatives (`הפעל`, `בדוק`, `עצור`, `פתח`); toasts end with a period.
- Maqaf before Latin words (`ל־RTMP`, `ב־TikTok`), `·` as separator, `…` for progress, ״…״ around UI labels, English uppercase eyebrows.

## 11. Diff against the old running copy: what 1.2.0 changed

Method: CRLF normalised, then a token-level diff.

**Unchanged:** `pair.html`, `viewer.html`, icons, `icon.svg` (byte-identical); `audio.js`, `manifest.webmanifest`, `pair.js`, `viewer.js`, `workspace.css` (identical after line-ending normalisation).

**New files:**
- `battle.js`: `mountBattle(root)`, a TikTok battle telemetry panel polling `/api/workspace/tiktok` every 2 s.
- `chat.js`: `mountChat(root)`, chat and activity feed, optional speech, event-provider form.

**Changed files:**
- `app.js`: two additions only, `import {mountBattle} from '/mobile/battle.js';` (`:1`) and `mountBattle(document.getElementById("live-battle"));` (`:197`). Camera, mic, recording and boot code are identical.
- `index.html`: adds `<section id="live-battle" class="card battle-panel" style="margin-bottom:18px"></section>` before `.studio-grid`.
- `manage.html`: adds the `#live-battle` div and the `#import-rtmp` button (`ייבא מפתח מהמחלץ המקומי`); a few copy edits.
- `manage.js`: imports and mounts the battle panel; three `LOCAL_RTMP_CAPTURE_*` messages; `#import-rtmp` calls `POST rtmp/import`.
- `sw.js`: `wanna-fx-mobile-v2` becomes `v5`; `SHELL` gains `/mobile/battle.js` and `/mobile/chat.js`. Logic unchanged.
- `app.css`: only appended blocks (`.battle-*` on line 6, `.live-chat*` on line 7). `:root` unchanged.
- `render.js`, the one substantive change:
  - `broadcastStarting` re-entrancy guard.
  - New `showBroadcastStatus(s)` driven by `outputConfirmed`. Old text was `'השרת קיבל '+MB+' MB · '+ack.sequence+' מקטעים'`.
  - Overview no longer overwrites the status line during a broadcast (`if(!broadcast&&!failed)`).
  - `pending--` fix on overflow.
  - Orphan stop in the start `catch`.
  - New 2 s status poll with a 3-failure cut-off.
  - Start toast is now `מתחבר לשרת וממתין לאישור יציאת וידאו.`

**Server pieces that move with it:**
- Gateway allowlist gains `battle.js` and `chat.js`; version `1.1.0` becomes `1.2.0`; `platform.tiktokConnected` / `battlesConnected` are real instead of `false`.
- `lib/mobile-broadcast.mjs`:
  - New `starting` state and `outputConfirmed` / `outputFrames` / `lastOutputAt`.
  - `OUTPUT_TIMEOUT` (60 s) replaces the old one-hour `SESSION_LIMIT`. Old `:8`: `Date.now()-s.startedAt>3600000)void this.stop(s.id,s.owner,'SESSION_LIMIT')`.
  - The 2-stream limit now counts starting, running and stopping.
  - The `diagnostic` field is gone.
- `lib/mobile-workspace.mjs`: adds `tiktok/provider` GET/PUT and `rtmp/import`. Broadcast routes are unchanged.

**The two hunks only in the old copy** (confirmed):
- Old `mobile-gateway.mjs`, before the `try` in the request handler:
```js
{const o=req.headers.origin;if(o&&req.method==='GET'&&/^http:\/\/(localhost|127\.0\.0\.1):8800$/.test(o)){res.setHeader('Access-Control-Allow-Origin',o);res.setHeader('Vary','Origin');}}
```
- Old `fx/index.html:127-149`, `useServer()`:
  - Polls `http://127.0.0.1:8801/api/workspace/overview` (or `localhost`).
  - Takes the newest broadcast with `mode==='preview' && state==='running'`.
  - Plays `base + s.playback` through hls.js with `video.muted = true`.
  - Returns after attaching.
  - Wired at old `:229`: `else if (qs.get('src') === 'server') useServer();`.
- In the repo, `fx/index.html:205` sends any other `src` value to `useSrc(...)`, so `?src=server` is treated as a file URL.

## 12. Checklist for adding live.html and live-capture.js

1. **Allowlist** (`mobile-gateway.mjs:67`): add `'live.html','live-capture.js'`. For the extensionless style used by manage and viewer, add next to `:63-65`: `if(name==='live'||name==='live/')name='live.html';`.
2. **live.html head:** copy the index.html head without `<base href="/fx/">`. Keep `lang="he" dir="rtl"`, the `viewport-fit=cover` viewport, theme-color `#111019`, manifest, apple-touch-icon, `/mobile/app.css` (plus `/mobile/workspace.css` for `.broadcast-on`, `.server-flag`, `.actions`), and `<script type="module" src="/mobile/live-capture.js">`. Include `<div id="toast" class="toast" role="status" hidden></div>`.
3. **Do not import render.js or app.js.** Both bind to index.html element ids at load (`render.js:21`: `el('active-client').onchange=setClient;`) and would throw on another page. The broadcast code is not exported, so re-implement the protocol from section 3: start with `{mode:'preview',mime}`, post serial `x-sequence` chunks, stop. `audio.js` is safe to import.
4. **Auth:** call `GET /api/mobile/session` first. On 401 show the pair form (`POST /api/mobile/pair {code,label}`) or link to `/mobile/`. Handle 401 on chunk posts too, since a gateway restart drops sessions.
5. **Keep the existing habits:** `cache:'no-store'`, `AbortSignal.timeout`, wake lock on start and re-acquire on `visibilitychange`.
6. **Add what the current client lacks:** stop the broadcast on `pagehide`, and read the start error code so `BROADCAST_LIMIT`, `MEDIA_TOOLS_REQUIRED` and `PAIRING_REQUIRED` can be told apart.
7. **sw.js:** optional, as in section 5.
8. **For the program page to consume the phone:** port both old-copy hunks from section 11.
9. **Tests to extend:** `test/mobile.test.mjs` (static route and manifest assertions); the Playwright flows `test/mobile-browser.py` and `test/workspace-browser.py` (fake camera and mic, run through `test/run-browser.mjs` on ports 18880/18881).

## GOTCHAS
- The blocker for a new page is the gateway, not the service worker: mobile-gateway.mjs:67 serves /mobile/ from a hard-coded filename allowlist, so /mobile/live.html and /mobile/live-capture.js return 404 {error:'NOT_FOUND'} until added. An extensionless /mobile/live also needs an alias next to lines 63-65.
- The service worker cannot hide a new file: it only intercepts exact pathnames in SHELL and is network-first even for those. But if you add the new URLs to SHELL, cache.addAll is all-or-nothing; one URL that is not a 200 for an unauthenticated remote request makes the whole install fail silently and the old worker stays.
- The CSP on every /mobile/ file forbids inline scripts and inline event handlers, limits fetch to the gateway origin (plus cdn.jsdelivr.net and storage.googleapis.com), and sets frame-ancestors 'self'. With Permissions-Policy camera=(self), microphone=(self), the capture page cannot be embedded in a Vardyverse iframe and cannot call Vardyverse directly; it must be a top-level page on the gateway origin.
- render.js and app.js cannot be imported into another page: they bind to index.html element ids at load (render.js:21 el('active-client').onchange=...) and would throw. startBroadcast and enqueue are private closures, so the upload protocol has to be re-implemented or refactored out.
- index.html carries <base href="/fx/"> for the effects engine. Copying that head into live.html would resolve every relative URL against /fx/.
- /api/mobile/status does not exist. The status call is GET /api/mobile/session, which returns 401 {error:'PAIRING_REQUIRED'} when unpaired. There is no client-side pairing redirect, only an inline pair card.
- Auth is an in-memory session cookie (wm_sid, HttpOnly, SameSite=Strict, 12 h). Any gateway restart signs out every phone, and pairing needs an 8-digit code that can only be generated on the PC's local page. The built-in tunnel is a trycloudflare quick tunnel, which normally gets a new hostname each start; that would also orphan the cookie and any installed PWA.
- What the existing flow sends is a canvas capture, not the camera track: mirrored for the front camera, fixed 720x1280 (or 1080x1920), with a mixed mic-plus-effects audio track. A thin client that records the raw camera track would not be mirrored, and (general browser behaviour, not tested here) its frame size would follow device rotation and a camera flip would end the recorded track.
- Back-pressure means abort: more than 8 queued one-second chunks, or 3 failed attempts on one chunk (20 s timeout each, no delay), stops the whole broadcast. Nothing auto-restarts. The server also stops after 60 s without input or without encoder output, and allows only 2 concurrent broadcasts for the whole gateway.
- Nothing stops or pauses a broadcast when the page is hidden or closed (no pagehide/beforeunload). A closed tab leaves an orphan for up to 60 s that still counts toward the limit of 2. Canvas drawing runs on requestAnimationFrame, which browsers suspend for hidden pages.
- The old running copy is 1.1.0 on the broadcast side: lib/mobile-broadcast.mjs:8 force-stops every broadcast after one hour (SESSION_LIMIT) and has no outputConfirmed. The repo's render.js expects the 1.2.0 fields, so client and server files must come from the same version.
- The program-page consumer exists only in the old copy (useServer in fx/index.html plus a GET-only CORS header in the gateway). It plays the HLS with video.muted = true, so the phone's microphone is not audible on the Windows machine, and it attaches once and never re-attaches if the phone restarts its broadcast. In the repo, ?src=server falls through to useSrc('server').
- Latency of this path is built in and was not measured: 1 s MediaRecorder chunks, ffmpeg transcode, 2 s HLS segments, and a player that sits 2 segments behind. Expect several seconds.
- Broadcast mime preference is WebM/VP8+Opus first with MP4/H.264 as fallback, the reverse of local recording. Which one a given iPhone picks, and whether its output survives the ffmpeg stdin pipe, has not been verified on a device; MOBILE.md itself says physical devices must be checked.
- Camera and microphone are requested in two separate getUserMedia calls, video first. A mic denial degrades to video-only with one toast; a camera denial means the mic is never requested.
- app.js line 192 is a top-level await (session check, then catalog load). The handlers on lines 193-197 attach only after it resolves, so do not copy that ordering.
- The existing client assumes a recent browser: AbortSignal.timeout, top-level await, replaceChildren, ||= and crypto.randomUUID are all used unguarded. If AbortSignal.timeout is missing, checkSession lands in its catch and shows 'אין חיבור לשרת' permanently.
- test/mobile.test.mjs asserts manifest start_url === '/mobile/', scope === '/mobile/' and display === 'standalone'. Making the live page the home-screen target needs a shortcuts entry or a second manifest (itself allowlisted), not an edit to those fields.
- The index page is chatty when idle: session every 12 s, overview every 8 s and on every session check, commands every 800 ms, TikTok state every 2 s, plus one SSE stream. /api/workspace/overview returns all clients, recipes, jobs and templates. A thin client can use /api/workspace/config for capabilities and the chunk acks for status.
- /api/workspace/overview lists every owner's broadcasts without an owner field, while chunk and stop are owner-bound (404 for other sessions). A client cannot tell which listed stream is its own except by the id it received from broadcast/start.

## OPEN QUESTIONS
- How should a phone be authorised for a true one-tap start? Today the only path is the 8-digit pairing code generated on the PC's local page, with a 12-hour in-memory session. Nothing ties a session to the Vardyverse creator / t parameters.
- How does the phone's microphone reach TikTok LIVE Studio? The only existing consumer (useServer in the old copy) plays the HLS muted. Should the program page play it unmuted (Chrome autoplay policy on the Windows machine), or should audio take another route?
- Should the capture page send the raw camera track, or a plain 2D canvas (mirrored, fixed 720x1280, flip-safe) as the existing flow does? What does the program page's cut-out expect for mirroring, orientation and resolution?
- Is several seconds of latency (MediaRecorder to ffmpeg to HLS) acceptable for the LIVE, or is a low-latency transport needed? The gateway has no WebSocket or WebRTC endpoint today.
- Which copy will serve port 8801 when this ships: the repo (1.2.0) or the old running copy (1.1.0 broadcast code with the one-hour SESSION_LIMIT)? The new files, the allowlist edit and the two unported hunks must all land in the same tree.
- Will phones get a stable HTTPS origin (named tunnel or domain) instead of the trycloudflare quick tunnel?
- Has MediaRecorder output from a physical iPhone been proven through this ffmpeg stdin pipeline? Tests only use Chromium with a synthetic camera and microphone.
- Should the live page be its own home-screen app (separate manifest and start_url, needing an allowlist entry) or a shortcut inside the existing WANNA FX PWA? Should it register the service worker itself for phones that never opened /mobile/?
- Is one phone per Windows server guaranteed? useServer picks the newest running preview broadcast regardless of owner, and the server allows 2 concurrent broadcasts.
- Should the thin client reuse /api/workspace/broadcast/* with mode 'preview' as-is, or get a dedicated mode or endpoint so it does not share the 2-stream limit and the viewer list with the effects page?
- Should pair.html / pair.js, which today show only publicUrl + '/mobile/', also present the new capture URL, for example as a QR code? No QR code exists in public/mobile.
