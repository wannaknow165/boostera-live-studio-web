# CAM LINK v1 (wanna-fx-mobile 1.3.0)

The creator's phone is a thin capture client. One tap takes camera and microphone and sends them, peer-to-peer over
WebRTC, to the **program page**: Chrome on the server PC, which cuts her out over the cloud wall and adds the effects.
TikTok LIVE Studio captures that Chrome window and broadcasts it. The gateway relays signalling only; no media passes
through Node. v1 is built for a LAN test bed (Android phone on the same Wi-Fi as the PC, signalling through
`adb reverse`) and is meant to be correct by design for an iPhone over HTTPS later.

The tap connects a camera to the studio. It does **not** start or end the TikTok LIVE: that is done in LIVE Studio.

## Architecture in ten lines

1. Phone page `/cam/` (gateway, `public/cam/`): one tap, one `getUserMedia` for camera + microphone, one SDP offer.
2. The offer goes to the hub `lib/cam-link.mjs` inside the gateway (`POST /api/link/whip`) and waits up to 8 s.
3. The program page (`/clean/program?src=live`, served by the studio server) long-polls the hub, answers the offer.
4. From then on media flows phone -> program page directly (DTLS-SRTP over UDP). Without `LINK_ICE_SERVERS` only
   host candidates are used, so both must be on the same network.
5. `fx/link-receiver.js` draws the incoming video into a fixed 720x1280 canvas (centre crop, mirrored by default).
   That canvas feeds the unchanged effects engine (`fx/fx-engine.js`): cut-out over the wall, effects.
6. Feed gone: the last frame is held for up to 3 s, then black. With a wall that means the wall alone, never a frozen face.
   "Gone" is judged from the decoder's own counter as it was last read: a program page that was itself held up for
   seconds (a long task) does not take that for a silent feed, so there is no black flash and no false "lost".
7. The program page reports what it really shows once a second; the phone's status pill is driven by that echo
   (`GET /api/link/status`), not by its own connection state.
8. Sound is played only with `audio=1` (launcher mode `air`), on its own `<audio>` element; `sink=` picks the output
   device and stays silent when that device is not found.
9. One program page owns the hub (a lease by page id; `takeover=1` replaces it). One link at a time: a new attempt
   from the same page replaces the old one, another device or tab has to press "bring it back here".
10. Hub state is soft: after a gateway restart the media keeps flowing and the hub re-adopts the link the program reports.

Files: `lib/cam-link.mjs` (hub) - `public/cam/index.html`, `cam-link.js`, `cam.css` (phone) - `public/cam/ops.html`,
`ops.js` (operator) - `fx/link-receiver.js`, `fx/link-core.js` (program) - `start-link.mjs`, `start-link.cmd` (launcher) -
`lib/studio-guards.mjs` (studio server guards) - tests `test/cam-link.test.mjs`, `test/link-core.test.mjs`,
`test/cam-client.test.mjs`, `test/studio-hardening.test.mjs` (all in `npm test`) and the end-to-end browser test
`test/run-link-browser.mjs` + `test/link-browser.py` (`npm run test:link-browser`, see below).

## API contract (summary; the binding text is the specification)

Who may call what:

| Routes | Caller must be |
| --- | --- |
| `/api/link/status`, `/api/link/whip*`, `/api/link/state` (phone) | a paired session (cookie `wm_sid`), or with `LINK_DEV=1` a request from this computer. Otherwise 401 `PAIRING_REQUIRED`. No CORS header. A foreign `Origin`, or the program page's origin, is refused: 403 `ORIGIN_REJECTED`. |
| `/api/link/program/*` (program page) | a request from this computer, **and** `Origin` exactly `http://127.0.0.1:<PORT>` or `http://localhost:<PORT>` on every method (403 `PROGRAM_ORIGIN_REQUIRED`), **and** header `X-Link-Program-Key` unless `LINK_DEV=1` (403 `PROGRAM_KEY_REQUIRED`). `bye` needs no key. CORS exists only here and only for those two origins (preflight 204). |
| `GET /api/link/ops`, page `/cam/ops` (operator) | a request from this computer (403 `LOCAL_SETUP_ONLY`). |

