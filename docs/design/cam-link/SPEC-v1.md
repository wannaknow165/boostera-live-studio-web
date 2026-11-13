# CAM LINK v1 — implementation specification (binding)

Decided by the lead after three adversarial critiques (see `critique-media-network.md`, `critique-security.md`,
`critique-product-ops.md` in this folder; the six `map-*.md` files are the verified code/platform maps).
Where a critique and this spec disagree, THIS SPEC WINS. If the spec is silent, follow the critiques' consensus.

## 0. What v1 is
The creator's phone is a thin capture client: ONE tap takes camera + microphone and sends them, peer-to-peer over
WebRTC, to the "program page" (Chrome on our server). The gateway only relays signalling. All composition (cut-out,
wall, effects) stays on the program page. v1 is proven on a LAN test bed (Android phone on the same Wi-Fi, signalling
through `adb reverse`) and must be correct by design for an iPhone over HTTPS later.

NOT in v1 (do not build): tickets/bearer auth, CORS for Vardyverse, iframe embedding headers, TURN credential
minting, automatic HLS fallback, a return monitor feed, camera flip, PWA manifest/service worker for the new page,
any edit to the shared `fx/fx-engine.js`, porting the old `useServer()` / `src=server` hunk.

## 1. Names (the word "live" is NOT used for this feature)
- Gateway routes: `/api/link/*` · hub module: `lib/cam-link.mjs` · tests: `test/cam-link.test.mjs`
- Phone page: `public/cam/index.html`, `public/cam/cam-link.js`, `public/cam/cam.css` served at `/cam/`
- Operator page: `public/cam/ops.html` + `public/cam/ops.js` served at `/cam/ops` (loopback only)
- Program receiver: `fx/link-receiver.js` (+ small hooks in `fx/index.html`), program source value `src=live`
- Launcher: `start-link.mjs` (+ `start-link.cmd`) · doc: `LINK.md`
- Version becomes `1.3.0` in the three places that carry `1.2.0` (package.json:3, mobile-gateway.mjs session payload,
  lib/mobile-workspace.mjs:47). `start-mobile.mjs` keeps working (`version.startsWith('1.')`).

## 2. Settings (read ONLY from the `env` object passed to `createMobileGateway`, never `process.env`)
- `LINK_DEV` = `1` → development mode: (a) capture routes accept the loopback "local" identity, (b) the program key
  is not required. Default off.
- `LINK_PROGRAM_KEY` (secret, optional). If absent the gateway creates 24 random bytes (hex) at start and writes
  `runtime/link-program.key` under the workspace root (git ignores `runtime/` and `*.key`). Never returned by any route.
- `LINK_ICE_SERVERS` = JSON array of RTCIceServer (default `[]`, host candidates only). Each `urls` entry must match
  `^(stun|turns?):[a-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$`; invalid JSON or entry → `[]` and one log line.
- Names go into `server.env.example` (plain) / `.env.example` (secret). No value is ever logged or returned.

