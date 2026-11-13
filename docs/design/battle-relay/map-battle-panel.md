# MAP: battle-panel

# Battle panel (BOOSTERA LIVE Web) mapped for a gateway relay

Path prefixes: ROOT = C:\My Web Sites\boostera-live-studio-web (branch integration/stage-and-ingest, clean tree). GW = ROOT\server-integration\wanna-studio-server. OTHER = C:\Users\shk\Projects\boostera-live-studio-web (branch main; panel code identical to ROOT, 20 files compared after EOL normalisation). Log times are UTC; local time is UTC+2.

Method: read-only. Nothing was connected to 9222, 9225 or 47831; live-system facts come only from the OS listener table and process start times. Not opened: .env, server.env, and the RTMP probe files in OTHER\runtime (phone-publish-probe.json, phone-live-test-result.json and their two scripts), which may hold stream destinations. All IDs, handles and names are masked.

## Headline findings

1. The relay is feasible as proposed. A same-machine Node process does GET / to receive the cookie, then calls the API with it. The other programmer's own scripts did exactly this against the live panel and logged HTTP 200 (section 3).
2. The panel process running now is stale. It started at 20:40:21 local, 26 seconds before commit 449f3e9 and before four later fix commits (21:00, 21:31, 21:39, 21:51). It therefore lacks minimized-Studio support, the repeat-round fix, the search adapter and the /api/phone routes. ROOT\docs\LIVE-VERIFICATION.md:41 says the same: "has not loaded all later fixes".
3. Accepting or declining an INCOMING battle through the panel has never run with real accounts (synthetic only). Outgoing start is real-verified through the running panel's HTTP API; withdrawal is real-verified only through the updated modules run directly.
4. The panel does not cover everything a phone-only creator needs: opening the Co-host popup or Match panel, typing a TikTok search, accepting incoming co-host requests, auto-match, starting or ending the LIVE, ending a running battle.
5. `state.battle.incoming` was never populated in real bridge data. Direction must be read from GET /api/battles `scopes[].role`.

## 1. Architecture

Chain: phone, then gateway 8801 (auth), then the relay (to build), then panel 47831 (cookie), then two Studio channels: TCP 9225 for read-only state, and DevTools 9222 for DOM clicks in the Studio renderer.

Processes and ports (all hard-coded):
- TikTok LIVE Studio started with `"--devtoolsMcp=1","--remote-debugging-port=9222","--remote-debugging-address=127.0.0.1"` (ROOT\docs\STUDIO.md:14, path tested for 1.39.6). 9225 is Studio's JSON-RPC bridge; 9222 is the Chrome DevTools endpoint.
- Panel: `node server.mjs [--open]`, no npm dependencies, `server.listen(port,'127.0.0.1',…)` with `const port=47831` (ROOT\server.mjs:128,130). Single instance: EADDRINUSE prints "BOOSTERA is already running" and exits 0 (server.mjs:129).
- Panel to gateway (optional PhoneLink): `http://127.0.0.1:8801` `/api/workspace/overview` and `/api/workspace/rtmp` (ROOT\src\phone-link.mjs:40-41,75-77,89-91).
- Now listening (OS table only): 47831 node `server.mjs` (started 20:40:21 local); 9222 Studio main process (20:32:51); 9225 a Studio child process (20:32:58); 8801 node `mobile-gateway.mjs --open` (22:51:22). Studio's command line was not readable, so its flags are not verified directly.

RpcClient (ROOT\src\rpc.mjs): raw TCP, newline-delimited JSON-RPC 2.0.
- Request: `this.socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')` (rpc.mjs:36).
- Responses are split on `\n`, parsed and matched by `response.id` (rpc.mjs:23-28). Unparseable lines and unknown ids are ignored.
- One persistent socket with lazy reconnect; 3000 ms connect and per-call timeout gives `BRIDGE_TIMEOUT`; close gives `BRIDGE_CLOSED`; buffer over 16 MiB gives `RESPONSE_TOO_LARGE`.
- The only method used is `get_service_state` with `{serviceName,propertyPath}`; `state()` returns `r?.state?.[propertyPath]` (rpc.mjs:39-42). The code never writes through the bridge.

state(scope,key) calls:
| Call | Used at | Returns (as consumed) |
|---|---|---|
| interactionConnection / snapshot | server.mjs:38; invites.mjs:14,60; battles.mjs:79,83 | `{health, session:{selfUid,roomId,epoch}, users:{uid:{roomId,linked,invited,applied,availableActions:{invite,direct}}}, operations:[…], battle:{battleId,status,participantUids}, availability:{manual_cohost:{allowed}}}` |
| interactionConnection / providerReady | server.mjs:38 | boolean |
| coHostContext / invitePanelState | server.mjs:39 | object; `.status==='ready'` becomes `panelReady` |
| coHostContext / battleStatus | server.mjs:39 | presentation string: 'SELECT_MODE', 'PREPARING', 'ONGOING' |
| coHostContext / linkedUsers | server.mjs:40 | array used for names and avatars of linked users |
| interactionConnection / candidates.batches | server.mjs:44, at most every 8 s | map of `{accepted,ticket:{epoch,query:{section}},entries:[{target,room}]}`; real Studio can return only `{__type:'Map',size}` (model.mjs:20) |
| user / anchorInfo, else user / userInfo | server.mjs:47, every 15 s | `{nickname or name, display_id or username}` |