The caller is checked before any body is read. JSON bodies need `Content-Type: application/json` (415 `JSON_REQUIRED`)
and are at most 2048 bytes (65536 for `program/answer`); the offer needs `Content-Type: application/sdp` (415
`SDP_REQUIRED`) and is at most 65536 bytes (413 `BODY_TOO_LARGE`).

Phone side:

- `GET /api/link/status?attempt=<id>` -> `{version, serverTime, iceServers, program:{online,ready,throttled},
  link:{state,mine,since,echoAgeMs,stats:{w,h,fps,kbps,rttMs,lossPct},audio:{wanted,playing,level},path,lastError},
  air:{known,live}}`. `link.state` is `idle | negotiating | connected | stalled | lost`. `air.live` is true only while
  the TikTok event connection says so. Never SDP, candidates, addresses or free text from the program.
- `POST /api/link/whip` with headers `X-Link-Client` (per page load), `X-Link-Attempt` (per attempt) and, only from the
  tap, `X-Link-Takeover: 1`. Body: the offer SDP (200..60000 characters starting with `v=0`, at most 3 `m=` lines and
  40 candidates, else 400 `SDP_INVALID`). Answers: 201 with `Location: /api/link/whip/<attemptId>` and the answer SDP - 503
  `PROGRAM_OFFLINE` (no program page; nothing waits) - 504 `PROGRAM_TIMEOUT` (no answer in 8 s) - 409 `LINK_REPLACED`
  (another device holds a connected link) - 409 `REPLACED` (a newer attempt took over) - 429 `OFFER_IN_FLIGHT` /
  `OFFER_RATE_LIMIT` (one at a time, 10 per minute). The same `X-Link-Attempt` again returns the stored result.
- `DELETE /api/link/whip/<attemptId>` or `POST /api/link/whip/<attemptId>/bye` (for `pagehide`): stop, 200
  `{ok:true}`, unknown id 404 `ATTEMPT_UNKNOWN`.
- `POST /api/link/state` `{attempt, video, audio, visible, stats}`: what the phone's tracks are doing; 200 `{ok:true}`.

Program side:

- `GET /api/link/program/poll?program=<pageId>&after=<seq>&takeover=0|1`: a long poll of 25 s. 200 with the oldest
  message not yet acknowledged (`offer`, `stop`, `capture`, each with a growing `seq`) or 204. Another page id gets 409
  `PROGRAM_BUSY`, or with `takeover=1` takes the lease and the old page is told 410 `PROGRAM_SUPERSEDED` (it stops for
  good). The lease lasts 10 s after the last poll. An offer stays deliverable until it is answered, replaced or 10 s old.
- `POST /api/link/program/answer` `{program, attempt, sdp}`: 200 `{ok:true}`; the same answer again
  `{ok:true,repeated:true}`; 409 `STALE_ATTEMPT`; 410 `CLIENT_GONE` when the phone's request has already closed.
- `POST /api/link/program/state`: the echo (state, what is shown, numbers, audio, ICE path), every second while a
  connection exists and every 5 s when idle.
- `POST /api/link/program/bye?program=<pageId>`: releases the lease at once (sent on `pagehide`).
- `GET /api/link/ops`: everything in `status` plus the build `{version, root, startedAt}`, the lease and the last 50
  hub events. Each event is also one JSON line in `runtime/link.log` (no SDP, no keys, no addresses).

## Settings

Read through `lib/env.mjs`: process environment > `server.env` (plain) > `.env` (secrets). No value is logged or returned.

| Name | Where | Meaning |
| --- | --- | --- |
| `LINK_DEV` | `server.env` | `1` = development: a browser on this computer may act as the phone without pairing, and the program page needs no key. Leave empty on a real server. |
| `LINK_PROGRAM_KEY` | `.env` (secret, optional) | The program page's key (at least 16 characters). When it is absent the gateway creates 24 random bytes (hex) and keeps them in `runtime/link-program.key`; the launcher reads the same file. |
| `LINK_ICE_SERVERS` | `server.env` | JSON array of ICE servers, for example `[{"urls":"stun:stun.example.org:3478"}]`. Default `[]`: same network only. An invalid value counts as `[]` and is logged once. |
| `LINK_STAGE_URL` | `.env` (secret, optional) | The wall address (https) that the launcher puts into the program link. It carries the wall token, so it is never printed. |
| `PORT` | `server.env` | Studio server port, default 8800. |
| `MOBILE_PORT` | process environment only | Gateway port, default 8801. A value in `server.env` is ignored, by the gateway and by the launcher. |