## 3. Auth
- Capture routes (`/api/link/status`, `/api/link/whip*`, `/api/link/state`): identity = the paired session
  (`sessions.get(cookies(req).wm_sid)`, id = that session's id) OR, only when `LINK_DEV=1`, the loopback local
  identity (`id:'local-desktop'`). Otherwise 401 `{error:'PAIRING_REQUIRED'}`. These routes send NO CORS header.
  Because the hook sits above the gateway's global origin check, capture POST/DELETE must themselves refuse a
  foreign origin exactly like `sameOrigin()` does (403 `ORIGIN_REJECTED`), and must refuse the program origins.
- Program routes (`/api/link/program/*`): ALL of: `localRequest(req,port)` true; `Origin` header exactly
  `http://127.0.0.1:<upstreamPort>` or `http://localhost:<upstreamPort>` (every method, GET included; missing or other
  → 403 `PROGRAM_ORIGIN_REQUIRED`); header `X-Link-Program-Key` equal (timingSafeEqual after length check) to the
  program key unless `LINK_DEV=1` (→ 403 `PROGRAM_KEY_REQUIRED`). Exception: `POST /api/link/program/bye` needs no
  key (sendBeacon cannot set headers) but still needs local + Origin.
- CORS exists ONLY on `/api/link/program/*` and only for those two origins: on success, error and preflight send
  `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`; preflight (`OPTIONS`) → 204 with
  `Access-Control-Allow-Methods: GET, POST`, `Access-Control-Allow-Headers: Content-Type, X-Link-Program-Key`,
  `Access-Control-Max-Age: 600`. Never `Allow-Credentials`. Every other OPTIONS stays 405, and no other route gains
  any `Access-Control-*` header (existing tests mobile.test.mjs:61 and :74 must stay green).
- Operator route `GET /api/link/ops` and page `/cam/ops`: `localRequest` only (403 `LOCAL_SETUP_ONLY` otherwise).
- Authenticate BEFORE reading any body. Own body readers: JSON routes need `Content-Type: application/json`
  (415 `JSON_REQUIRED`), cap 2048 bytes for state routes and 65536 for `program/answer`; whip needs
  `Content-Type: application/sdp` (415 `SDP_REQUIRED`), cap 65536 (413 `BODY_TOO_LARGE`).

## 4. Phone-facing API
### GET /api/link/status?attempt=<id>
200:
```json
{"version":"1.3.0","serverTime":0,"iceServers":[],
 "program":{"online":true,"ready":true,"throttled":false},
 "link":{"state":"idle","mine":false,"since":0,"echoAgeMs":null,
         "stats":{"w":0,"h":0,"fps":0,"kbps":0,"rttMs":0,"lossPct":0},
         "audio":{"wanted":false,"playing":false,"level":0},
         "path":null,"lastError":null},
 "air":{"known":false,"live":false}}
```
- `link.state`: `idle | negotiating | connected | stalled | lost` (from the program echo; `negotiating` while an
  attempt is pending). `link.mine` = the current attempt belongs to the caller's clientId (header `X-Link-Client`) or
  equals `?attempt=`. Never expose SDP, candidates, IPs, the attempt id of another client, or free-form strings from
  the program (stats are clamped numbers; `path` is `{local,remote,protocol}` with values limited to
  `host|srflx|prflx|relay` and `udp|tcp`; `lastError` is one of the UPPER_SNAKE codes in this spec).
- `program.online` = a poll is parked OR the lease holder's last poll ended < 3 s ago. `program.ready` = the page
  reported state other than `loading`. `program.throttled` = last reported `rafHz < 10` or `hidden:true`.
- `air` comes from an injected function; in the gateway: `known` = a TikTok event connection exists,
  `live` = `workspace.live.state.status==='connected'`.
### POST /api/link/whip
Headers: `Content-Type: application/sdp`, `X-Link-Client: <uuid, per page load>`, `X-Link-Attempt: <uuid, per
attempt>`, optional `X-Link-Takeover: 1` (only sent from inside the tap handler). Body: the offer SDP — a string of
200..60000 chars starting with `v=0`, at most 3 `m=` lines and at most 40 `a=candidate:` lines, else 400 `SDP_INVALID`.
- No program online → 503 `PROGRAM_OFFLINE` immediately (after auth, nothing parked).
- Another clientId holds a link that the program reported `connected` within the last 10 s and no takeover header →
  409 `LINK_REPLACED` (the caller must stop retrying and offer a "bring it back here" button, which sends takeover).
- Otherwise the attempt becomes current (a previous pending attempt's parked request is answered 409 `REPLACED`,
  and the program gets a `stop` for a previously connected attempt), an `offer` message is queued for the program,
  and the request parks up to 8 s: answer → 201, `Content-Type: application/sdp`, `Location:
  /api/link/whip/<attemptId>`, body = answer SDP; no answer → 504 `PROGRAM_TIMEOUT`.
- Same `X-Link-Attempt` posted again → the stored result (idempotent). One offer in flight per identity
  (429 `OFFER_IN_FLIGHT`), at most 10 offers per minute per identity (429 `OFFER_RATE_LIMIT`).
### DELETE /api/link/whip/<attemptId>  and  POST /api/link/whip/<attemptId>/bye
Stop. Idempotent, 200 `{ok:true}`; unknown id → 404 `ATTEMPT_UNKNOWN`. Queues `stop` (reason `client_stop`) for the
program. `/bye` exists for `fetch(...,{keepalive:true})` / `sendBeacon` on pagehide.
### POST /api/link/state
JSON ≤ 2 KiB: `{attempt, video:'live'|'muted'|'ended', audio:'live'|'muted'|'ended', visible:boolean,
stats:{w,h,fps,kbps,rttMs,codec,encoder,limit}}` (unknown keys dropped; strings ≤ 40 chars from a fixed alphabet
`[A-Za-z0-9 ._/-]`). Queues a `capture` message for the program when video/audio/visible changed. 200 `{ok:true}`.

## 5. Program-facing API (loopback + Origin + key, see §3)
### GET /api/link/program/poll?program=<pageId>&after=<seq>&takeover=0|1
Long-poll, 25 s (the wait is injectable for tests). `pageId` 1..40 chars `[A-Za-z0-9_-]`.
- Lease: the first pageId owns the program slot while it was seen within the last 10 s (or has a parked poll). The
  same pageId re-polling replaces its own parked poll (the older one gets 204). A different pageId: with
  `takeover=1` it takes the lease and the old holder's parked poll is answered 410 `PROGRAM_SUPERSEDED` (that page
  must stop for good); without it → 409 `PROGRAM_BUSY` (the page retries every 5 s and logs once).