Real values seen in logs: health 'ready' and 'initializing'; operation kind 'manual_cohost' (action 'invite'; steps 'requesting', 'awaiting_peer', 'succeeded', 'failed') and 'quick_cohost' (action 'start'; steps 'matching', 'cancelled'); battle status 'pending' and 'open'.

NativeUi.connect(surface) (ROOT\src\native-ui.mjs:3-37):
- Surfaces are 'popupMulti' (default, the Co-host popup window) and 'main' (Studio main window, used by NativeBattleUi, battles.mjs:62).
- It fetches `http://127.0.0.1:9222/json/list` and picks the first `type==='page'` target whose file URL matches `'^/C:/Program Files/TikTok LIVE Studio/[\\d.]+/resources/app/+html/'+surface+'/index\\.html$'` (line 9). No match gives `NATIVE_PANEL_UNAVAILABLE`.
- `webSocketDebuggerUrl` must be ws://127.0.0.1:9222, else `INVALID_NATIVE_ENDPOINT` (lines 12-13).
- Evaluation: `ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}))` (line 31), 3 s timeout. A new WebSocket is opened per operation and closed in `finally`.
- No Input-domain events and no window activation; a click is `element.click()` inside the renderer (battles.mjs:56, native-ui.mjs:79).
- Battle adapter: `nativeBattleDocument` is serialised and evaluated in the main page (battles.mjs:63). It reads Studio's own `data-ix-*` attributes and returns `{ready:true,scopes,buttons,identity}`.

Cadence:
- Server poll every 1800 ms (server.mjs:62); Co-host popup inspection at most every 4 s (server.mjs:49).
- GET /api/state returns the cached state. GET /api/battles is an active probe on every call: two bridge reads plus a new DevTools session.
- Browser UI: state 1800 ms, battles 2400 ms, phone 5000 ms (ROOT\dist\app.js:243).

## 2. HTTP API contract