Program link parameters (`/clean/program?...`, normally written by the launcher):

| Parameter | Meaning |
| --- | --- |
| `src=live` | The camera link is the source. |
| `gw=<gateway address>` | Where the hub is. Default: the page's host, page port + 1 (8800 -> 8801). |
| `program=<pageId>`, `takeover=1` | The page's name at the hub (default: random per load) and "take the lease from another page". |
| `mirror=1\|0` | Mirror the picture, default 1. |
| `audio=1`, `sink=<part of an output device label>` | Play her voice (default off) and on which device. |
| `adelay=<ms>`, `jb=<ms>` | Audio delay and jitter-buffer target, default 0. |
| `stage=<encoded wall address>` | The wall behind her (clean mode only, as before). |
| `opp=1` | Turn the opponent watcher on; for `src=live` it is off unless asked for. |
| `#pk=<program key>` | In the fragment: read once, then removed from the address. The tab keeps it (sessionStorage, this origin and this tab only, gone when the window closes) so that a reload of the window is still accepted. |

Start-up order of the program page with `src=live`: the hub client starts first, and the engine is held back until a
phone that is waiting has been connected - at most 4.5 s when nobody asks (7 s when an offer is being answered at that
moment). Reason: loading the models and the first inference hold the page for several seconds at a time, and an offer
that arrives then is answered late or not within the hub's 8 s. A phone that lost its link through a reload of the
window asks again within a second or two, and one that found the program offline looks again every 3 s, so both are
answered before the engine takes the page. The phone's pill turns
green only when the hub calls the link `connected`, which the program reports once its engine is really drawing her.
While the program says it is still loading (`program.ready` false) the phone leaves the link it has alone, however old
the echo is: the page is then held up for seconds at a time and could not answer a new offer either. When the hub says
the link is lost (the window was reloaded) the phone asks again within a second, whatever its retry delays had grown
to. So after a reload the link itself is back in about 2 s, and the picture returns when the engine has loaded again
(3 to 22 s on the test computer, depending on how busy it was).
For 20 to 60 s after a (re)load the page is still warming up (models, effects, the profile-picture cutter), with
hold-ups of up to about 10 s on a busy computer. Once the engine is ready, a hold-up of more than 5 s can still make
the phone offer again (the echo looks stale); the picture is then replaced by the slate for a moment. It settles by
itself, and it is a property of the page's loading, not of the link.

Phone page parameters (`/cam/?...`): `debug=1` (diagnostics panel; five taps on the status pill do the same),
`voice=1` (call-style audio processing), `codec=vp8|h264`.

## A second test instance next to a running production copy

Never stop or restart the copy that LIVE Studio is attached to. Run this repository copy beside it on its own ports,
from its own folder (two instances started from one folder would share `data/`, `media/` and `runtime/`).

In Git Bash (it passes empty variables on; `set X=` in cmd.exe deletes the variable instead, and then the key from
`.env` would be live again):

```bash
cd "<repo>/server-integration/wanna-studio-server"
export PORT=8810 MOBILE_PORT=8811 PUBLIC_BASE_URL=http://127.0.0.1:8810 LINK_DEV=1 DRY_RUN=1
# provider keys blanked and throwaway server keys, exactly as test/run-browser.mjs does
export OPENROUTER_API_KEY= KLING_API_KEY= SIGN_API_KEY= TIKTOOLS_API_KEY= EULER_API_KEY=
export API_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
export STUDIO_CLIENT_KEY=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
export VARDY_INGEST=            # extra: this instance never posts events to the cloud
node server.mjs &               # studio server on 8810 (same shell: both processes must share the two throwaway keys)
node mobile-gateway.mjs         # gateway on 127.0.0.1:8811 (no --open, no --tunnel); Ctrl+C stops it
kill %1                         # then stop the studio server of this instance
```

Then, done by the operator (nothing in this repository runs adb for the link):

1. `adb reverse tcp:8811 tcp:8811` and `adb reverse tcp:8810 tcp:8810` for the test phone. The phone page needs 8811;
   remove both rules after the test (`adb reverse --remove tcp:8811`, `adb reverse --remove tcp:8810`): while they
   exist, whatever runs on that phone reaches both servers as "this computer".