- Messages are an ordered queue with a monotonically increasing `seq`; `after` acknowledges everything ≤ after. The
  poll returns the oldest unacknowledged message (200) or 204 after the wait. Offers are NOT consumed by delivery:
  they stay deliverable until answered, replaced or 10 s old. Queue cap 20.
  - `{seq,type:'offer',attempt,sdp,iceServers,client:{label}}`
  - `{seq,type:'stop',attempt,reason:'client_stop'|'replaced'|'expired'}`
  - `{seq,type:'capture',attempt,video,audio,visible}`
### POST /api/link/program/answer   `{program, attempt, sdp}`
Only from the lease holder and only for the current, unanswered attempt: 200 `{ok:true}`; identical repeat → 200
`{ok:true,repeated:true}`; otherwise 409 `STALE_ATTEMPT`; phone request already closed → 410 `CLIENT_GONE` (use
`res.on('close')` + `!res.writableEnded` on the parked whip response). SDP validated as in §4.
### POST /api/link/program/state   (≤ 2 KiB)
`{program, attempt|null, state:'loading'|'idle'|'answering'|'connected'|'stalled'|'lost', showing:'webrtc'|'slate',
stats:{w,h,fps,framesDecoded,freezeCount,jitterMs,kbps,rttMs,lossPct,rafHz,drawHz,pcCreated,vw,vh,dpr},
hidden:boolean, audio:{wanted,playing,level,sink}, path:{local,remote,protocol}}` — numbers clamped, unknown keys
dropped. From the lease holder only. Soft state: if the hub does not know `attempt` (gateway restarted) it ADOPTS it
as the current connected attempt. 200 `{ok:true}`.
### POST /api/link/program/bye?program=<pageId>   → releases the lease at once. 200.
### GET /api/link/ops   (loopback only)
Everything above plus `build:{version,root,startedAt}`, the lease `{pageId,lastSeenAt}`, the last 50 hub events
`{at,type,detail}` (no SDP, no keys, no IPs). The hub also appends each event as one JSON line to
`runtime/link.log` through an injected `log` function.

