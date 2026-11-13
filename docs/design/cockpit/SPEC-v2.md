# PHONE COCKPIT v2 — binding specification (builds on CAM LINK v1)

Owner requirement (13 Nov 2026): the creator controls EVERYTHING from her phone, on one screen that feels like
TikTok LIVE: her picture full-screen, floating buttons, panels that slide open. The server renders; the phone is the
camera and the remote. Chain for battles: phone -> our gateway -> the BOOSTERA control panel (repo root, port 47831)
-> TikTok LIVE Studio on the same machine. Nothing here replaces LIVE Studio.

Read first: `docs/design/cam-link/SPEC-v1.md` (the camera link that exists now), `docs/design/battle-relay/decide-relay-spec.md`
(the full relay design: this spec ADOPTS it with the overrides below), `docs/design/battle-relay/map-battle-panel.md`
(the panel's real HTTP contract), `server-integration/wanna-studio-server/LINK.md`.
Where this file and those disagree, THIS FILE WINS. The code on disk wins over every map.

## 1. Scope
IN: (a) battle relay in the gateway + a battle panel on the phone; (b) an effects panel on the phone that fires the
existing front effects on the program page; (c) the cockpit layout of `/cam/` (floating buttons + bottom sheets);
(d) a status sheet. OUT (do not build): wall controls (they live in Vardyverse and need its sign-in), tickets and
the Vardyverse embed, return video/audio from the server, TURN, anything inside `fx/fx-engine.js`, any change to the
control panel in the repo root (`server.mjs`, `src/`, `dist/`), any change to `public/mobile/*`.

## 2. Names and switches (all read from the `env` object given to `createMobileGateway`)
- Routes live under `/api/link/` like the camera link: `/api/link/battle/*`, `/api/link/cohost/*`, `/api/link/fx/*`.
  (The relay design says `/api/live/...`: rename.)
- New files: `lib/battle-panel-client.mjs`, `lib/battle-relay.mjs`, `lib/battle-audit.mjs`, `lib/link-fx.mjs`,
  `public/cam/cockpit.js`, `public/cam/battle-panel.js`, `public/cam/fx-panel.js`, tests
  `test/battle-relay.test.mjs`, `test/link-fx.test.mjs`, `test/cockpit.test.mjs` (added by name to package.json).
  Existing files get one-line hooks only (mobile-gateway.mjs: the `/cam/` allow-list and one dispatch line next to the
  cam-link hook; `public/cam/index.html` + `cam.css`: the cockpit shell).
- `LINK_BATTLE_RELAY=1` turns the relay on (default off -> every battle/cohost route answers 404
  `BATTLE_RELAY_DISABLED` and the panel is never contacted). `LINK_BATTLE_PANEL_PORT` (default 47831; the origin is
  always `http://127.0.0.1:<port>`, nothing else is accepted). `LINK_DEV=1` keeps its v1 meaning and additionally
  lets the loopback identity write.
- `LINK_FX=1` turns the effects routes on (default on when unset; `0` disables -> 404 `FX_DISABLED`).

## 3. Who may do what (replaces section 3 of the relay design; there are no tickets yet)
Identity = exactly the capture identity of cam link v1 (paired session id, or `local-desktop` only with `LINK_DEV=1`).
- READ (battle state, candidates, fx catalogue): any capture identity.
- WRITE (battle accept/decline/withdraw/prepare/send, co-host invite prepare/send, fire an effect): only the
  identity that currently HOLDS the camera link (the hub's current attempt belongs to it), and for
  accept / battle prepare / send / invite the link must be `connected` now. Decline and withdraw are allowed for
  the holder of the last link for 10 minutes after it dropped. Otherwise 409 `LINK_REQUIRED` (reads still work and
  the phone shows why). With `LINK_DEV=1` the loopback identity may write without holding a link.
- Add to the cam-link hub (lib/cam-link.mjs) ONE small read-only accessor for this, e.g.
  `holder()` -> `{identity|null, connected:boolean, since, lastHeldBy, lastHeldAt}`; do not expose anything else.
- Same-origin rule, body caps, auth-before-body, rate limits: as cam link v1 and relay design sections 5 and 7.
- The optional expected-account check (`LINK_CREATOR_TIKTOK_UID` equals the panel's own account id) stays as in the
  relay design; when unset it is skipped.

## 4. Battle relay (adopt relay design sections 0, 2, 4-12, 14 as written, with these changes)
- Option A only: the gateway is a same-machine HTTP client of the running panel; cookie bootstrap from `GET /`;
  never talks to 9222/9225; never starts or restarts the panel; requests only `/`, `/api/state`, `/api/battles`,
  `/api/battles/action`, `/api/invites/prepare`, `/api/invites/send`.
- Snapshot, opaque refs, `view` token, stages, hints, two-step confirm for SEND and INVITE, idempotent requestId,
  retry block, write-ahead hash-chained audit (`<workspaceRoot>/data/link-battle-audit.jsonl`), long-poll state
  (`GET /api/link/battle/state?since=&wait=0..8`): unchanged.
- `me.block` values: `LINK_REQUIRED` | null. Drop `NOT_CREATOR_SESSION`, `CREATOR_NOT_BOUND_TO_SERVER`,
  `BATTLE_SCOPE_REQUIRED`, `LIVE_TICKET_INVALID`, `LOCAL_SESSION_READ_ONLY`.
- Tests: the list in the relay design ("TESTS"), adapted to these names and to section 3 above; the fake panel
  server (F1) enforces the real gates (Host, cookie, no Origin). The contract test against the REAL panel code
  imports `createApp` from the repo root `server.mjs` with injected fakes (pattern: `test/control.test.mjs` in the
  repo root). No test may touch ports 47831, 9222, 9225, 8800, 8801, 8810, 8811.

## 5. Effects from the phone (`lib/link-fx.mjs`)
The studio server (same machine, `http://127.0.0.1:<upstreamPort>`) already drives the program page through its
stage events. Read `server.mjs` (routes `/api/screen`, `/api/overlay/play`, `/api/overlay/stop`, `/api/clip/play`,
`/api/clip/stop`, `/api/desk/stop`, `/api/special`, `/api/battle`, `/api/catalog`, `/api/layers`) and the existing
gateway proxies for screen/overlay/stop to learn the exact payloads and the key header the gateway already uses
for upstream calls. Then expose, for the camera-link holder only:
- `GET  /api/link/fx/catalog` -> `{screen:[{id,label,kind}], effects:[{id,title,thumb?}]}`. `screen` is the fixed
  list: hit ×1 (`{type:'hits',count:1}`), ×2, ×3, ×5 (`{type:'double',mult,seconds:30}`), wake up (`{type:'wake'}`),
  tomato ×1 / ×3 (`{type:'tomato',count,style:'live'}`), stop (`{type:'stop'}`). `effects` = the live effects the
  studio server lists for the program page (titles only; cap 60; no file paths, no keys).
- `POST /api/link/fx/screen` `{id}` (one of the fixed ids) and `POST /api/link/fx/effect` `{id}` (must be in the
  catalogue just served) -> forwards the matching upstream call server-to-server with a header set built from
  scratch; answers `{ok:true}` or 502 `STUDIO_UNAVAILABLE`. Nothing from the phone is forwarded verbatim.
- Rate limit: 4 per second, 60 per minute per identity (429 `FX_RATE_LIMIT`). A one-line event in the hub's ops log.
- How an "effect" is triggered on the program page must be the mechanism that already exists (find how
  `public/links.html` and the old phone app do it); if no server-side trigger exists for catalogue effects, ship
  the fixed `screen` list only and report it — do not invent a new channel into the program page.

## 6. The cockpit screen (`/cam/`)
Keep everything cam link v1 does (states, truthful pill, recovery, stop confirmation, landscape hint, diagnostics).
Change the layout once the camera is connected:
- Self-view stays full-screen (CSS mirror). Status pill top, safe-area aware. The fixed "🔴 המצלמה והמיקרופון
  משודרים לאולפן" label stays.
- A vertical rail of round buttons on the visual LEFT edge (TikTok puts actions on the side away from the RTL
  text start; keep 56 px targets, 12 px gaps, above the bottom safe area): `אפקטים` (✨), `באטל` (⚔),
  `מצב` (ⓘ), mic mute, stop. A badge dot on `באטל` when an incoming battle is waiting.
- Each rail button opens a bottom sheet (max 60% height, drag handle, tap outside or swipe down to close, focus
  trapped, `aria-modal`, only one open at a time; the self-view stays visible above it):
  - אפקטים: a grid of big buttons from `GET /api/link/fx/catalog` — first the fixed screen effects with their
    emoji and Hebrew labels (מכה, ×2, ×3, ×5, WAKE UP, עגבנייה, עגבנייה ×3, עצרי), then the catalogue effects by
    title. One tap fires; the button shows a 600 ms pressed state; errors as a toast inside the sheet.
  - באטל: the battle bar of relay design section 13 as a sheet: status line + hint, the action buttons for the
    current stage, the invite list with search and two-step confirm. An incoming battle auto-opens the sheet
    (and vibrates once where supported) unless the creator is in the stop confirmation.
  - מצב: what `/api/link/status` knows, in plain Hebrew: studio screen online, picture arriving (size, fps),
    sound, on air or not, path. No numbers the creator cannot act on beyond size/fps; a "פרטים" toggle shows the
    diagnostics block that exists today.
- Disabled states are explicit: when the caller does not hold the link the two control sheets show
  "קודם חברי את המצלמה" and their buttons are disabled; when a relay/fx route answers 404 disabled, hide that rail
  button.
- All copy Hebrew, feminine address; every dynamic string through `textContent`; no inline scripts or handlers
  (the `/cam/` CSP stays `script-src 'self'`); no new external requests.
- Pure logic (sheet state machine, battle-stage -> buttons mapping, request-id generation, Hebrew dictionary
  lookup with a generic fallback) lives in modules without DOM access at import so `node --test` can cover it.

## 7. Verification that must run before this is called done
- `npm test` green (all old suites + the new ones).
- The existing browser end-to-end runner for the camera link still passes, extended with: the rail appears after
  connect; the effects sheet lists the fixed effects and a tap produces the upstream call (assert on a fake or on
  the disposable studio server's stage state); the battle sheet renders each stage from a FAKE panel server
  started by the runner on a free port (never 47831) with `LINK_BATTLE_RELAY=1`; accept and decline produce exactly
  one panel POST each; SEND and INVITE cannot be posted without the confirm step; the sheet shows LINK_REQUIRED
  when a second browser context (not the link holder) opens it; no horizontal overflow at 360/390/430 px.
- State honestly what cannot be verified without a real two-account battle (relay design section 15).

## 8. House rules
As CAM LINK v1 section 13. In addition: never contact ports 47831, 9222, 9225 or the real TikTok LIVE Studio;
never touch the Android phones; no commit of anything under `runtime/` or `data/`; no push.