2. The phone's Wi-Fi is on the PC's network (client isolation off). `adb reverse` carries signalling (TCP) only; the
   media needs a direct UDP path. On USB alone the phone shows "no direct path to the studio" and keeps retrying.
3. PC: open the program window. With the launcher, from a shell that has the two ports:
   `PORT=8810 MOBILE_PORT=8811 node start-link.mjs desk`. Or, for a quick look only, open
   `http://127.0.0.1:8810/clean/program?src=live&opp=0&gw=http://127.0.0.1:8811&stage=<encoded wall address>` by hand
   (with `LINK_DEV=1` no key is needed; without the launcher's switches the picture stops when the window is covered
   and sound is blocked).
4. Phone: Chrome opens `http://localhost:8811/cam/` and she taps the button. `localhost` is what makes the camera
   available over plain http; with `LINK_DEV=1` no pairing is needed.
5. Operator view: `http://127.0.0.1:8811/cam/ops`.

The launcher uses one Chrome profile per Windows user. While a program window of another instance is open it refuses
(`PROFILE_IN_USE`); close that window first.

## Operator runbook

Start order: servers (`start-mobile.cmd`), then the program window, then LIVE Studio. Outside `LINK_DEV=1` the phone
has to be paired first, as before: the code from `/mobile/pair` on the PC, typed in at `/mobile/` on the phone. A
pairing lasts 12 hours and is lost when the gateway restarts. Then the phone opens `/cam/`. A phone can use its camera
only on `localhost` (through `adb reverse`) or over HTTPS.

| Command | What it opens |
| --- | --- |
| `start-link.cmd` (= `desk`) | Picture only. No audio parameters; this computer plays nothing. For desk tests. |
| `start-link.cmd air --sink "<part of the output device label>"` | `audio=1` and the output device. Her voice is played on that device for LIVE Studio. |
| `node start-link.mjs air --sink "..." --print` | Prints the Chrome arguments with the key and the wall address redacted. Starts and contacts nothing. |

The launcher starts Chrome with its own profile (`%LOCALAPPDATA%\WannaLinkProgram`), as an `--app` window without an
address bar, 736x1319 at scale 1, without extensions, with autoplay allowed, background throttling and occlusion
tracking switched off, and real local addresses in WebRTC (acceptable only because this profile opens nothing else).
It refuses to start, with a pause so the message can be read, when: a program window is already online
(`PROGRAM_ALREADY_OPEN`), a Chrome with that profile is still open (`PROFILE_IN_USE`), the gateway does not answer
(`GATEWAY_UNREACHABLE`, `GATEWAY_WITHOUT_CAM_LINK`), the key is missing (`PROGRAM_KEY_MISSING`) or Chrome is not found.
To restart the window, close it and run the launcher again: it waits up to 5 s for the old one to disappear.
After starting it waits up to 20 s for the gateway to see the page and says so (`PROGRAM_NOT_ONLINE` otherwise).

Rules while live:

- **Capture only the `--app` window** (title `LINK PROGRAM`) in LIVE Studio. Never a normal Chrome window: its address
  bar would put the wall link on air. Never open the program link from the everyday Chrome: a window that joins an
  already running Chrome gets none of the switches.
- **Never minimise the window, never lock the session, no remote-desktop session on the live PC, no other virtual
  desktop.** A hidden window stops drawing. The phone then says the studio screen is hidden, and `/cam/ops` shows a red
  banner.
- **Power plan: never sleep, never turn the display off, no screen saver.**
- **The display must fit the window**: 1319 pixels of height plus the taskbar, so a 1080-pixel-high display is too
  short. `/cam/ops` shows a red banner when the page is smaller than 720x1280.
- **Audio output must not be open speakers.** The phone's microphone would hear them and the echo goes on air. Use
  headphones or a dedicated (virtual) output device, name it with `--sink`, and let LIVE Studio take its sound from that
  device only. If the device is not found the page stays silent (`no_sink`) instead of using the default speakers.
  `/cam/ops` shows a red `AUDIO OFF` banner when a link is connected and no sound is wanted or playing.
- Keep `/cam/ops` open on a second screen: program online / ready / throttled, link state, incoming size, fps and
  bitrate, ICE path, audio, on-air state, build, last events.