## 6. Hub (`lib/cam-link.mjs`)
`export function createCamLink({env={},port,upstreamPort,root,version,now=Date.now,timers={setTimeout,clearTimeout},
pollMs=25000,answerMs=8000,log=()=>{},air=()=>({known:false,live:false}),programKey})` →
`{handle(req,res,url,ctx), close(), snapshot()}` where `ctx={local:boolean,paired:session|undefined}` and `handle`
resolves `true` when it answered. It is an explicit state machine, in memory, no I/O except the injected `log`.
`close()` answers every parked response (204 / 503) and clears every timer so `server.close()` never hangs; timers
are unref'd. Never write SDP, keys or cookies to the console or the log.
Gateway hook (the ONLY edits inside mobile-gateway.mjs besides the static block, the version string and
`build:{root,startedAt}` in the session payload): immediately BEFORE the line
`if(['POST','PUT','DELETE'].includes(req.method)&&!sameOrigin(req))...` add
`if(p.startsWith('/api/link/')&&await link.handle(req,res,url,{local:localRequest(req,port),paired:sessions.get(cookies(req).wm_sid)}))return;`
and close the hub in the server `close` handler. Create the hub next to the workspace with
`air:()=>({known:workspace.live.state.status!=='idle'&&workspace.live.state.status!==undefined,live:workspace.live.state.status==='connected'})`
(adapt to the real state values after reading lib/mobile-live-events.mjs).
Static block for `/cam/` (placed with the other static block, before the auth gate): allow-list
`['index.html','cam-link.js','cam.css','ops.html','ops.js']`, aliases `/cam`→302 `/cam/`, `/cam/`→`index.html`,
`/cam/ops`→`ops.html` (loopback only, like `pair.html`), `Cache-Control: no-cache`, CSP
`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
and for these files only `Permissions-Policy: camera=(self), microphone=(self), screen-wake-lock=(self), display-capture=()`.
No manifest link, no service worker, nothing added to `public/mobile/sw.js`.

## 7. Program page (`fx/link-receiver.js` + hooks in `fx/index.html`) — NO edit to `fx/fx-engine.js`
URL parameters for `src=live`: `gw=<gateway base>` (default: same hostname, port = page port + 1, e.g. 8800→8801,
8810→8811, 18880→18881), `program=<pageId>` (default random per load), `takeover=1`, `mirror=1|0` (default 1),
`audio=1` (default off), `sink=<output label substring>`, `adelay=<ms>` (default 0), `jb=<ms>` (default 0),
fragment `#pk=<program key>` (read once, then removed with `history.replaceState`).
Hooks in `fx/index.html` (keep them tiny; CRLF line endings preserved):
1. Start the receiver's hub client right after `const qs = ...`, i.e. BEFORE `await loadAll()` / `await fx.init()`,
   when `qs.get('src')==='live'`; add `else if (qs.get('src') === 'live') { /* receiver already started */ }` above the
   generic `else if (qs.get('src')) useSrc(...)` so `live` is never treated as a file name.
2. Opponent watcher off by default for this source:
   `if (qs.get('opp') === '1' || (qs.get('src') !== 'live' && qs.get('opp') !== '0')) fx.watchOpponent(...)`.
3. Cap the page log at 200 lines (the `log` function near line 86).
4. Security fixes on this page: build the effect button with `textContent` instead of `innerHTML` (near line 139);
   log only `new URL(stageUrl).origin` (near line 104) and do not expose the stage URL on `window.fxStage` (line 110).
Receiver behaviour:
- Normaliser: one canvas `norm` 720x1280 (`getContext('2d',{alpha:false})`), `video.srcObject = norm.captureStream(30)`
  set ONCE (the engine's `#src` element then always sees a constant-size, always-ready input — the same pattern as the
  existing `usePhone()`). A private `<video>` `rx` (muted, playsinline, `position:absolute;width:1px;height:1px;
  opacity:0`, NOT `display:none`) receives `new MediaStream([videoTrack])` only once the video track exists.
- Loop for `src=live`: after the engine has started, `cancelAnimationFrame(fx.raf)` and run the receiver's own
  `requestAnimationFrame` loop that, at most every 31 ms: blits `rx` into `norm` cover-fitted (centre crop; mirrored
  horizontally when `mirror=1`) when the feed is fresh, else keeps the last frame for gaps < 3000 ms and fills black
  after 3000 ms (so segmentation finds nobody and, with a stage, the wall shows alone); then calls
  `fx.frame(performance.now()); fx.postFX();` inside try/catch that logs a given message at most once.
  Verify the real method/field names in fx-engine.js first (`frame`, `postFX`, `raf`, `start`) and adapt.
- Freshness: `framesDecoded` of the inbound video RTP stream rose within the last 1500 ms, read from
  `pc.getStats()` on a 500 ms timer (works when rendering is throttled).
- Hub client: poll loop (never awaits the answer flow); on `offer`: close any previous connection, new
  `RTCPeerConnection({iceServers,bundlePolicy:'max-bundle',rtcpMuxPolicy:'require'})`, `setRemoteDescription(offer)`,
  `createAnswer`, `setLocalDescription`, gather-done rule (first of: `iceGatheringState==='complete'`; at least one
  host candidate seen and 300 ms without a new candidate; 2000 ms), then POST `pc.localDescription.sdp`.
  Not `connected` within 10 s of answering → close and report `lost`. `receiver.jitterBufferTarget = jb` on both
  receivers when supported. Reject (close + state `lost`, lastError `STREAM_REJECTED`) a stream larger than
  1280x720x1.2 pixels or one that changes size more than 5 times in 10 s. On `stop` → close at once → slate.
  On `capture` with video not `live` or `visible:false` → slate after 3 s even if packets still flow.
  On 409 `PROGRAM_BUSY` retry every 5 s; on 410 `PROGRAM_SUPERSEDED` stop for good and log once. Keep at most one
  live connection; count created connections (`pcCreated`); never keep references to closed ones.