All JSON replies carry `Cache-Control: no-store`. Gate 1 applies to every request: 403 `{error:'ORIGIN_REJECTED'}` (server.mjs:65). Gate 2 applies to /api/*: 401 `{error:'OPEN_PANEL_FIRST'}` (server.mjs:68). Unknown /api path: 404 `{error:'NOT_SUPPORTED'}`. Other paths or methods: 404 `{error:'NOT_FOUND'}`. POST bodies (readJson, server.mjs:112-116): 415 `JSON_REQUIRED`, 413 `BODY_TOO_LARGE` (over 2048 bytes), 400 `INVALID_JSON`.

GET /api/state, 200 when connected (server.mjs:50-55, model.mjs:45-59):
```
connected:true, observedAt:ms, health, live:Boolean(numeric session.roomId),
providerReady, panelReady,
session:{selfUid,roomId,epoch}|null,
battleStatus (default 'SELECT_MODE'),
battle:{id,status,incoming,participantUids[]}|null,
candidates:[{uid,roomId,name,handle,avatar,sources[],linked?,invited?,applied?,inviteAvailable?,directAvailable?,nativeObserved?}]  (max 300),
operations:[{id,kind,action,phase,step,outcome,targetUid,createdAt,updatedAt,error:{code,message}|null}]  (last 20),
coverage:{friends,suggested,truncated},
actions:{mode:'native-ui'|'observe',invite:bool,accept:false,reject:false,reason},
self:{name,handle}|null,
events:[{id,at,type:'connection'|'error'|'live'|'invite'|'battle',title,detail}]  (last 100, oldest first, Hebrew titles),
error:null, version:'0.2.0'
```
- There is no `linked` or `participants` field. Linked co-hosts are `candidates.filter(c=>c.linked)`; battle participants are `battle.participantUids`.
- Offline shape (server.mjs:57): `{connected:false,live:false,health:'offline',candidates:[],operations:[],battle:null,actions:{mode:'observe'},error:'BRIDGE_UNAVAILABLE',lastObservedAt,version:'0.1.0',events}`.
- Before the first poll: `{connected:false,live:false,candidates:[],operations:[],battle:null,events:[],error:'CONNECTING'}`.
- `actions` is set at server.mjs:51: `invite:Boolean(nativeStatus?.ready&&next.live&&next.providerReady),accept:false,reject:false,reason:nativeStatus?.ready?null:'OPEN_COHOST_PANEL'`. It describes Co-host invites only; battle availability is only in /api/battles.

GET /api/battles, always 200 (battles.mjs:93-99):
- Success: `{available:true,revision:<64 hex>,epoch,scopes:[{surface,battleId,channelId,role,mode,teams,participantCount,selectedTeammateCount,giftType,giftId}],actions:[{action,enabled,selected,label}],error:null}`.
- Failure: `{available:false,actions:[],scopes:[],error}`. Codes: STUDIO_NOT_READY, SESSION_CHANGED, PHONE_ROOM_NOT_ATTACHED_TO_STUDIO, NATIVE_PANEL_UNAVAILABLE, NATIVE_UI_TIMEOUT, NATIVE_UI_UNAVAILABLE, NATIVE_UI_CLOSED, NATIVE_COMMAND_FAILED, NATIVE_UI_SCRIPT_FAILED, INVALID_NATIVE_ENDPOINT, BRIDGE_TIMEOUT, BRIDGE_CLOSED, raw socket or fetch errors, BATTLE_UNAVAILABLE.
- `available:true` with empty `scopes` and `actions` means no Match control is rendered.

Real sequences (OTHER\runtime\native-live-observations.jsonl, masked):
| When | Scope | Controls |
|---|---|---|
| Co-host linked | `cohostModeSelect`, mode 'normal', participantCount '2' | match.select (selected), cohostMode.getStarted |
| After getStarted | `matchStart`, teams `[["<id>"],["<id>"]]` | match.start |
| Outgoing pending | `match.invitation`, role 'inviter', battleId, channelId | match.withdraw |
| Incoming pending | `match.invitation`, role 'invitee' | match.accept, match.decline |
| Battle open | none | none |

POST /api/battles/action (server.mjs:80-83, battles.mjs:100-128):
- Body `{action,revision,epoch,requestId}`. `action` is one of match.select, match.individual.select, match.team.select, cohostMode.getStarted, match.start, match.accept, match.decline, match.withdraw. `revision` matches `/^[a-f0-9]{64}$/`; `epoch` is a string of at most 160 chars; `requestId` matches `/^[a-f0-9-]{36}$/` (lowercase).
- 200 `{action,dispatched:true,outcome:'awaiting_studio',error:null}`.
- 200 `{action,dispatched:null,outcome:'unknown',error:'BATTLE_ACTION_UNCERTAIN'}` when the click call timed out or the socket closed.
- 400 INVALID_BATTLE_REQUEST. 409 REQUEST_ID_CONFLICT, BATTLE_BUSY, SESSION_CHANGED, BATTLE_CHANGED, BATTLE_ACTION_UNAVAILABLE, STUDIO_NOT_READY, PHONE_ROOM_NOT_ATTACHED_TO_STUDIO. 429 BATTLE_RATE_LIMIT. 503 `{error:<message>}` for bridge or native errors in the pre-click inspection.

POST /api/invites/prepare (invites.mjs:31-42):
- Body `{uid,epoch}`.
- 200 `{draftToken:<48 hex>,uid,epoch,name,handle,expiresAt:now+30000}`.
- 400 INVALID_TARGET.
- 409 SESSION_CHANGED, STUDIO_NOT_READY, SELF_INVITE_NOT_ALLOWED, TARGET_UNAVAILABLE, INVITATION_ALREADY_PENDING, INVITE_BUSY, REFRESH_CANDIDATES, OPEN_COHOST_PANEL, TARGET_NOT_IN_NATIVE_LIST, NATIVE_INVITE_DISABLED, NATIVE_LIST_UNAVAILABLE, PHONE_ROOM_NOT_ATTACHED_TO_STUDIO.
- Side effect: prepare may click the Friends or Suggested tab in Studio's popup (native-ui.mjs:62-65).

POST /api/invites/send (invites.mjs:43-68):
- Body `{uid,epoch,draftToken,requestId}`.
- 400 INVALID_TARGET, INVALID_REQUEST_ID. 409 REQUEST_ID_CONFLICT, CONFIRMATION_EXPIRED, INVITE_BUSY, the fresh-check codes above, AMBIGUOUS_NATIVE_TARGET, NATIVE_INVITE_DISABLED.
- 200 receipts: `{submitted:true,operationId,outcome,step,error:{code,message}|null}`; `{submitted:true,outcome:'pending',step:'awaiting_peer'}`; `{submitted:null,outcome:'unknown',error:<string>}` with NATIVE_ACTION_UNCERTAIN, BRIDGE_LOST_AFTER_CLICK, SESSION_CHANGED_AFTER_CLICK or NATIVE_ACTION_NOT_OBSERVED.
- The call can block about 6 s (observeMs=6000, 300 ms steps).
- Real receipt (masked): `{"submitted":true,"operationId":"<id>","outcome":"pending","step":"requesting","error":null}`.

Other routes:
- POST /api/refresh: 200 `{ok:true,connected}`; no body needed.
- GET /api/phone: 200 `{configured,received,fresh,roomId,storedAt,imported,sameStudioRoom,error}`, or `{configured:false,error:'PHONE_LINK_NOT_CONFIGURED'}`.
- POST /api/phone/import: 200 `{imported:true,roomId,importedAt}`; 409 with a PHONE_* code. It overwrites the gateway RTMP target and stores the room binding.
- DELETE /api/phone: 200 `{unlinked:true}`. It sends `{clear:true}` to the gateway RTMP config.
- POST /api/focus-studio: 200 `{ok:bool}` or 503 FOCUS_UNAVAILABLE. It runs `AppActivate('TikTok LIVE Studio')` on the server desktop (server.mjs:121).

## 3. Security model

`requestAllowed` (server.mjs:16-23):
- `if(!new Set(['127.0.0.1:'+port,'localhost:'+port]).has(req.headers.host))return false;`
- `if(req.headers['sec-fetch-site']==='cross-site')return false;`
- An Origin header, if present, must be `http://127.0.0.1:47831` or `http://localhost:47831`.
- API calls also need `(req.headers.cookie||'').split(';').some(c=>c.trim()==='boostera_session='+token)`.

Token and cookie:
- `crypto.randomBytes(32).toString('hex')` per process, memory only (server.mjs:25).
- Every GET or HEAD of `/`, `/app.js`, `/style.css` that passes gate 1 returns `'Set-Cookie':'boostera_session='+token+'; HttpOnly; SameSite=Strict; Path=/'` (server.mjs:103).

CSP on assets (server.mjs:102): `default-src 'self'; script-src 'self'; style-src 'self'; img-src https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. No CORS headers. Bind is 127.0.0.1 only.

Server-to-server call, confirmed three ways:
- Code: no check distinguishes a browser from a Node client.
- Test: ROOT\test\control.test.mjs:76-89. Without cookie 401; GET / gives the cookie via `set-cookie[0].split(';')[0]`; with cookie 200; with a foreign Origin 403.
- Real use: OTHER\runtime\accept-next-owned-battle.mjs:3 and withdraw-owned-invite.mjs:3 use `page=await fetch(origin),cookie=page.headers.get('set-cookie')?.split(';')[0],headers={cookie}`, then POST with `{...headers,'Content-Type':'application/json'}`. native-live-actions.jsonl lines 3, 4 and 10 show `"http":200`.

Relay rules that follow:
- Target `http://127.0.0.1:47831` literally.
- Build headers from scratch; never forward the phone's Origin, Sec-Fetch-Site or cookies.
- A browser page on 8801 cannot call the panel directly (its Origin is rejected).

Panel restart: new token, so the old cookie gets 401 `OPEN_PANEL_FIRST`; re-run GET / and retry. All caches, drafts, cooldowns and the event history are in memory and are lost. The first state may read `error:'CONNECTING'`.

## 4. Preconditions

Co-host invite:
- The Co-host popup page (popupMulti) must exist with the Friends tab shown, or native search results showing (native-ui.mjs:41,49-50). Otherwise `actions.mode:'observe'` and `reason:'OPEN_COHOST_PANEL'`.
- `actions.invite` also needs `live` and `providerReady`.
- Fresh checks before prepare and before the click (invites.mjs:16-23): same epoch, `health==='ready'`, not self, not linked, `availability.manual_cohost.allowed!==false`, invite permitted, not already invited or pending.
- Exactly one enabled `button[data-action="cohost-invite"][data-uid]` must exist. Not disabled, not `data-loading`, card not `data-cohost-clickable="0"`.
- The target must be in the list currently rendered in Studio.

Battle actions:
- `health==='ready'` with `session.epoch` and `session.roomId` (LIVE active), else STUDIO_NOT_READY (battles.mjs:81). `providerReady` is not checked here.
- The main-window page must exist. The control must be rendered inside `[data-ix-state="match.invitation"]`, `[data-ix-surface="matchStart"]` or `[data-ix-surface="cohostModeSelect"]` (battles.mjs:27).
- Per-action rules (battles.mjs:43-46): accept and decline need a numeric battle id and role 'invitee'; withdraw needs role 'inviter'; start needs surface matchStart, participantCount of at least 2 and two team ids; getStarted needs a selected mode.
- `enabled` also hit-tests the button centre with `document.elementFromPoint` (battles.mjs:23-24). A covered or off-viewport button is disabled, and this adapter does not scroll.

Reason codes:
| Where | Value | Meaning |
|---|---|---|
| state.actions.mode | 'native-ui' | Co-host popup detected; invites can be dispatched |
| state.actions.mode | 'observe' | read-only for invites |
| state.actions.reason | null | popup ready (also null when invite is false because not live or provider not ready) |
| state.actions.reason | 'OPEN_COHOST_PANEL' | popup not found or Friends tab not shown |
| state.actions.reason | 'PHONE_ROOM_NOT_ATTACHED_TO_STUDIO' | phone binding mismatch (fallback 'PHONE_LINK_UNAVAILABLE') |
| model default | 'NATIVE_CALLER_REQUIRED' | set at model.mjs:59, always overwritten by the server |

Minimized Studio:
- HEAD: supported by design. Comment at battles.mjs:34-36; `ready:true`; visibility is judged per element. The browser test simulates `visibilityState` hidden (ROOT\test\battle-controls-browser.py:47-54).
- Running process (code state of 449f3e9): `if(document.visibilityState==='visible')for(const action of allowed){` and `ready:document.visibilityState==='visible'`. With Studio minimized it returns no buttons and `available:false`.
- No log records Studio's window state during the real clicks. Real minimized operation: not verified.

## 5. Idempotency and safety

- epoch: `snapshot.session.epoch`, sent back with every action. A mismatch gives SESSION_CHANGED (409).
- revision (HEAD, battles.mjs:88-90): sha256 of `[observationKey,generation]`, where observationKey is `[epoch, native.identity, battleId, battle status]`. generation increments whenever the key changes, so an identical screen in a later round gets a new revision. A stale revision gives BATTLE_CHANGED. The renderer re-checks identity at click time (battles.mjs:52).
- requestId: the same id returns the same promise; with a different signature it gives REQUEST_ID_CONFLICT. A new id with the same `[action,revision,epoch]` also returns the earlier promise (battles.mjs:107-108).
- 5-minute caches: battle `requests` and `revisions` (`expiresAt:this.now()+300000`, battles.mjs:112); invite `requests` (`this.now()+5*60000`, invites.mjs:53).
- Shorter: invite draft 30 s, single use; per-target cooldown 30 s after any send; at most 32 drafts.
- BATTLE_BUSY: one battle dispatch at a time; not cached. INVITE_BUSY: a dispatch in flight or the cooldown.
- 'awaiting_studio' means only that the DOM click ran: "Native click acknowledgement is never represented as peer acceptance." (battles.mjs:126). Real acceptance is the later `battle.status` change from 'pending' to 'open'. `battleStatus:'ONGOING'` never promotes a pending battle (control.test.mjs:27-30).
- Invite duplicate protection: two-step draft, requestId cache, `active` flag, cooldown, INVITATION_ALREADY_PENDING against the snapshot, exactly-one-button rule. An unobserved result is reported as 'unknown', never as success.

## 6. Verified with real accounts versus synthetic

Sources: ROOT\docs\LIVE-VERIFICATION.md, ROOT\docs\STUDIO.md, OTHER\runtime logs ("obs L" = native-live-observations.jsonl line, "act L" = native-live-actions.jsonl line).

| Flow | Status | Evidence |
|---|---|---|
| Co-host invite by search | Real, via updated modules run directly, not via the running panel | LIVE-VERIFICATION.md:10; act L8 (19:46:41Z, submitted:true, pending); obs L22-23 (succeeded and linked 5 s later). Who typed the query is not recorded; the adapter cannot type. |
| Co-host invite from Friends/Suggested via panel | Not found | A real invite went pending to succeeded at 19:39Z (obs L7-8; LIVE-VERIFICATION.md:9), but its origin is not recorded. |
| Accept incoming co-host invitation | No code | `accept:false,reject:false` (server.mjs:51); README.md:29; STUDIO.md:38 |
| Outgoing battle start | Real, through the running panel's HTTP API | act L3-4 (getStarted and match.start, http 200, dispatched); obs L16-18 (pending with inviter scope, then open); act L5 (`status:'open'`, `battleStatus:'ONGOING'`) |
| Accept incoming battle | Not verified | Detection is real: obs L13 shows role 'invitee' with accept and decline enabled. The user then accepted by hand; act L1 is `skipped: NO_CURRENT_INCOMING_INVITATION`. LIVE-VERIFICATION.md:17: "still have synthetic coverage only". |
| Decline incoming battle | Synthetic only | never attempted |
| Withdraw | Real, via the updated BattleController run directly | act L17-22: pending, withdraw dispatched, 'withdrawal-confirmed', cohostStillLinked true (19:50:00Z). An earlier try lost a race with phone acceptance (act L12-16). |
| Repeat rounds | Real | five distinct battle ids in one room within about 11 minutes (obs L10, L13, L17, L24; act L20) |
| Battle end detection | Real observation | Studio sets `battle` to null and returns to cohostModeSelect with the co-host still linked (obs L11, L15). The event rule (model.mjs:76-79) is HEAD-only and synthetic-tested. |
| Scores | Not available | "This panel does not include video, audio, scores or a battle timer" (README.md:29); "Scores stayed at zero" (LIVE-VERIFICATION.md:39) |

Camera, sources, scenes:
- Quote (LIVE-VERIFICATION.md:27): "Studio also reported a camera-only Co-host configuration error before successful play. Its scene had an Animaze camera, but the selected Co-host camera was null. During successful play, the native layout identified the selected camera source. No native Studio files or account permissions were modified to bypass this condition."
- Line 15: "The Studio side showed its virtual-camera image."
- Panel code: no camera, scene or source handling (no match in server.mjs or src).
- Logs: three different room ids between 19:25Z and 19:38Z with health 'initializing' in between, and four cancelled `quick_cohost` operations (obs L1-6); cause not recorded.
- PNGs: studio-silent-test.png is the RTMP test card ("MICROPHONE MUTED", "NO CAMERA"). real-battle-mobile-layout.png is the dashboard at 390 px during a real open battle.
- GW\STUDIO-CONNECT.md:18-24 describes the clean layers as browser source or virtual camera.

Automated: 38 root tests and 21 mobile tests passed (verify-root.txt, verify-mobile.txt). Browser test result: "(synthetic only)".

## 7. Panel UI (ROOT\dist\app.js)

- Hard-wired to the local origin: `local=…location.port==='47831'` (line 3). Every API call is skipped when not local.
- Polling: `setInterval(update,1800);setInterval(updateBattleControls,2400);setInterval(updatePhoneLink,5000)` (line 243). Timeouts: 4500 ms state, 7000 ms battles, 25000 ms POSTs.
- requestId: `crypto.randomUUID()` per click (lines 171, 214); never reused.
- Invite confirmation, two steps:
  1. Row button 'שלח הזמנה' (send invitation) calls POST /api/invites/prepare `{uid,epoch}`.
  2. Dialog 'לשלוח הזמנה ליוצר הזה?' shows name and @handle with 'שלח הזמנה' and 'ביטול' (cancel). Confirm calls POST /api/invites/send (lines 157-178).
- Battle actions have no confirmation: one tap posts the last polled revision and epoch (lines 210-219).
- Battle button labels (ROOT\src\battles.mjs:6-13):
| Action | Label | Meaning |
|---|---|---|
| match.select | 'באטל רגיל' | normal battle |
| match.individual.select | 'באטל אישי' | individual |
| match.team.select | 'באטל קבוצות' | teams |
| cohostMode.getStarted | 'המשך להגדרת הבאטל' | continue to setup |
| match.start | 'שלח הזמנת באטל' | send battle invitation |
| match.accept | 'קבל הזמנת באטל' | accept |
| match.decline | 'דחה הזמנת באטל' | decline |
| match.withdraw | 'בטל את הזמנת הבאטל' | withdraw |
- Status texts (line 186): 'התקבלה הזמנת באטל. אפשר לקבל או לדחות כאן.' (incoming), 'הזמנת באטל ממתינה לתשובת הצד השני.' (outgoing waiting). Receipt text: 'הפעולה הועברה ל־Studio. ממתינים לעדכון מצב הבאטל.' (line 215).
- Battle state labels (line 109): 'באטל פעיל', 'ממתין לאישור', 'הסתיים', 'בהכנה', 'אין באטל פעיל'.
- Search: the box 'חיפוש ברשימה שנטענה…' filters the loaded candidates locally (lines 55-61). It is not a TikTok search.
- Layout: breakpoint at 600 px in ROOT\dist\style.css. Real screenshot at 390 px; synthetic test at 430 px.

Essential for a phone remote:
- Status: `connected`, `live`, `battle.status`, linked co-host.
- Incoming card: scope role 'invitee' with match.accept and match.decline.
- Outgoing: mode buttons, getStarted, match.start.
- Waiting: match.withdraw (scope role 'inviter').
- Invite a creator: candidate rows where `inviteAvailable` is true and `state.actions.invite` is true, with the two-step confirmation.
- Optional: the Hebrew event feed.
- Leave out: the phone-link card, the focus-Studio button, help and download.

## 8. phone-link.mjs guard

- server.mjs:30: `const roomGuard=roomId=>phoneLink?.assertRoom(roomId);`
- ROOT\src\phone-link.mjs:57-60: `await this.loaded; if(this.binding&&this.binding.roomId!==studioRoomId)throw fail('PHONE_ROOM_NOT_ATTACHED_TO_STUDIO');`
- `binding` is set only by a successful import (line 93) or loaded from `runtime/phone-link.json` (lines 45-48). Unlink clears it (lines 79-80).
- Called in poll (server.mjs:52-53, which sets `invite=false` and the reason), in every invite fresh check (invites.mjs:15) and in every battle inspection (battles.mjs:80).

In our architecture (Studio owns the room, nothing imported): `binding` is null, so the guard is a no-op and blocks nothing. Facts now: OTHER\runtime has no phone-link.json and ROOT has no runtime folder. LIVE-VERIFICATION.md:43 says the phone destination "had been unlinked". The running process predates the guard entirely.

It becomes a hard block if a binding exists. Studio creates a new room per LIVE, so a stored binding always mismatches. Then /api/battles returns `available:false` with that error, and actions return 409, until unlink or file removal plus restart. The binding has no expiry.

## 9. Tests: faking Studio

- `createApp({port,service,polling,focus,nativeUi,battleUi,phoneLink})` (server.mjs:24) is fully injectable and returns `{server,poll,getState}`.
- HTTP pattern (control.test.mjs:76-89): reserve a free port; `createApp({port,service,polling:false,nativeUi:{async inspect(){return{ready:false};}}})`; `app.server.listen(port,'127.0.0.1')`. The `port` option must equal the listening port because of the Host check.
- Fake bridge service (control.test.mjs:72): `{close(){},async state(name,key){…}}` answering 'snapshot', 'providerReady', 'battleStatus', 'invitePanelState', 'linkedUsers', 'candidates.batches', 'userInfo'.
- Fake battle UI (ROOT\test\battles.test.mjs:7-12): `ui={inspect:async()=>structuredClone(native),act:async()=>{clicks++;}}` with `native={ready:true,identity:'invitation-456',scopes:[{role:'invitee',battleId:'456'}],buttons:[{action:'match.accept',enabled:true}]}` and snapshot `{health:'ready',session:{epoch:'room-epoch',roomId:'123'},battle:{battleId:'456',status:'pending'}}`.
- Fake invite UI (ROOT\test\invites.test.mjs:7-13): `{prepare,clickInvite}`; clickInvite pushes a `manual_cohost` operation into the fake snapshot.
- Fake DevTools (invites.test.mjs:62-74): injected `fetcher` returns one page target; an injected `Socket` (EventTarget) runs each expression with `vm.runInNewContext` against a fake `document`.
- Fake TCP bridge (control.test.mjs:56-64): `net.createServer` echoing newline-delimited JSON-RPC.
- Browser test (battle-controls-browser.py:85-100): Playwright fulfils `http://127.0.0.1:47831/**` with canned JSON for /api/state, /api/battles and /api/battles/action.

For the relay: start `createApp` with fakes on a random port and make the panel origin a relay parameter. From GW\test the import is `../../../server.mjs`. Gateway side: a remote phone is simulated with headers `{host:'phone.example','cf-connecting-ip':…}` plus pairing (GW\test\mobile.test.mjs:54-64).

## 10. Phone side that would host the remote

- GW\public\mobile\battle.js: `mountBattle(root)` fills `#live-battle` (GW\public\mobile\index.html:5, manage.html:14; mounted at app.js:197 and manage.js:64). It is telemetry only: "TikTok telemetry only: the host/opponent video is viewed on TikTok, not fabricated here." (line 2). It polls GET /api/workspace/tiktok every 2000 ms and has no write controls.
- GW\lib\mobile-live-events.mjs: battle state from public events `managedBattle` (lines 71-79), `linkMicBattle` (80-88), `linkMicArmies` (89-93). Status vocabulary is 'pending', 'active', 'ended', 'observed', with scores and `endTimeMs`. The panel uses 'pending' and 'open'.
- 501 route, GW\lib\mobile-workspace.mjs:127: `if(['/api/workspace/tiktok/invite','/api/workspace/tiktok/start-battle'].includes(p))return send(res,501,{error:'ACCOUNT_WRITE_CONNECTOR_REQUIRED',message:'לא הוגדר חיבור מורשה לשליחת הזמנות או לפתיחת באטל. קליטת אירועי לייב זמינה בנפרד.'});` It has no method check and runs after authentication.
- Capability flags, mobile-workspace.mjs:47: `startLive:false,invitations:false,startBattle:false,reason:'ACCOUNT_WRITE_CONNECTOR_REQUIRED'`, with features `live_start` and `battle_write` at `ready:false`. Asserted by GW\test\workspace.test.mjs:38 and :41.
- Gateway auth (GW\mobile-gateway.mjs): loopback requests become the 'local-desktop' session, otherwise the paired `wm_sid` cookie (lines 11, 25, 74); POST/PUT/DELETE need same origin (lines 26, 43).
- New static files must be added to the allowlist at mobile-gateway.mjs:67 and to SHELL in GW\public\mobile\sw.js:1.
- No bearer-ticket, live-link or WebRTC code exists on this branch (not found).

## GOTCHAS
- The panel process listening on 47831 right now is stale: it started 20:40:21 local, before commits 0b6892e, 68821ae, 9e3211a and 48c7d4f. Until someone restarts it, it has no minimized-Studio support, no search adapter, no /api/phone routes (404 NOT_SUPPORTED) and the old revision formula. Restarting changes the cookie token and wipes all in-memory caches. Stale state is inferred from process start time, commit times, the real screenshot and docs/LIVE-VERIFICATION.md:41; I did not connect to confirm.
- With the stale process, a second round within 5 minutes can return a cached `{dispatched:true,outcome:'awaiting_studio'}` without clicking, because the old revision is sha256([epoch, identity]). The real log shows it: at 19:47:13Z cohostMode.getStarted answered http 200 about 50 ms after the script began, and match.start never became available. HEAD fixes this with the generation counter.
- Accepting and declining an INCOMING battle through the panel is synthetic-only. The one real incoming invitation was accepted by hand before the automation ran. Whether `element.click()` works on Studio's real Accept and Decline buttons is unproven.
- `state.battle.incoming` is unreliable. In every real observation the raw bridge battle object held only battleId, participantUids and status, even for an invitation the adapter saw with role 'invitee'. Detect direction from GET /api/battles `scopes[].role` ('invitee' or 'inviter').
- The panel cannot do these things a phone-only creator needs: open the Co-host popup or Match panel, type a TikTok search into Studio (the panel search box only filters loaded rows), accept or reject incoming co-host requests (`accept:false,reject:false` hard-coded), run auto-match, start or end the LIVE, or end a running battle (no controls exist while a battle is open).
- Do not relay POST /api/phone/import, DELETE /api/phone or POST /api/focus-studio. Import overwrites the gateway RTMP target and arms the room guard, which then blocks every invite and battle action for any other Studio room. DELETE sends `{clear:true}` to the gateway RTMP config. focus-studio activates the Studio window on the server desktop.
- Relay request hygiene: target http://127.0.0.1:47831 literally (the panel binds IPv4 only and checks Host). Build headers from scratch; a forwarded phone Origin gives 403 ORIGIN_REJECTED. Send only `Cookie: boostera_session=<token>`. On 401 OPEN_PANEL_FIRST, redo GET / and retry. requestId must be lowercase hex and hyphens (36 chars), and the body at most 2048 bytes with Content-Type application/json.
- Never forward client-supplied paths to the panel. `new URL(req.url,…)` at server.mjs:66 is outside any try/catch in an async handler, so a malformed path such as `//` should throw, become an unhandled rejection and crash the panel under Node's default. This is from code reading; I did not execute it.
- Pre-click failures are cached for 5 minutes. If the inspection inside dispatch throws (for example BRIDGE_TIMEOUT), the rejected promise is stored under [action,revision,epoch]. The revision stays the same while Studio's UI is unchanged, so every retry of that action gets the same error without a new attempt. For a pending incoming invitation this can make Accept impossible until it expires. From code reading; no test covers it.
- The panel has no authentication beyond 'same machine'. Any local process can fetch the cookie with GET /, and port 9222 gives any local process full control of Studio's renderer and the signed-in account. The gateway relay is therefore the only real boundary for phones, and today every paired device (up to 12) shares the whole workspace.
- GET /api/battles is an active probe: two bridge reads and a new DevTools WebSocket per call. Poll it once on the server and fan out to phones. Battle action POSTs share one budget of 200 request ids per 5 minutes (429 BATTLE_RATE_LIMIT), shared with the desktop panel tab.
- Response quirks to handle: receipt `error` is a string in 'unknown' receipts and an object or null otherwise. `actions.reason` is null when `invite` is false because the LIVE is inactive or providerReady is false. The offline state reports version '0.1.0'. /api/battles can return `available:true` with no scopes and no actions.
- Environment assumptions are hard-coded: ports 47831, 9225, 9222 and 8801; the install path `C:/Program Files/TikTok LIVE Studio/<version>/resources/app/html/{main|popupMulti}/index.html`; the English placeholder `input[placeholder="Search"]`; Studio's `data-ix-*` and `data-cohost-*` attributes (tested on 1.39.6 only). Node 22 or newer is really required (global WebSocket in native-ui.mjs:2), although package.json and START.cmd say 20.
- The desktop UI cannot be reused on the phone as is. dist/app.js skips all API calls unless the page is on port 47831, and the CSP has `frame-ancestors 'none'`. A new remote UI must live in the gateway's /mobile app, be added to the static allowlist (mobile-gateway.mjs:67) and to sw.js SHELL. `crypto.randomUUID` needs a secure context on the phone.
- Test safety: `createApp` defaults to the real RpcClient(9225), NativeUi and NativeBattleUi. A relay test that does not inject `service`, `nativeUi` and `battleUi` (and `polling:false`) would talk to the real Studio on this machine. Do not run test/battle-controls-browser.py while the real panel is up; it uses the literal origin 127.0.0.1:47831.
- Co-host camera: Studio reported a 'camera-only Co-host configuration error' while 'the selected Co-host camera was null' (docs/LIVE-VERIFICATION.md:27). Our Chrome program page probably has to reach Studio as a selected camera-type source (for example a virtual camera) for co-host and battles to work. This is an inference from the doc note; the panel code does not touch cameras, scenes or sources.
- The gateway's own battle telemetry (public event reader) returned CONNECTION_FAILED_OR_SIGNING_REQUIRED for the Studio account because of account privacy (docs/LIVE-VERIFICATION.md:38). For a Studio-owned room, take battle status from the panel relay. The panel has no scores, timer or winner.
- Invite timing and side effects: /api/invites/send can block about 6 s; /api/invites/prepare may click the Friends or Suggested tab in Studio before the user confirms; the draft token lives 30 s and each target has a 30 s cooldown after any send attempt, including failed or unknown ones.
- The battle adapter's `enabled` uses `document.elementFromPoint` at the button centre and does not scroll. A control covered by a Studio overlay or outside the main window's viewport is reported disabled. After a battle ends the co-host link can also drop (seen at 19:45:38Z), which removes all battle controls.

## OPEN QUESTIONS
- Who restarts the panel so it loads HEAD, from which folder (ROOT or the other programmer's copy), and who owns its lifecycle afterwards? The earlier restart was rejected by an approval policy, and I was told not to restart anything.
- Does a real incoming battle invitation get accepted and declined by the adapter's `element.click()`, including with Studio minimized? This needs one real two-account test after the panel runs HEAD.
- How long does an incoming battle invitation stay open in Studio? It is not in the logs; the one real case was accepted by hand within 15 seconds. This decides whether polling (about 2 s panel plus phone polling) is fast enough or a push channel is needed.
- Does the incoming-invitation scope render in the main window when the Match panel is closed or Studio is minimized? The logs only show it while the match-start screen was already open.
- On an unattended server, what opens the Co-host popup and loads Friends or Suggested, and does the popup stay open across links and rounds? The panel has no control for this.
- Is accepting incoming CO-HOST requests from the phone required for the product? There is no adapter; such requests are at most visible as `candidates[].applied`, which never appeared in the logs.
- Should the phone offer mode selection (individual, teams)? The selectors exist, but only mode 'normal' with two participants was observed with real accounts.
- Which gateway sessions may send invitations and battle actions from the creator's real account? The signed bearer ticket mentioned in the brief does not exist on this branch.
- Will Studio accept the Chrome program page as the selected Co-host camera, and what does the opponent see during a battle? The only evidence is the doc note about the camera-only error and a virtual-camera image.
- Does the current Studio build return candidate rows from `candidates.batches`, or only the Map marker? This affects whether the phone can show names and handles before the native lists are opened.
- Is one Studio and one panel per machine acceptable? Ports and paths are hard-coded, so a second creator on the same machine would need code changes.
- Which side should own the relay's revision check: should the phone send the battleId it displayed so the relay can refuse to accept a different invitation than the one the creator saw?