- Stopping the camera on the phone does not end the TikTok LIVE. End it in LIVE Studio.
- v1 is for a solo LIVE with an operator. Chat is read on a second device or relayed by the operator.

## ליוצרת: איך מתחברים לאולפן

1. פתחי בטלפון, בדפדפן Chrome, את הקישור שקיבלת מהמפיק.
2. לפני שמתחילים: Wi‑Fi · מטען בכבל · נא לא להפריע · טלפון לאורך.
3. לחצי על "חברי מצלמה ומיקרופון" ואשרי לטלפון גם את המצלמה וגם את המיקרופון.
4. כשכתוב "מחוברת לאולפן · רואים ושומעים אותך", האולפן מקבל אותך. התווית "באוויר בטיקטוק" מופיעה רק כשהשידור בטיקטוק באמת פעיל.
5. השאירי את הדף פתוח ואת המסך דלוק. אם עברת לאפליקציה אחרת או שהמסך ננעל, התמונה נעצרת. חזרי לדף והיא חוזרת לבד.
6. "עצרי מצלמה" עוצר רק את המצלמה. השידור בטיקטוק ממשיך עד שסוגרים אותו באולפן.
7. אם כתוב "המצלמה עברה למכשיר אחר", לחצי על "החזירי לכאן".
8. בגרסה הזו משדרים לבד, בלי קרבות. את הצ'אט רואים במכשיר אחר או דרך המפיק.

## End-to-end test in a real browser (no phone, nothing visible, nothing audible)

`npm run test:link-browser` (= `node test/run-link-browser.mjs`; `--dev-only` / `--strict-only` run one phase). It
copies the source into a disposable folder and starts ITS OWN studio server on 18890 and gateway on 18891 there
(`DRY_RUN=1`, blank provider keys, throwaway server keys; it refuses to start when a port is taken and stops both at
the end, also on failure). Headless Chromium (Python Playwright; fake camera and microphone, a pretend audio output)
then runs the capture page and the program page against each other over real WebRTC:

- phase `dev` (`LINK_DEV=1`): the program page comes online - one tap connects, the program shows `webrtc` with rising
  `framesDecoded`, the status echo is fresh and the pill is green - the operator page shows the link and `AUDIO OFF` -
  stop gives the slate and an idle hub - the program page is reloaded mid-link and the phone is linked again by itself
  within 20 s (measured: about 2 s), with one new connection, and the picture returns when the engine has reloaded -
  a second program page without `takeover=1` gets `PROGRAM_BUSY` - a second capture page gets `LINK_REPLACED`, takes
  the link with "bring it back here", and the first shows "replaced" - `audio=1` gives `wanted` + `playing`, a level,
  and the "seen and heard" pill;
- phase `strict` (the gateway restarted without `LINK_DEV`): a program page without the key is refused, the keyed page
  is accepted and its address is clean, an unpaired phone sees the pairing notice, a phone paired through the real
  pairing route connects, the keyed page survives a reload, and `link.log` holds no key and no SDP.

Screenshots, `link-browser-result-<phase>.json` (with the measured times), the two server logs and the hub's
`link.log` are written to `runtime/link-browser-audit/`. The effects engine needs a real GPU to run at speed; on
Windows the test asks Chromium for it (`--use-angle=d3d11`). With `LINK_BROWSER_GL=software` the transport is still
checked in full and the checks that need a fast program page are skipped and written down as notes.
What it cannot show: a real phone (hardware encoder, wake lock, background behaviour, iOS), a real network path, the
launcher's window and its Chrome switches, `sink=` on a real output device, and LIVE Studio's capture.

## Acceptance tests (before v1 is called done)

From the media and network review, with the numbers it set. Two items are adapted to what v1 actually builds.

1. LAN connect in under 3 s from the tap; `link.path` is `host` or `prflx` over `udp`.
2. Delay, measured by filming a millisecond clock next to the program window: p50 at most 300 ms (p95 at most 500 ms).
3. Program window fully covered by LIVE Studio for 60 s: `drawHz` stays at 25 or more.
4. Wi-Fi off for 3 s: the link heals without a new attempt. Off for 20 s: a new attempt, picture back within 5 s of
   Wi-Fi returning.