- Audio: only with `audio=1`. A dedicated `<audio>` gets `new MediaStream([audioTrack])`; with `sink=` find the
  output device whose label contains the substring (`navigator.mediaDevices.enumerateDevices()`, kind
  `audiooutput`) and `setSinkId`; if `sink=` is given and not found stay silent and report `audio.sink:'no_sink'`
  (fail closed, never the default speakers). `adelay>0` → `MediaStreamAudioSourceNode → DelayNode → destination`
  (keep the stream also on a muted `<audio>`; Chrome needs an element sink for remote WebRTC audio). If `play()` is
  rejected, report `playing:false` (do not show any prompt in the picture) and retry on the first user gesture.
- State echo: POST `/api/link/program/state` every 1000 ms while a connection exists, every 5000 ms when idle;
  `state:'loading'` until the engine is ready. Measure `rafHz` and `drawHz`. In clean mode set
  `document.title='LINK PROGRAM'`. On `pagehide`: `navigator.sendBeacon(gw+'/api/link/program/bye?program='+pageId)`.
- Pure helpers (cover-fit rectangle, freshness decision, gather-done decision, default gateway base, SDP checks)
  must be exported from a file that has no DOM access at load so `node --test` can import it
  (pattern: `fx/stage-url.js` + `test/stage-url.test.mjs`). Put them in `fx/link-core.js`; tests in
  `test/link-core.test.mjs`.

## 8. Phone page (`public/cam/*`) — Hebrew, RTL, addressed to a woman, no brand header
Module `cam-link.js`: framework-free ES module; the class takes injected `fetch`, `PeerConnection`, `mediaDevices`,
`now`, `timers` so `node --test` can drive it with fakes (`test/cam-client.test.mjs`); no DOM access at import.
Reference to read first (reuse its proven ideas, do not copy unrelated features):
`C:\Users\shk\.codex\visualizations\2026\10\17\01a1481d-3fe4-7343-b9d8-05a99042778a\boostera-live-lab\public-mobile\camera-uplink.mjs`.
States: `idle → acquiring → offering → connecting → live → (recovering | interrupted) → live | stopped`, plus
`program_offline`, `no_path`, `replaced`, `denied`, `busy_camera`, `server_unreachable`.
- Tap ("חברי מצלמה ומיקרופון", screen title "עלי לשידור"): request the screen wake lock inside the tap; ONE
  `getUserMedia` for both kinds: video `{facingMode:'user',width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}}`,
  audio `{echoCancellation:false,noiseSuppression:false,autoGainControl:true,channelCount:1}` (`?voice=1` → all three
  true). Self-view is the raw track in a `<video muted playsinline>` mirrored with CSS only.
- Offer only after getUserMedia. `addTransceiver(track,{direction:'sendonly',streams:[stream]})` for video and
  audio. Codec: prefer H.264 when `RTCRtpSender.getCapabilities('video')` lists it (sort, do not filter;
  `?codec=vp8|h264` overrides). Sender parameters: video `maxBitrate 2500000`, `maxFramerate 30`,
  `degradationPreference 'maintain-framerate'`; audio `maxBitrate 96000`. `new RTCPeerConnection({iceServers (from
  status), bundlePolicy:'max-bundle', rtcpMuxPolicy:'require'})`. Gather-done rule as in §7, send
  `pc.localDescription.sdp`. Before `setRemoteDescription(answer)` add `x-google-start-bitrate=2000` to the fmtp of
  the negotiated video payload type (add an fmtp line if none; harmless elsewhere).