5. Program page reloaded mid-link: picture back within 5 s of the page being ready.
6. A second program page without `takeover=1` is refused (`PROGRAM_BUSY`) and the first keeps the link. (Adapted: the
   review called the flag `owner=1`.)
7. Gateway restarted mid-link: the media continues and the hub re-adopts the link.
8. Phone app-switch for 10 s and screen lock for 10 s: slate after 3 s, picture back within 2 s of her return.
9. USB only, phone Wi-Fi off: the phone says there is no direct path and keeps retrying; it connects by itself when
   Wi-Fi returns. (Adapted: the review expected an HLS fallback here; v1 has none.)
10. adb cable unplugged and plugged back in: the media continues.
11. 60-minute soak: constant resolution, `freezeCount` and `pcCreated` flat, page memory flat, the phone's quality
    limitation durations written down.

## Gates (from the product and operations review, each with a written result)

Before them comes G0: the copy that actually runs on the PC is this repository version.

- **G1** Capture and audio spike in LIVE Studio: Link source, Chrome `--app` window + Window Capture, OBS virtual
  camera. For each: does it keep updating when covered, is it stable for 2 hours, the output resolution, does the page's
  audio reach LIVE Studio's mixer.
- **G2** Minimal link on the LAN (Android phone over `adb reverse`, same Wi-Fi): portrait 720x1280 frames, H.264
  hardware encode, cut-out over the wall, glass-to-glass under 400 ms, audio on the dedicated output, lip-sync within
  40 ms lead / 120 ms lag.
- **G3** Kill tests that must heal with the slate shown and no operator action: reload the program window, restart the
  gateway, lock the phone for 30 s, incoming call, Wi-Fi off and on, a second tab, a second program window. Then a
  2-hour soak (phone temperature, server GPU, memory). (v1's slate is the wall alone, not a "back soon" card.)
- **G4** A physical iPhone in a Safari tab over a real HTTPS host name: the prompt, portrait size after the first
  frame, H.264, recovery from background / lock / call, Low Power Mode, AirPods, 2-hour soak.
- **G5** Off the LAN: from cellular to a production-like server. Decide about TURN.
- **G6** Only now: ticket + CORS + the native Vardyverse screen, tested with a real signed-in creator.
- **G7** First solo LIVE with an operator on a low-stakes account.

## Not in v1

- **Tickets** / bearer authentication. The phone is a paired device (or `LINK_DEV=1` on the bed).
- **Vardyverse embed**: no iframe embedding headers, no CORS for Vardyverse, no native Vardyverse screen yet. The
  phone page only has the seams for it.
- **TURN**: no credential minting, no relay. `LINK_ICE_SERVERS` is a plain pass-through.
- **HLS fallback**: none, automatic or otherwise. No path means "no direct path", not a slower stream. The old
  `src=server` code is not ported.
- **Return audio** and any return monitor feed: she cannot hear or see the broadcast on the phone.
- **Battles relay**: co-host and battle sound stays on the server PC, so v1 is for a solo LIVE.
- Also not built: camera flip, an installable app (manifest, service worker) for `/cam/`, any change to the shared
  `fx/fx-engine.js`.

## Studio server hardening that ships with it

The program page lives on the studio server (:8800), so two of its doors were narrowed (`lib/studio-guards.mjs`):

- **"From this computer, without a key"** now means: a loopback connection that nothing forwarded, addressed as
  `localhost:<PORT>` or `127.0.0.1:<PORT>`, and not sent by a page of another site (`Sec-Fetch-Site: cross-site`). Our
  own pages, typed addresses, the gateway and other local programs are unaffected. A page of another site, a
  DNS-rebinding host name, `[::1]` and a forwarder on another port now need the key (`x-key` or `?ck=`).
- **`POST /save`** writes only `?name=<file>.webm|.json` (into `fx/test/out`) and
  `?path=effects/<folders>/<file>.json` (a tracking file beside its effect), else 400. Never a page, a script,
  `effect.json`, `effects/index.json` or a `remix` folder.
- The key rule protects nothing while `STUDIO_CLIENT_KEY` is empty, and the server listens on every interface. Before
  the PC is reachable from a LAN or the internet, make sure `STUDIO_CLIENT_KEY` and `API_TOKEN` are both set.