- Deadline: `connected` within 10 s of `setRemoteDescription(answer)`, else state `no_path` ("אין נתיב ישיר לאולפן ·
  בדקי שהטלפון על אותה רשת Wi‑Fi") and retry with backoff. 503 → `program_offline`: poll status every 3 s and
  re-offer by itself when `program.online`. 504 → retry. 409 `LINK_REPLACED`/`REPLACED` from another client →
  `replaced`: stop retrying, release tracks, show "המצלמה עברה למכשיר אחר" + button "החזירי לכאן" (takeover).
- Recovery (make-before-break, no ICE restart): enter `recovering` on connectionState `failed`, or `disconnected`
  for 4 s, or when status shows the link is no longer mine / program echo older than 5 s while program is online, or
  outbound `bytesSent` flat for 5 s. Keep the old connection, start a NEW attempt (new RTCPeerConnection, new
  attempt id), swap when connected, close the old one. Delays 0,1,2,4,8,15,30 s (cap 30), no limit while the page is
  visible and she has not pressed stop. A failed status/state call (network, 401, 5xx) NEVER stops media: pill
  "משדרת · אין קשר בקרה עם האולפן".
- Interruption: listen to `visibilitychange`, `pageshow`, track `mute`/`unmute`/`ended`, `devicechange`. When the
  page is visible and a track is ended, or muted for more than 1 s: `getUserMedia` for that kind only →
  `sender.replaceTrack(newTrack)` → stop the old track (no renegotiation); re-request the wake lock on every return;
  report every change through `POST /api/link/state`. If the wake lock is rejected show "המסך עלול להיכבות. כבי מצב
  חיסכון בסוללה."
- Heartbeat: `GET /api/link/status?attempt=` every 1000 ms; `POST /api/link/state` with stats every 2000 ms and on
  change. Pill truth (from the program echo, not from connectionState):
  green "מחוברת לאולפן · רואים ושומעים אותך" only when `echoAgeMs < 3000`, `fps >= 15`, and
  (`audio.wanted` false → say "מחוברת לאולפן · רואים אותך" plus small text "הקול כבוי באולפן (מצב בדיקה)"; `audio.wanted`
  true → requires `audio.playing` and level seen in the last 5 s, else "רואים אותך · הקול לא מושמע באולפן").
  `air.live` true → an additional badge "🔴 באוויר בטיקטוק". `program.throttled` → "מסך השידור באולפן מוסתר או ממוזער".
- Stop: confirmation "לעצור את המצלמה? השידור בטיקטוק ממשיך עד שסוגרים אותו באולפן." (buttons "עצרי מצלמה" /
  "המשיכי"); stop() calls `track.stop()` on every track and DELETEs the attempt; `pagehide` →
  `fetch(byeUrl,{method:'POST',keepalive:true})`. While any track is live a fixed label
  "🔴 המצלמה והמיקרופון משודרים לאולפן" is visible. Mic mute = `track.enabled=false`, label "המיקרופון מושתק".
- Other copy: before connecting "הטלפון יבקש אישור למצלמה ולמיקרופון" + checklist "Wi‑Fi · מטען בכבל · נא לא להפריע ·
  טלפון לאורך"; denied "אין אישור למצלמה או למיקרופון. פתחי את הגדרות האתר בדפדפן, אשרי את שניהם ולחצי נסי שוב";
  camera busy "אפליקציה אחרת משתמשת במצלמה. סגרי אותה ונסי שוב"; server unreachable "האולפן שלך לא זמין כרגע. זה לא
  בטלפון שלך."; program offline "האולפן דלוק, מסך השידור עוד נפתח. מנסה שוב לבד…"; connecting "מתחברת לאולפן…";
  reconnecting "החיבור נפל · מתחברת מחדש…"; landscape (`screen.orientation.type` starts with `landscape`) full-screen
  hint "סובבי את הטלפון לאורך" (the stream continues); unauthenticated (401) "הטלפון לא משויך לאולפן" with a link to
  `/mobile/` for pairing.
- A hidden diagnostics panel (`?debug=1` or five taps on the pill): codec, encoder implementation, size, fps,
  bitrate, RTT, loss, quality limitation reason, ICE path, attempt count. Everything that comes from the server is
  rendered with `textContent`. No `innerHTML` with dynamic data, no inline scripts (CSP).
- Embed-ready seams only (no implementation): one function that builds request headers (returns `{}` today) and one
  `postMessage` to `window.parent` with `{type:'cam-link',state}` when framed.

## 9. Operator page `/cam/ops` (loopback only)
Polls `GET /api/link/ops` every second: program online/ready/throttled + viewport and device-pixel-ratio, link
state, incoming size/fps/bitrate, ICE path, audio wanted/playing/level/sink, air, build identity, last events.
A red banner "AUDIO OFF" when a link is connected and `audio.wanted` is false or not playing; a red banner when the
program window is throttled or its viewport is smaller than 720x1280 CSS px.

## 10. Launcher `start-link.mjs` (`start-link.cmd` just runs it) — never pass `--open`
`node start-link.mjs [desk|air] [--sink "<label>"]`. Reads `PORT` (default 8800) via lib/env.mjs, `MOBILE_PORT`
from process.env (default PORT+1 convention is NOT assumed: 8801), the program key from env or
`runtime/link-program.key`, the wall URL from the secret setting `LINK_STAGE_URL` (optional). Refuses to start when
`GET http://127.0.0.1:<gateway>/api/link/ops` says `program.online` ("program window already open"). Spawns Chrome
with an ARGUMENT ARRAY (never through a .cmd string): `--user-data-dir=<LOCALAPPDATA>/WannaLinkProgram`,
`--app=http://127.0.0.1:<PORT>/clean/program?src=live&program=air&takeover=1&opp=0&mirror=1[&audio=1&sink=...]&gw=http://127.0.0.1:<gateway>[&stage=<encodeURIComponent(wall)>]#pk=<key>`,
`--no-first-run --no-default-browser-check --disable-extensions --autoplay-policy=no-user-gesture-required
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling
--hide-crash-restore-bubble --force-device-scale-factor=1 --window-size=736,1319 --window-position=0,0` and exactly ONE
`--disable-features=CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns,Translate`. `desk` = no audio parameters;
`air` = `audio=1` plus `sink` when given. Prints what it started; prints nothing secret.
Do NOT run the launcher as part of your work.

## 11. Studio server hardening (`server.mjs`, `lib/fx-routes.mjs`) — separate, small, with tests where possible
1. `isLocal` (server.mjs near line 39) additionally requires `req.headers['sec-fetch-site'] !== 'cross-site'` and
   `Host` ∈ `{127.0.0.1:<PORT>, localhost:<PORT>}` (same rule as the gateway's `localRequest`).
2. `/save` (lib/fx-routes.mjs near lines 193-198): accept only `name` matching `^[\w.-]{1,80}\.(webm|json)$` and
   `path` matching `^effects/[\w.-]+/(?!effect\.json$)[\w.-]+\.json$` (check the real effect folder names and the four
   existing callers first: fx/index.html:196, fx/fx-engine.js:90, fx/builder/track.html:31, track-layer.html:41;
   they must keep working), else 400. Keep the existing prefix test.
Do not bind address changes, do not touch CORS on :8800 in v1.

## 12. Tests (node:test, repo conventions; add every new file BY NAME to package.json "test")
- `test/cam-link.test.mjs`: hub state machine with a fake clock (lease, takeover, PROGRAM_BUSY / PROGRAM_SUPERSEDED,
  online rule, non-destructive offer delivery + ack, REPLACED / STALE_ATTEMPT / CLIENT_GONE / LINK_REPLACED,
  idempotent attempt, rate limits, soft-state adoption, `close()` releases waiters) and HTTP behaviour through
  `createMobileGateway` on a temp workspace root (pattern: test/workspace.test.mjs:23; phone simulated with headers
  `{host:'phone.example','cf-connecting-ip':'203.0.113.5'}` → 401 without pairing; local without `LINK_DEV` → 401;
  with `LINK_DEV=1` → works; program routes refuse: a forwarded request, a foreign Host, a missing or foreign Origin,
  a missing key (when not dev); preflight 204 only for program paths+origins; OPTIONS elsewhere still 405 and no
  other route sends `Access-Control-Allow-Origin`; oversize SDP 413; secrets never appear in any response;
  `/cam/` static files served with the strict CSP, `/cam/ops` 403 for non-local).
- `test/link-core.test.mjs`, `test/cam-client.test.mjs`: the pure helpers and the client state machine with fakes.
- Existing suites must stay green: run `npm test` at the end of your own work ONLY if told to; while other
  implementers are editing in parallel run only your own files with `node --test test/<file>` and `node --check`.

## 13. House rules for everyone
Dense single-line style of the surrounding code for edits inside existing files; new files may be readable
multi-line. Keep CRLF in existing files (Edit preserves it). Error codes UPPER_SNAKE. Hebrew for anything a creator
sees; English for logs/ops. No new npm dependencies. No `Date.now()`/timers hard-wired in the hub (inject).
Never read or print `.env` / `server.env` values. Do not start, stop or restart the servers on ports 8800, 8801,
47831 or anything on 9222/9225 (a real LIVE Studio session is attached). Tests use ephemeral ports. Do not touch the
Android phones (no adb). Do not commit or push unless your brief says so. Do not edit files owned by another
implementer (ownership is in your brief).
