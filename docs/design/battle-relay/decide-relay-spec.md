# DECIDE: relay-spec

## DECISION
Choose (A): the gateway (port 8801) acts as a same-machine HTTP client of the one running panel at the literal origin http://127.0.0.1:47831. Reject (B), importing the panel's controllers into the gateway.

Why A:
1. One controller instance. The idempotency state is in memory per instance: `this.requests=new Map();this.revisions=new Map();this.active=false` (ROOT\src\battles.mjs:76) and `this.drafts=new Map();this.requests=new Map();this.cooldowns=new Map();this.active=false` (ROOT\src\invites.mjs:7). With B there would be two instances (the desktop panel process and the gateway), each with its own caches and `active` flag, so the desktop tab and the phone could each click the same Studio button. With A both go through one instance, where an identical `[action,revision,epoch]` returns the earlier promise instead of clicking again (battles.mjs:107-108).
2. InviteController needs the panel's own poll state (`getState:()=>state`, ROOT\server.mjs:31; used at invites.mjs:20,34). B would need a second poll loop against 9225 and 9222.
3. Blast radius. The gateway is the internet-facing process (Cloudflare quick tunnel, GW\mobile-gateway.mjs:128). With A it holds no DevTools client; it can only ask the panel for eight named actions and a numeric uid. With B the internet-facing process would hold `Runtime.evaluate` on the signed-in Studio renderer (ROOT\src\native-ui.mjs:31).
4. Coupling. A depends only on an HTTP contract that already has a test (ROOT\test\control.test.mjs:76-89) and real use: the other programmer's scripts bootstrap with `page=await fetch(origin),cookie=page.headers.get('set-cookie')?.split(';')[0]` (OTHER\runtime\withdraw-owned-invite.mjs:3) and logged http 200 (native-live-actions.jsonl L3, L4, L10). B couples us to another author's internals, which changed in five commits in one evening, and to its Node 22 global WebSocket (native-ui.mjs:2).

Costs accepted with A: the panel must be running, and from HEAD; a panel restart changes the cookie and wipes its caches; the panel has no build marker (version is '0.2.0' at commit 449f3e9 and at HEAD alike), so the relay cannot detect the stale process that is running now.

Other decisions:
- The phone never receives a raw panel payload. It gets a rebuilt, allowlisted snapshot with opaque references instead of numeric user, room and battle IDs, and an opaque `view` token instead of `revision` and `epoch`.
- Phone transport is conditional long-polling, not server-sent events. Cloudflare's Quick Tunnel page states "Quick Tunnels do not support Server-Sent Events (SSE)", and the gateway's tunnel is a quick tunnel (mobile-gateway.mjs:128-129).
- Two server-enforced steps for both kinds of invitation (co-host invite and battle invite). Accept, decline and withdraw are single taps.
- Writes are allowed only for the creator bound to this server (`LIVE_CREATOR_ID`), and accept, send and invite also require that her session is the current camera publisher of the live link. Decline and withdraw work even if the camera link dropped. The loopback session is read-only by default.
- Verify, act, verify: a fresh panel read before each click, one click per request, and the result is confirmed only by observed state. A write-ahead, append-only audit line precedes every click.
- The relay is off unless `LIVE_BATTLE_RELAY=1` and `LIVE_CREATOR_ID` are set.

## SPEC
# Phone battle relay: specification (design only, no code)

Basis. Read-only work. No file was created or changed, no process was started, and nothing was sent to ports 9222, 9225 or 47831. Paths: ROOT = C:\My Web Sites\boostera-live-studio-web (branch integration/stage-and-ingest, HEAD b03aa14); GW = ROOT\server-integration\wanna-studio-server; OTHER = C:\Users\shk\Projects\boostera-live-studio-web. Log lines are cited as "obs L" (native-live-observations.jsonl) and "act L" (native-live-actions.jsonl), read with all values masked.

Missing dependency. GW has no live-link, WebRTC or bearer-ticket code on this branch (not found outside node_modules). `auth()` knows only loopback and the paired cookie: `function auth(req){return localRequest(req,port)?localSession:sessions.get(cookies(req).wm_sid);}` (GW\mobile-gateway.mjs:25). Section 3 states what the relay needs from that module.

## 0. Scope and invariants

In scope: status; accept or decline an incoming battle; send a battle to the linked co-host; withdraw a pending battle; invite a creator to co-host.

Out of scope in v1, because the panel has no adapter: opening Studio's Co-host popup or Match panel, typing a TikTok search, accepting incoming co-host requests, mode selection (individual, teams), ending a battle, starting or ending the LIVE, scores and timer.

Invariants (each one is a test):
1. A native click happens only as the direct result of one creator tap. The relay has no rule, timer or retry that clicks.
2. At most one native click per HTTP request.
3. A POST to the panel is never repeated automatically, except once after `401 OPEN_PANEL_FIRST` (the panel answers that before reading the body, ROOT\server.mjs:68).
4. Nothing is queued while the panel is offline.
5. Nothing from the phone is forwarded verbatim except a validated requestId. Paths, headers, uids, epochs and revisions sent to the panel are produced by the gateway.
6. The phone gets a snapshot rebuilt from an allowlist, never a panel payload.
7. A receipt never claims that the peer accepted; only observed state does ("Native click acknowledgement is never represented as peer acceptance.", ROOT\src\battles.mjs:126).
8. The relay requests only `/`, `/api/state`, `/api/battles`, `/api/battles/action`, `/api/invites/prepare`, `/api/invites/send`. Never `/api/phone*`, `/api/focus-studio`, `/api/refresh`. It never talks to 9222 or 9225.
9. The audit "attempt" line is on disk before the panel POST; if it cannot be written, the action is refused.

## 1. Files and switches

New: GW\lib\battle-panel-client.mjs, GW\lib\battle-relay.mjs, GW\lib\battle-audit.mjs, GW\public\mobile\battle-bar.js, GW\test\battle-relay.test.mjs.

Changed:
- GW\mobile-gateway.mjs: option `battleRelay` on `createMobileGateway` (injectable for tests); one hook after line 74 (`const session=auth(req);if(!session)return send(res,401,{error:'PAIRING_REQUIRED'});`) that routes decoded paths starting with `/api/live/battle/` or `/api/live/cohost/`; add `'battle-bar.js'` to the allowlist at line 67.
- GW\public\mobile\sw.js:1: add `/mobile/battle-bar.js` to SHELL and bump `CACHE` from 'wanna-fx-mobile-v5'.
- GW\public\mobile\workspace.css: bar styles (no new CSS file to allowlist).
- GW\package.json: the `test` script lists files one by one, so add test/battle-relay.test.mjs.

Untouched: the 501 route (GW\lib\mobile-workspace.mjs:127) and the flags `invitations:false,startBattle:false` (mobile-workspace.mjs:47), which tests assert (GW\test\workspace.test.mjs:38,41). GW\public\mobile\battle.js stays the telemetry card.

Switches, in the opt-in style of `VARDY_INGEST` (GW\lib\vardy-ingest.mjs:103-108): `LIVE_BATTLE_RELAY=1`; `LIVE_CREATOR_ID` (required; without it the relay stays off); `LIVE_CREATOR_TIKTOK_UID` (optional, digits); `LIVE_BATTLE_LOCAL_WRITES=1` (development only). The panel origin is a constant, not an environment value; only tests may inject another loopback origin.

## 2. Server-side panel client

Target: `http://127.0.0.1:47831` literally. The panel binds IPv4 only (`server.listen(port,'127.0.0.1',…)`, ROOT\server.mjs:130) and checks Host (`if(!new Set(['127.0.0.1:'+port,'localhost:'+port]).has(req.headers.host))return false;`, server.mjs:17). The constructor throws `INVALID_PANEL_ORIGIN` unless protocol is http and hostname is 127.0.0.1.

Transport: `node:http` request with a header object built from scratch, as the gateway's own `proxy()` does (mobile-gateway.mjs:27-28). Headers sent: Host (set by Node), `Cookie: boostera_session=<token>`, `Accept: application/json`, and on POST `Content-Type: application/json` and `Content-Length`. Nothing else: no Origin, Referer, Sec-Fetch-*, X-Forwarded-*, Authorization, User-Agent passthrough or phone cookie. Redirects are not followed. Responses must be JSON and at most 1 MiB, else `PANEL_PROTOCOL_ERROR`.

Bootstrap: lazily, `GET /`. Require status 200 and a `set-cookie` whose part before the first `;` matches `^boostera_session=[a-f0-9]{64}$` (panel: server.mjs:103). Keep it in memory only; never log it, store it or send it to the phone. One shared in-flight bootstrap (single-flight).

Re-bootstrap: on `401 OPEN_PANEL_FIRST`, drop the cookie, bootstrap, repeat the same request once with the same body. A second 401 gives internal `PANEL_AUTH_FAILED`, reported as `PANEL_OFFLINE`. A 403 `ORIGIN_REJECTED` is a relay bug or a foreign program on the port: `PANEL_PROTOCOL_ERROR`, no retry.

Timeouts:
| Call | Timeout | On timeout |
|---|---|---|
| GET / | 2000 ms | panel OFFLINE |
| GET /api/state | 2500 ms | keep last snapshot, mark stale |
| GET /api/battles | 7000 ms (same as the panel UI, ROOT\dist\app.js:203) | stale |
| POST /api/battles/action | 15000 ms | 504 PANEL_TIMEOUT; audit result UNCERTAIN |
| POST /api/invites/prepare | 8000 ms | 504 PANEL_TIMEOUT (prepare never clicks Invite) |
| POST /api/invites/send | 20000 ms (the panel observes up to 6000 ms, invites.mjs:6) | 504 PANEL_TIMEOUT; UNCERTAIN |

Offline: connection refused, reset before a response, or bootstrap timeout sets panel OFFLINE. The poller backs off 1 s, 2 s, 5 s. Writes answer `503 PANEL_OFFLINE` at once. The relay never starts or restarts the panel.

Concurrency: one "battle channel" mutex. A `/api/battles` GET and a `/api/battles/action` POST from the relay never overlap, because every `inspect()` can bump `generation` (battles.mjs:88-89). The poller skips its tick while a POST is in flight.

## 3. Identity and per-action authorization

The relay consumes one function from the live-link module, evaluated on every request (never cached from an earlier read):

```
actor = { kind:'ticket'|'paired'|'local', sessionId, role:'creator'|'device'|'operator',
          creatorId|null, ttUid|null, scopes:[…], expiresAt,
          link:{ id|null, state:'publishing'|'connecting'|'idle' } }
```
- ticket: claims verified by the live-link module; role creator; `creatorId` = subject; needs scope `live:battle`; optional TikTok uid claim.
- paired: the existing `wm_sid` session. Role creator only if the pairing code was issued as a creator code on the local setup page (`/api/mobile/pairing-code` is already local-only, mobile-gateway.mjs:47-50). Only one creator-paired session at a time; a new one demotes the old one. All other paired devices (up to 12, GW\lib\mobile-session.mjs:11) are role device.
- local: the loopback session `local-desktop` (mobile-gateway.mjs:23); role operator.

Rules, checked in this order before any panel call:
| Check | Failure |
|---|---|
| session exists | 401 PAIRING_REQUIRED (existing) or 401 LIVE_TICKET_INVALID |
| POST is same-origin | 403 ORIGIN_REJECTED (existing gate, mobile-gateway.mjs:43) |
| role is creator (GET also allows local) | 403 NOT_CREATOR_SESSION |
| `actor.creatorId === LIVE_CREATOR_ID` | 403 CREATOR_NOT_BOUND_TO_SERVER |
| ticket has scope `live:battle` and is not expired | 403 BATTLE_SCOPE_REQUIRED, 401 LIVE_TICKET_INVALID |
| local session on a write | 403 LOCAL_SESSION_READ_ONLY (unless LIVE_BATTLE_LOCAL_WRITES=1) |
| link state, per the table below | 409 LIVE_LINK_REQUIRED |
| expected TikTok uid (ticket claim, else LIVE_CREATOR_TIKTOK_UID) equals the panel's `session.selfUid` | 409 STUDIO_ACCOUNT_MISMATCH |

`session.selfUid` is present in real panel state: the real-run script compares it (OTHER\runtime\withdraw-owned-invite.mjs:8) and then acted with http 200 (act L10). It never leaves the server.

| Operation | Link must be publishing |
|---|---|
| GET state, GET candidates | no |
| ACCEPT, battle prepare, SEND, invite prepare, invite send | yes |
| DECLINE, WITHDRAW | no (she must be able to back out if the camera link dropped) |

## 4. Poller, snapshot and what is filtered

One poller in the gateway, fanned out to phones.
- Subscribed (a creator state request in the last 15 s): every 1500 ms read `/api/state`, then `/api/battles` if connected and live.
- For 6 s after any action: every 400 ms.
- Not subscribed: `/api/state` every 10 s, no `/api/battles` (it is an active probe that opens a DevTools session per call).
- `stale` is true when the last good read is older than 5000 ms or `now - observedAt > 6000`.

Never sent to the phone: the panel cookie; `session.selfUid`, `roomId`, `epoch`; every candidate `uid`, `roomId`, `avatar`, `sources`; `battle.id`, `participantUids`; scope `battleId`, `channelId`, `teams`, `giftType`, `giftId`; `revision`; `operations[]`; `events[]` (their details embed IDs: `detail:'מזהה '+next.battle.id`, ROOT\src\model.mjs:75); `self`; `coverage`; `providerReady`; `panelReady`; `health`; `version`; `draftToken`; raw panel error messages.

Sent: display name and handle of linked co-hosts and of invitable candidates (needed for an explicit confirmation), after cleaning: control and bidi characters removed, name at most 40 characters, handle must match `^[a-zA-Z0-9_.]{1,30}$` or it is dropped. A name that is only digits is dropped, because the panel falls back to the uid (`name:target.name||target.handle||uid`, invites.mjs:41). A candidate with neither name nor handle is not listed.

Opaque values (key = 32 random bytes per gateway process):
- `ref` for a candidate: 'c_' + 16 base64url characters of HMAC-SHA256(key, epoch|uid). The gateway keeps the ref-to-uid map for the current epoch.
- `battle.ref`: 'b_' + 8 characters of HMAC(key, battleId).
- `view`: 'v_' + 22 characters of HMAC(key, JSON([epoch, kind, battleId, role, sortedLinkedUids])). It binds what she saw in meaning, not the panel's `revision`. The relay recomputes it on a fresh read and sends the fresh `revision` to the panel. A different invitation gives BATTLE_CHANGED; a flicker of a button's `enabled` flag does not.

Snapshot:
```
{ v:'s_<16>', at:<ms>, ageMs:<int>, stale:<bool>, live:<bool>,
  stage:<enum>, hint:<enum>|null,
  battle: null | { ref, status:'PENDING'|'ACTIVE', direction:'INCOMING'|'OUTGOING'|'UNKNOWN',
                   with:[{name,handle}], firstSeenAt:<ms> },
  cohost: { linked:[{name,handle}], pendingInvites:<int>, incomingRequests:<int>, inviteReady:<bool> },
  actions:[ {id:'ACCEPT'|'DECLINE'|'WITHDRAW'|'SEND'|'INVITE', enabled:<bool>} ],
  view:'v_<22>'|null,
  lastAction: null | { requestId, action, state:'SENT'|'CONFIRMED'|'NOT_CONFIRMED'|'RACE_LOST'|'UNCERTAIN', at },
  me:{ canWrite:<bool>, block:null|'LIVE_LINK_REQUIRED'|'LOCAL_SESSION_READ_ONLY' } }
```
`v` is a hash of everything except `at` and `ageMs`.

Stage, first match wins (S = /api/state, B = /api/battles):
| Stage | Condition |
|---|---|
| PANEL_OFFLINE | panel unreachable |
| STUDIO_OFFLINE | `S.connected===false` (error BRIDGE_UNAVAILABLE or CONNECTING) |
| ACCOUNT_MISMATCH | expected uid differs from `S.session.selfUid` |
| NOT_LIVE | connected and `!S.live` |
| STUDIO_NOT_READY | live and `S.health!=='ready'`, or `B.error==='STUDIO_NOT_READY'` |
| ROOM_GUARD_BLOCKED | PHONE_ROOM_NOT_ATTACHED_TO_STUDIO in `B.error` or `S.actions.reason` |
| BATTLE_ACTIVE | `S.battle.status==='open'` |
| BATTLE_INCOMING | a B scope with `role==='invitee'` |
| BATTLE_OUTGOING | a B scope with `role==='inviter'` |
| BATTLE_PENDING | `S.battle.status==='pending'` and no invitation scope (real: obs L24, about 1 s after a start click) |
| COHOST_LINKED | at least one candidate with `linked` |
| COHOST_INVITE_PENDING | a candidate with `invited`, or a pending manual_cohost operation |
| LIVE_SOLO | otherwise |

Direction comes only from `scopes[].role`. `state.battle.incoming` is ignored: it is `Boolean(s.battle.incoming)` (model.mjs:49) and was never set in real data. `battleStatus==='ONGOING'` never promotes a pending battle.

Actions listed:
- ACCEPT, DECLINE: invitee scope and the native `match.accept`, `match.decline` listed.
- WITHDRAW: inviter scope and `match.withdraw`.
- SEND: stage COHOST_LINKED, exactly one linked co-host, no battle, and either a `matchStart` scope with `match.start` enabled, or a `cohostModeSelect` scope with mode 'normal' and `cohostMode.getStarted` enabled. Both screens are in the real logs (obs L8, L9); 'normal' was preselected every time (obs L8, L11, L15, L23).
- INVITE: stage LIVE_SOLO; enabled when `S.actions.invite===true`.
- All are `enabled:false` when stale, or when retry is blocked (section 6).

`lastAction` (set by the poller, also written to the audit as an "effect" line):
| Action | CONFIRMED when | Otherwise |
|---|---|---|
| ACCEPT | `S.battle.status==='open'` | invitation gone and no battle: NOT_CONFIRMED; 8 s without change: NOT_CONFIRMED |
| DECLINE | no invitee scope for that battle and no battle | 8 s: NOT_CONFIRMED |
| WITHDRAW | no inviter scope and no battle (real: 1.2 s, act L21-22) | battle open: RACE_LOST (real: act L15-16 with obs L25) |
| SEND | inviter scope or a pending battle appears (real: 1.6 s, act L13-14) | 6 s: NOT_CONFIRMED |

NOT_CONFIRMED also catches the stale panel's cached acknowledgement that clicks nothing.

## 5. Endpoints

Common. JSON; `Cache-Control: no-store`; `X-Content-Type-Options: nosniff` (the gateway's `send`, mobile-gateway.mjs:24). POST: `Content-Type: application/json`, at most 1024 bytes, an object with no unknown keys; otherwise 415 JSON_REQUIRED, 413 BODY_TOO_LARGE, 400 INVALID_JSON, 400 INVALID_REQUEST. Unknown subpath 404 NOT_FOUND. Wrong method 405 METHOD_NOT_ALLOWED with `Allow`. Relay off: 404 BATTLE_RELAY_DISABLED. Error body: `{error, retryAfterMs?, snapshot?}`; a 409 carries a fresh snapshot when one exists. All section 3 failures apply to every endpoint. Routes are matched by exact string on the decoded path; no part of the path reaches the panel.

E1. `GET /api/live/battle/state?since=<v>&wait=<0..8>`
- 200 snapshot. 204 when `since` equals the current `v` after waiting `wait` seconds (default 0).
- Upstream trouble is a stage, not an HTTP error.
- 429 RATE_LIMITED.

E2. `POST /api/live/battle/prepare` body `{view}` (first step of sending a battle)
- Verify on a fresh read: view matches, SEND listed and enabled.
- If Studio shows `cohostModeSelect`: click `cohostMode.getStarted` once (server-generated requestId), then read `/api/battles` every 300 ms for up to 3000 ms until `matchStart` with `match.start` enabled. The real runs waited 1.0 to 1.6 s between the two clicks (act L3-4, L12-13, L18-19). This is navigation inside Studio; no invitation is sent.
- 200 `{confirm:'c_<32>', view, opponent:{name,handle}, expiresAt: now+20000}`.
- 409 BATTLE_CHANGED, BATTLE_ACTION_UNAVAILABLE, MATCH_START_NOT_READY, BATTLE_BUSY, RETRY_BLOCKED, NOT_LIVE, STUDIO_NOT_READY, SESSION_CHANGED, ROOM_GUARD_BLOCKED, STUDIO_ACCOUNT_MISMATCH, LIVE_LINK_REQUIRED. 429 BATTLE_RATE_LIMIT. 502 PANEL_ERROR, PANEL_PROTOCOL_ERROR. 503 PANEL_OFFLINE, STUDIO_OFFLINE, STUDIO_CONTROLS_UNAVAILABLE. 504 PANEL_TIMEOUT. 500 AUDIT_UNAVAILABLE.

E3. `POST /api/live/battle/action` body `{action:'ACCEPT'|'DECLINE'|'WITHDRAW'|'SEND', view, requestId, confirm?}` (`confirm` required for SEND and forbidden otherwise)
- Order: validate, authorize, rate limit, relay idempotency lookup, take the battle mutex (else 409 BATTLE_BUSY), audit attempt, verify on a fresh `/api/battles` (same view; action listed and enabled; ACCEPT and DECLINE need role invitee, WITHDRAW needs inviter; SEND needs `matchStart`, the same single opponent as at prepare, and no battle), then one `POST /api/battles/action {action:<native>, revision:<fresh>, epoch:<fresh>, requestId}`.
- Native names: ACCEPT `match.accept`, DECLINE `match.decline`, WITHDRAW `match.withdraw`, SEND `match.start`.
- 200 `{requestId, action, result:'SENT'|'UNCERTAIN', snapshot}`. SENT is the panel's `{dispatched:true,outcome:'awaiting_studio'}`. UNCERTAIN is `{dispatched:null,outcome:'unknown',error:'BATTLE_ACTION_UNCERTAIN'}`.
- Errors as E2, plus 409 CONFIRMATION_REQUIRED, CONFIRMATION_EXPIRED, REQUEST_ID_CONFLICT.

E4. `GET /api/live/cohost/candidates`
- 200 `{v, ready:<bool>, hint, rows:[{ref,name,handle,group:'FRIENDS'|'SUGGESTED'|'SEARCH'}], truncated:<bool>}`.
- Rows only where `inviteAvailable && !linked && !invited`; at most 300 (the panel's own cap, model.mjs:41).
- The phone filters locally. No search text goes into a URL or to the panel; the panel's search box is also a local filter (dist/app.js:55-61).
- 503 PANEL_OFFLINE, STUDIO_OFFLINE. 429 RATE_LIMITED.

E5. `POST /api/live/cohost/invite/prepare` body `{ref}`
- Resolve ref to uid in the current epoch (else 409 CANDIDATE_NOT_FOUND, no panel call). Require `S.actions.invite` (else 409 OPEN_COHOST_PANEL, STUDIO_NOT_READY or NOT_LIVE). Then `POST /api/invites/prepare {uid, epoch}`.
- 200 `{confirm:'c_<32>', name, handle, expiresAt}`. `expiresAt` is the panel's (30 s, invites.mjs:38) minus 2000 ms. The panel's `draftToken` stays on the server.
- Side effect to know: prepare may click the Friends or Suggested tab in Studio's popup (native-ui.mjs:62-65).
- 409 SESSION_CHANGED, STUDIO_NOT_READY, TARGET_UNAVAILABLE, INVITATION_ALREADY_PENDING, INVITE_BUSY, OPEN_COHOST_PANEL, TARGET_NOT_IN_STUDIO_LIST, INVITE_DISABLED_IN_STUDIO, ROOM_GUARD_BLOCKED, LIVE_LINK_REQUIRED. 429 INVITE_RATE_LIMIT. 5xx as E2.

E6. `POST /api/live/cohost/invite/send` body `{confirm, requestId}`
- Then `POST /api/invites/send {uid, epoch, draftToken, requestId}`.
- 200 `{requestId, result:'PENDING'|'LINKED'|'REJECTED'|'CANCELLED'|'UNCERTAIN', reasonCode?, snapshot}`. `reasonCode` is the panel's `error.code` if it matches `^[A-Za-z0-9_]{1,40}$`; the free-text message is not forwarded.
- Errors as E5, plus 409 CONFIRMATION_EXPIRED, REQUEST_ID_CONFLICT.

## 6. Mapping panel answers to relay codes

| Panel answer | Relay answer |
|---|---|
| 409 BATTLE_CHANGED, SESSION_CHANGED, BATTLE_ACTION_UNAVAILABLE, BATTLE_BUSY, STUDIO_NOT_READY, REQUEST_ID_CONFLICT, CONFIRMATION_EXPIRED, INVITE_BUSY, TARGET_UNAVAILABLE, INVITATION_ALREADY_PENDING, OPEN_COHOST_PANEL | same code, 409 |
| 409 PHONE_ROOM_NOT_ATTACHED_TO_STUDIO | 409 ROOM_GUARD_BLOCKED |
| 409 SELF_INVITE_NOT_ALLOWED | 409 TARGET_UNAVAILABLE |
| 409 REFRESH_CANDIDATES | 409 CANDIDATE_NOT_FOUND |
| 409 TARGET_NOT_IN_NATIVE_LIST | 409 TARGET_NOT_IN_STUDIO_LIST |
| 409 NATIVE_INVITE_DISABLED, AMBIGUOUS_NATIVE_TARGET | 409 INVITE_DISABLED_IN_STUDIO |
| 409 NATIVE_LIST_UNAVAILABLE, NATIVE_PANEL_UNAVAILABLE (invite routes) | 409 OPEN_COHOST_PANEL |
| 429 BATTLE_RATE_LIMIT | 429 BATTLE_RATE_LIMIT, retryAfterMs 30000 |
| 503 NATIVE_* or INVALID_NATIVE_ENDPOINT (battle route) | 503 STUDIO_CONTROLS_UNAVAILABLE |
| 503 BRIDGE_TIMEOUT, BRIDGE_CLOSED, socket errors | 503 STUDIO_OFFLINE |
| 400, 403, 413, 415, non-JSON, oversize | 502 PANEL_PROTOCOL_ERROR |
| any other code | 502 PANEL_ERROR (the raw code is logged, not sent) |

Retry block. The panel stores the dispatch promise, including a rejected one, for five minutes under `[action,revision,epoch]` (battles.mjs:111-113), and a new requestId with the same signature gets that same promise (battles.mjs:107-108). So after a failure answer from `/api/battles/action` other than BATTLE_BUSY, BATTLE_RATE_LIMIT and REQUEST_ID_CONFLICT (those are thrown before caching), a retry on an unchanged screen cannot click. The relay remembers that signature for 300 s. While the fresh revision still matches, it answers 409 RETRY_BLOCKED without calling the panel, lists the action as disabled and sets hint CONTROL_BLOCKED_IN_STUDIO. This rule goes away when the author stops caching rejections.

## 7. Rate limits (gateway side, per creator session)

| What | Limit | Answer |
|---|---|---|
| GET state | 4 per second, burst 8; 2 waiting long-polls per session, 16 in total | 429 RATE_LIMITED |
| GET candidates | 1 per second | 429 RATE_LIMITED |
| battle prepare and action together | 6 per 30 s and 40 per 5 min | 429 BATTLE_RATE_LIMIT |
| invite prepare | 6 per minute | 429 INVITE_RATE_LIMIT |
| invite send | 3 per minute and 20 per hour | 429 INVITE_RATE_LIMIT |
| in flight | one battle operation and one invite operation | 409 BATTLE_BUSY, INVITE_BUSY |

Each 429 carries `Retry-After` and `retryAfterMs`, and makes no panel call. 40 per 5 minutes leaves room in the panel's shared budget (`if(this.requests.size>=200)throw new InviteError('BATTLE_RATE_LIMIT',429);`, battles.mjs:106) for the desktop tab. The panel's own 30 s per-target invite cooldown (invites.mjs:51) still applies and surfaces as INVITE_BUSY.

## 8. Two-step confirmation for sending invitations

Both kinds of invitation need a server-issued `confirm` token. A dialog on the phone alone is not enough.
- Token: 24 random bytes, kept only in gateway memory, bound to `actor.sessionId`, single use, marked used before the panel call (a failed send means preparing again).
- Co-host invite: token maps to `{draftToken, uid, epoch}`; lifetime is the panel's 30 s minus 2 s.
- Battle invite: token maps to `{epoch, opponentUid}`; lifetime 20 s. At send time the relay re-verifies on fresh state: same epoch, the same single linked opponent, no battle, `matchStart` shown, `match.start` enabled. It uses the fresh revision, so a cosmetic change between the two steps does not cancel the send, but a different opponent does.
- Missing token: 409 CONFIRMATION_REQUIRED. Unknown, expired, used, or from another session: 409 CONFIRMATION_EXPIRED.
- Accept, decline and withdraw are single taps: they answer something on screen and accept is time-critical.

## 9. Request IDs and idempotency

Phone:
- `crypto.randomUUID()`. Fallback when it is missing (insecure context): 16 bytes from `crypto.getRandomValues`, version and variant bits set, lower-case hex with hyphens.
- One id per confirmed intent: the tap on accept, decline or withdraw, or the tap on the confirm button for send and invite.
- Reuse the same id only when re-sending the identical request after a transport failure with no HTTP response: at most 2 re-sends within 5 s. Any HTTP response ends the attempt. A new tap always gets a new id.

Gateway:
- Validate `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; the panel accepts `/^[a-f0-9-]{36}$/` (battles.mjs:101, invites.mjs:45).
- Keep `requestId -> {signature, promise}` for 5 minutes. Same id and same signature returns the same result without a panel call. Same id with a different action or view: 409 REQUEST_ID_CONFLICT.
- Only attempts that reached the panel are cached. Auth, rate-limit and BATTLE_BUSY failures are not.
- Forward the same id to the panel so both logs correlate. The panel's own caches then also protect across a gateway restart: the same id on a changed screen gets REQUEST_ID_CONFLICT (battles.mjs:105).

## 10. Audit log

File: `<workspaceRoot>\data\live-battle-audit.jsonl`. The data folder already exists (mobile-workspace.mjs:25) and is git-ignored (ROOT\.gitignore, "data/"). Tests get a temporary folder through `workspaceRoot`.

- Append only: one JSON object per line, written with an awaited append through a single-writer queue, file mode 0o600. The gateway never rewrites, truncates or deletes it. At 5 MB the file is renamed with a timestamp and a new file continues the chain.
- Tamper evidence: each line has `seq` and `prev` (SHA-256 of the previous line; 64 zeros for the first).
- Events: `attempt` (before the panel POST; failure to write gives 500 AUDIT_UNAVAILABLE and no panel call), `result`, `effect`, `denied` (authorization or rate-limit refusals on write endpoints, at most one line per session and code per 10 s).
- Fields: `seq, ts, prev, event, requestId, op, actor:{kind, sid, creatorId}, target, nativeAction, panelHttp, panelOutcome, result, code, ms`.
  - `op`: BATTLE_ACCEPT, BATTLE_DECLINE, BATTLE_WITHDRAW, BATTLE_PREPARE, BATTLE_SEND, COHOST_INVITE_PREPARE, COHOST_INVITE_SEND.
  - `sid`: first 16 hex of SHA-256(sessionId).
  - `target`: first 16 hex of HMAC-SHA256(auditKey, uid or battleId), or null.
  - `auditKey`: 32 random bytes in `<workspaceRoot>\data\live-battle-audit.key`, created once.
- Never stored: names, handles, raw user, room or battle IDs, epoch, revision, tokens, cookies, IP address, user agent. Reads are not audited.

## 11. When Studio's required panel is not open

The panel cannot open Studio's Co-host popup or Match panel, so the relay reports a clear state and never guesses.
| Hint | Condition | Effect |
|---|---|---|
| OPEN_COHOST_PANEL | stage LIVE_SOLO and `S.actions.reason==='OPEN_COHOST_PANEL'` (server.mjs:51) | INVITE disabled; E5 answers 409 OPEN_COHOST_PANEL |
| OPEN_MATCH_PANEL | stage COHOST_LINKED with `B.available` but no usable SEND path, or stage BATTLE_PENDING for more than 4 s | SEND not listed, or no accept and decline buttons |
| CONTROL_BLOCKED_IN_STUDIO | an action is listed with `enabled:false` (the adapter hit-tests the button centre and does not scroll, battles.mjs:23-24), or retry is blocked | button disabled |
| STUDIO_CONTROLS_UNAVAILABLE | `B.error` is a NATIVE_* code | no battle buttons |
| COHOST_REQUEST_IN_STUDIO | candidates with `applied` | count only; cannot be accepted from the phone |
| STATE_STALE | `stale` | all buttons disabled |

When `S.actions.invite` is false and `reason` is null (not live, or provider not ready), the stage is NOT_LIVE or STUDIO_NOT_READY, not OPEN_COHOST_PANEL.

## 12. Polling versus server-sent events

Decision: conditional long-polling on E1. No SSE for this feature.
- The public route is a Cloudflare quick tunnel (`['tunnel','--url','http://127.0.0.1:'+port,…]`, mobile-gateway.mjs:128). Cloudflare's Quick Tunnel page (developers.cloudflare.com, Cloudflare Tunnel, TryCloudflare) says "Quick Tunnels do not support Server-Sent Events (SSE)" and "Each Quick Tunnel supports up to 200 in-flight requests".
- The existing `EventSource('/api/mobile/events')` (GW\public\mobile\app.js:135) is therefore not evidence that SSE reaches a phone through the tunnel: not verified.
- A long-poll is an ordinary complete response. The snapshot is under 2 KB and versioned. One creator phone holds one or two requests.
- Phone loop: `GET …/state?since=<v>&wait=8`, client timeout 12 s; request again right after a 200 or a 204; on a network error back off 1, 2, 4 s; stop while `document.hidden`; on return fetch once without `since`.
- Expected delay from Studio rendering an incoming invitation to the phone showing it: at most about 2 s (1.5 s poll plus network). Whether that is enough depends on the invitation lifetime, which is not known (section 15).
- The snapshot is transport-neutral. The live-link signalling channel may later push the same object; E1 stays the source of truth and the fallback.

## 13. Phone UI: the battle bar

Module `GW\public\mobile\battle-bar.js`, export `mountBattleBar(root,{getAuthHeaders})`, returning an unmount function (same pattern as `mountBattle`, battle.js:3,24). `getAuthHeaders` is supplied by the live-link module (bearer ticket) and is empty for cookie sessions. The live capture screen mounts the bar as the last child of the capture stage (today `#stage`, GW\public\mobile\index.html:6). The bar hides itself on 404 BATTLE_RELAY_DISABLED and on 403 NOT_CREATOR_SESSION.

Layout: right-to-left; one row 56 px high above the camera tools, inside the safe area; it never covers the face area of the preview. From the right: a status dot (grey unavailable, green ready, amber pending, red active), one line of status text with ellipsis, then at most two buttons with touch targets of at least 48 px. In stage BATTLE_INCOMING the bar grows to a two-row card with a large primary accept and a secondary decline, shows "elapsed N seconds" from `battle.firstSeenAt` (no countdown: the expiry is unknown), and vibrates once where supported.

Buttons by stage:
| Stage | Buttons |
|---|---|
| LIVE_SOLO | Invite (opens the invite sheet); disabled with the hint when `cohost.inviteReady` is false |
| COHOST_INVITE_PENDING | none (the panel has no cancel for co-host invites) |
| COHOST_LINKED | Send battle when SEND is listed |
| BATTLE_INCOMING | Accept, Decline |
| BATTLE_OUTGOING | Withdraw |
| BATTLE_PENDING, BATTLE_ACTIVE, and all unavailable stages | none; status text and hint only |

Send battle: tap, E2 prepare (button shows a spinner), then a confirm sheet with the opponent's name and handle and Send or Cancel, then E3.

Invite sheet (a `<dialog>`, as `#install-dialog` is used at index.html:22): a search box that filters the E4 rows locally by name and handle; rows show name, @handle and a group chip; the list refreshes every 5 s while open. Tapping a row calls E5, then the same sheet shows the confirmation with name, @handle, the seconds left on the token, and Send invitation or Cancel; then E6 (client timeout 25 s).

Behaviour:
- No optimistic state: the bar shows "battle started" only when the snapshot says ACTIVE.
- While a request is in flight all bar buttons are disabled and further taps are ignored.
- After `SENT` the status shows the receipt line until `lastAction` resolves.
- When `me.canWrite` is false the buttons are disabled and the block reason is shown.
- All names are written with `textContent`. Avatars are not shown: the mobile pages' policy is `img-src 'self' data: blob:` (mobile-gateway.mjs:71).
- Status text is `role="status"` with `aria-live="polite"`; the incoming card uses `aria-live="assertive"`.
- The server sends codes only; all Hebrew lives in one dictionary in battle-bar.js; an unknown code shows the generic line.

## 14. Hebrew copy (addressed to a woman; other creators are worded neutrally)

Status line by stage:
| Stage | Text |
|---|---|
| PANEL_OFFLINE | שליטת הבאטל לא זמינה כרגע. |
| STUDIO_OFFLINE | LIVE Studio לא מחובר במחשב השידור. |
| ACCOUNT_MISMATCH | Studio מחובר לחשבון אחר. אי אפשר לשלוט בבאטל מכאן. |
| NOT_LIVE | את עדיין לא בלייב. |
| STUDIO_NOT_READY | Studio מתכונן. עוד רגע. |
| ROOM_GUARD_BLOCKED | מחשב השידור קשור לחדר אחר. צריך לנתק אותו במחשב. |
| LIVE_SOLO | את בלייב. אפשר להזמין יוצר או יוצרת. |
| COHOST_INVITE_PENDING | ההזמנה נשלחה. מחכים לתשובה. |
| COHOST_LINKED, SEND listed | את מחוברת עם {name}. אפשר לשלוח באטל. |
| COHOST_LINKED, no SEND | את מחוברת עם {name}. |
| BATTLE_INCOMING | הזמנה לבאטל מ־{name} (without a name: קיבלת הזמנה לבאטל) |
| BATTLE_OUTGOING | הזמנת הבאטל נשלחה. מחכים לתשובה. |
| BATTLE_PENDING | יש הזמנת באטל פתוחה. |
| BATTLE_ACTIVE | באטל פעיל מול {name} (without a name: באטל פעיל) |
| ACTIVE to no battle | הבאטל הסתיים. |

Hints:
| Hint | Text |
|---|---|
| OPEN_COHOST_PANEL | כדי להזמין, צריך לפתוח את חלון ה־Co-host ב־Studio במחשב השידור. |
| OPEN_MATCH_PANEL | כדי לשלוח או לאשר באטל מכאן, צריך לפתוח את חלון הבאטל ב־Studio במחשב השידור. |
| CONTROL_BLOCKED_IN_STUDIO | לא הצלחנו ללחוץ מכאן. אפשר לאשר ישירות ב־Studio. |
| STUDIO_CONTROLS_UNAVAILABLE | הפקדים ב־Studio לא זמינים כרגע. |
| COHOST_REQUEST_IN_STUDIO | יש בקשת Co-host שמחכה לאישור ב־Studio. |
| STATE_STALE | המצב לא מעודכן. בודקים שוב… |

Buttons and sheets:
| Element | Text |
|---|---|
| ACCEPT | אשרי |
| DECLINE | דחי |
| SEND | שלחי באטל |
| WITHDRAW | בטלי הזמנה |
| INVITE | הזמיני |
| Cancel | ביטול |
| Confirm send battle | שלחי |
| Confirm invite | שלחי הזמנה |
| Send-battle sheet title | לשלוח הזמנת באטל אל {name}? |
| Invite sheet title | הזמיני ל־Co-host |
| Invite confirmation title | להזמין את {name} ל־Co-host? |
| Line under both confirmations | ההזמנה תישלח מהחשבון שלך ב־TikTok. |
| Token timer | האישור בתוקף עוד {n} שניות. |
| Search placeholder | חיפוש ברשימה שנטענה ב־Studio |
| Empty list | אין כרגע יוצרים זמינים ברשימה. |
| No match | לא נמצא. נסי שם אחר. |
| List note | הרשימה מגיעה מחלון ה־Co-host ב־Studio. |
| Groups | חברים · מוצעים · חיפוש ב־Studio |
| Incoming elapsed | לפני {n} שניות |

Progress and results:
| State | Text |
|---|---|
| in flight | שולחים ל־Studio… |
| SENT | נשלח ל־Studio. מחכים לעדכון. |
| CONFIRMED, ACCEPT | הבאטל התחיל. |
| CONFIRMED, DECLINE | ההזמנה נדחתה. |
| CONFIRMED, WITHDRAW | ההזמנה בוטלה. |
| CONFIRMED, SEND | הזמנת הבאטל נשלחה. |
| RACE_LOST | הצד השני כבר אישר. הבאטל התחיל. |
| NOT_CONFIRMED | לא ראינו שינוי ב־Studio. בדקי את המצב ונסי שוב. |
| UNCERTAIN | לא בטוח שהפעולה בוצעה. בדקי ב־Studio לפני ניסיון נוסף. |
| invite PENDING | ההזמנה נשלחה. מחכים לתשובה. |
| invite LINKED | החיבור עם {name} הצליח. |
| invite REJECTED | ההזמנה לא התקבלה ב־TikTok. |
| invite CANCELLED | ההזמנה בוטלה. |

Errors:
| Code | Text |
|---|---|
| PAIRING_REQUIRED | הטלפון התנתק מהשרת. חברי אותו מחדש. |
| LIVE_TICKET_INVALID | החיבור פג תוקף. היכנסי שוב. |
| NOT_CREATOR_SESSION | רק בעלת הלייב יכולה לשלוט בבאטל. |
| CREATOR_NOT_BOUND_TO_SERVER | החשבון שלך לא משויך למחשב השידור הזה. |
| LOCAL_SESSION_READ_ONLY | מהמחשב אפשר רק לצפות. הפעולות נעשות מהטלפון. |
| LIVE_LINK_REQUIRED | קודם חברי את המצלמה, ואז אפשר לשלוח ולאשר. |
| STUDIO_ACCOUNT_MISMATCH | Studio מחובר לחשבון אחר. לא בוצעה פעולה. |
| PANEL_OFFLINE | שליטת הבאטל לא זמינה כרגע. לא בוצעה פעולה. |
| STUDIO_OFFLINE | Studio לא מחובר. לא בוצעה פעולה. |
| STUDIO_CONTROLS_UNAVAILABLE | הפקדים ב־Studio לא זמינים כרגע. נסי שוב בעוד רגע. |
| PANEL_TIMEOUT | מחשב השידור לא ענה בזמן. בדקי את המצב לפני ניסיון נוסף. |
| AUDIT_UNAVAILABLE | תקלה בשרת. לא בוצעה פעולה. |
| NOT_LIVE | אפשר רק כשאת בלייב. |
| STUDIO_NOT_READY | Studio עדיין לא מוכן. נסי שוב בעוד רגע. |
| SESSION_CHANGED | הלייב התחלף. בדקי את המצב ובחרי שוב. |
| BATTLE_CHANGED | המצב השתנה. בדקי ובחרי שוב. |
| BATTLE_ACTION_UNAVAILABLE | הפעולה כבר לא זמינה. |
| BATTLE_BUSY | פעולה קודמת עדיין מתבצעת. חכי רגע. |
| RETRY_BLOCKED | לא הצלחנו ללחוץ מכאן. אפשר לאשר ישירות ב־Studio. |
| MATCH_START_NOT_READY | מסך הבאטל ב־Studio לא נפתח. לא נשלחה הזמנה. |
| CONFIRMATION_REQUIRED | צריך לאשר לפני השליחה. |
| CONFIRMATION_EXPIRED | האישור פג. בחרי שוב. |
| BATTLE_RATE_LIMIT, RATE_LIMITED | יותר מדי פעולות. חכי כמה שניות. |
| INVITE_RATE_LIMIT | שלחת הרבה הזמנות. חכי דקה. |
| ROOM_GUARD_BLOCKED | מחשב השידור קשור לחדר אחר. לא בוצעה פעולה. |
| OPEN_COHOST_PANEL | חלון ה־Co-host ב־Studio סגור. צריך לפתוח אותו במחשב השידור. |
| CANDIDATE_NOT_FOUND | הרשימה התעדכנה. בחרי שוב. |
| TARGET_UNAVAILABLE | אי אפשר להזמין את {name} כרגע. |
| INVITATION_ALREADY_PENDING | כבר נשלחה הזמנה אל {name}. מחכים לתשובה. |
| INVITE_BUSY | הזמנה קודמת עדיין בטיפול. נסי שוב בעוד חצי דקה. |
| TARGET_NOT_IN_STUDIO_LIST | {name} כבר לא ברשימה ב־Studio. בחרי שוב. |
| INVITE_DISABLED_IN_STUDIO | Studio לא מאפשר להזמין את {name} כרגע. |
| no HTTP response | אין חיבור לשרת. מנסים שוב… |
| any other code (INVALID_REQUEST, REQUEST_ID_CONFLICT, PANEL_ERROR, PANEL_PROTOCOL_ERROR, BATTLE_SCOPE_REQUIRED, REQUEST_FAILED and the rest) | משהו השתבש. בדקי את המצב לפני ניסיון נוסף. |

## 15. What cannot be verified without a real two-account battle

1. That `element.click()` works on Studio's real accept and decline buttons. "acceptance and decline through the dashboard still have synthetic coverage only" (ROOT\docs\LIVE-VERIFICATION.md:17). The one real incoming invitation was accepted by hand (obs L13-14; act L1 was skipped).
2. How long an incoming invitation stays open, and so whether about 2 s to the phone is fast enough. The only data point: pending for at least 10 s before a manual accept (obs L13-14; the watcher polls every 5 s).
3. Whether the invitation scope renders in Studio's main window when the Match panel is closed or Studio is minimized. It was only seen while the match-start screen was open (obs L12-13). Minimized support exists only in HEAD code.
4. The whole path through the gateway with a HEAD panel. Real evidence so far: start through the stale panel's HTTP API (act L3-4); withdraw through modules run directly (act L18-22).
5. Our effect mapping: RACE_LOST for a withdraw overtaken by acceptance (seen once: act L15-16 with obs L25), and "battle ended" as battle null with the co-host still linked or dropped (obs L11, L15, L19).
6. A co-host invite sent through the panel's HTTP API from the Friends or Suggested list, and whether real candidate rows carry names and handles (Studio may return only a Map marker, model.mjs:20; a native card gives a first text line only, native-ui.mjs:46).
7. Repeated rounds through the relay (new revision per round, HEAD only).
8. Real latency of long-polling through the tunnel on a mobile network.
9. Whether Studio accepts our Chrome program page as the selected co-host camera, and what the opponent sees. The only evidence is "the selected Co-host camera was null" (LIVE-VERIFICATION.md:27).

## 16. Changes to ask the panel's author for

Safer:
1. A build marker. `version:'0.2.0'` is identical at commit 449f3e9 (old revision formula, `document.visibilityState` gate) and at HEAD. Bump it and add `GET /api/meta {version, build, startedAt, features[]}` so the relay refuses a stale process. The process listening now was started before commits 0b6892e to 48c7d4f ("has not loaded all later fixes", LIVE-VERIFICATION.md:41).
2. Do not cache rejected dispatches (battles.mjs:111-113). Delete both map entries when the promise rejects before a click. Today a transient probe failure during an accept blocks that accept for five minutes.
3. Guard the request handler. `const url=new URL(req.url,'http://127.0.0.1:'+port);` (server.mjs:66) sits in an async handler with no try/catch, and `new URL('//','http://127.0.0.1:47831')` throws ERR_INVALID_URL (checked locally with Node 24.16.0, nothing sent to the panel). Any local process can therefore bring the panel down with one request. Return 400 instead, and add an unhandledRejection guard.
4. A machine credential for the relay (a token file readable only by the service user, sent as a header) and a headless mode that does not hand the cookie to every `GET /` (server.mjs:103).
5. Make PhoneLink optional (a flag) and give the binding an expiry. A stored binding blocks every invite and battle action for any other room (phone-link.mjs:57-60).
6. Separate request budgets per client and a `Retry-After` on 429 (battles.mjs:106).

Simpler or more capable:
7. Put `battle:{status}` and a real `incoming` flag (from the native scope role) into `/api/battles`. `inspect()` already has `battle:after.battle` (battles.mjs:91) but `state()` drops it, and `state.battle.incoming` is unreliable (model.mjs:49).
8. One consistent read for remotes (state plus battles from a single inspection), served from a server-side cache instead of a DevTools session per GET; ideally with a long-poll `since` parameter.
9. Return the post-action battle state and the echoed requestId in the action receipt.
10. Adapters for: opening the Co-host popup and the Match panel; accepting or rejecting incoming co-host requests; scrolling a battle button into view, as the invite click already does (`e.scrollIntoView({block:"nearest"})`, native-ui.mjs:79); and a reason when a button is disabled.
11. Expose the invitation's remaining time and the inviter, if Studio renders them.
12. A server-side prepare and confirm for `match.start`, like invites.
13. Distinguish cooldown from in-flight (`INVITE_COOLDOWN` with `retryAfterMs`) and make receipt `error` always `{code,message}` or null (invites.mjs:58-67 returns strings for unknown).
14. State the real Node requirement (22 or newer for the global WebSocket, native-ui.mjs:2; package.json says ">=20"), and use one version string for the offline shape (`version:'0.1.0'`, server.mjs:57).

## 17. Preconditions and open decisions

Before first use: the panel is restarted from HEAD by whoever owns it (not done here, and not by the relay); no phone-link binding file exists; Studio runs with its debugging flags; `LIVE_BATTLE_RELAY=1` and `LIVE_CREATOR_ID` are set; the live-link module supplies `actor`.

Decisions for the owner:
- Who starts and supervises the panel.
- Whether accept should really require a publishing camera link (default here: yes).
- How the Co-host popup and Match panel get opened on an unattended server.
- Whether incoming co-host requests must be handled from the phone.
- Whether to bind the expected TikTok account by uid now or wait for the ticket claim.
- One Studio and one panel per machine is assumed (ports and paths are hard-coded).

## TESTS
- Setup rule for the whole file GW\test\battle-relay.test.mjs: two fakes only. (F1) a scripted fake panel HTTP server on a random loopback port that enforces the panel's gates (Host equals 127.0.0.1:<port>, cookie required on /api/*, 403 on any Origin or sec-fetch-site: cross-site) and records every request; (F2) the real createApp imported from ../../../server.mjs with service, nativeUi and battleUi all injected and polling:false (ROOT\test\control.test.mjs:76-89 pattern). No test may use port 47831, 9222 or 9225; one test asserts the relay's default origin string is exactly http://127.0.0.1:47831 without connecting to it.
- Bootstrap: the first API call performs exactly one GET /, accepts only a set-cookie matching ^boostera_session=[a-f0-9]{64}, and every later panel request carries exactly Host, Cookie, Accept (plus Content-Type and Content-Length on POST), even when the phone request carried Origin, Referer, Sec-Fetch-Site, X-Forwarded-For, Authorization, a wm_sid cookie and custom headers.
- Origin guard: constructing the client with localhost, a non-loopback host, https, or a path throws INVALID_PANEL_ORIGIN; the Host header seen by F1 equals 127.0.0.1:<port>.
- Re-bootstrap: F1 rotates its token (panel restart); the next call gets 401 OPEN_PANEL_FIRST, the client bootstraps once (single GET / under 5 concurrent calls) and repeats the request once with the same body; a second 401 ends as PANEL_OFFLINE with no loop.
- Re-bootstrap during an action POST: the retried POST carries the same requestId and F1 counts exactly one dispatch.
- Bootstrap failures: missing or malformed set-cookie, non-200, or a 302 (not followed) give PANEL_PROTOCOL_ERROR; the token never appears in any gateway response body, response header, console output or audit line (search all captured output for the seeded token).
- Panel offline: with F1 closed, GET state returns 200 with stage PANEL_OFFLINE and every write returns 503 PANEL_OFFLINE; after F1 returns, nothing that was refused is replayed (F1 sees zero POSTs); backoff 1 s, 2 s, 5 s verified with injected timers.
- Timeouts and size: a delayed /api/battles marks the snapshot stale; a delayed action POST returns 504 PANEL_TIMEOUT and audit result UNCERTAIN; a re-send of the same requestId attaches to the same in-flight promise (one POST at F1); a response over 1 MiB or non-JSON gives PANEL_PROTOCOL_ERROR and no partial data reaches the phone.
- Path safety: /api/live/battle/../../api/phone/import, /api/live/battle//, /api/live/battle/state/extra, percent-encoded variants and unknown subpaths return 404 NOT_FOUND with zero F1 requests; across the entire suite F1 only ever sees /, /api/state, /api/battles, /api/battles/action, /api/invites/prepare, /api/invites/send.
- Filtering: with seeded uid, roomId, battleId, channelId, epoch, revision, draftToken, avatar URL, operation IDs and event text in F1, the serialized snapshot, candidates list and every error body contain none of them, and the deep key set of the snapshot equals the documented schema.
- Name cleaning: control and bidi characters are stripped, name capped at 40, a handle failing ^[a-zA-Z0-9_.]{1,30}$ is dropped, a digits-only name (the panel's uid fallback, invites.mjs:41) is dropped, a candidate with neither name nor handle is not listed.
- Candidate refs: stable within an epoch, different after an epoch change, a forged or old ref returns 409 CANDIDATE_NOT_FOUND with zero panel calls; linked, invited or not-invitable candidates are neither listed nor accepted.
- Stage table, driven by the real sequences (masked) from native-live-observations.jsonl: cohostModeSelect with match.select selected and getStarted (L8) gives COHOST_LINKED with SEND; matchStart with match.start (L9) gives COHOST_LINKED with SEND; invitation invitee with accept and decline (L13) gives BATTLE_INCOMING; invitation inviter with withdraw (L17) gives BATTLE_OUTGOING; open with no controls (L10) gives BATTLE_ACTIVE; pending with no scopes (L24) gives BATTLE_PENDING; no battle and no link (L19) gives LIVE_SOLO.
- Unavailable stages: connected:false with BRIDGE_UNAVAILABLE and with CONNECTING give STUDIO_OFFLINE; live:false gives NOT_LIVE; health 'initializing' gives STUDIO_NOT_READY; actions.reason OPEN_COHOST_PANEL gives hint OPEN_COHOST_PANEL; invite false with reason null gives STUDIO_NOT_READY or NOT_LIVE and never OPEN_COHOST_PANEL; PHONE_ROOM_NOT_ATTACHED_TO_STUDIO gives ROOM_GUARD_BLOCKED; available:true with empty scopes and a linked co-host gives hint OPEN_MATCH_PANEL.
- Direction and status: battle.incoming:true with scope role inviter still gives OUTGOING; battleStatus ONGOING with battle.status pending stays PENDING.
- Authorization matrix on all six endpoints: no session 401; paired device that is not the creator 403 NOT_CREATOR_SESSION; ticket for another creator 403 CREATOR_NOT_BOUND_TO_SERVER; ticket without live:battle 403 BATTLE_SCOPE_REQUIRED; ticket that expires between the state read and the action 401 on the action; loopback session: GET 200, POST 403 LOCAL_SESSION_READ_ONLY (200 only with LIVE_BATTLE_LOCAL_WRITES=1). Every denied write makes zero panel calls and one audit 'denied' line.
- Relay disabled: without LIVE_BATTLE_RELAY=1 or without LIVE_CREATOR_ID every route returns 404 BATTLE_RELAY_DISABLED and F1 sees nothing, not even a bootstrap.
- Account binding: expected uid differs from the panel's session.selfUid gives stage ACCOUNT_MISMATCH, empty candidate rows and 409 STUDIO_ACCOUNT_MISMATCH on writes with zero panel POSTs.
- Link requirement: with link state not publishing, ACCEPT, battle prepare, SEND and both invite steps return 409 LIVE_LINK_REQUIRED; DECLINE and WITHDRAW succeed.
- Cross-origin POST (Origin: https://evil.example) is rejected with 403 ORIGIN_REJECTED by the existing gate (mobile-gateway.mjs:43) before relay code runs.
- ACCEPT happy path: one POST with {action:'match.accept', revision:<fresh>, epoch:<fresh>, requestId}; response result SENT; when F1 then reports battle open, lastAction becomes CONFIRMED and an audit 'effect' line is written.
- Idempotency: the same requestId sent three times concurrently and once later gives exactly one panel POST and identical bodies; the same requestId with another action or view gives 409 REQUEST_ID_CONFLICT; a failed authorization or rate-limit answer is not cached.
- View binding: the invitation's battleId changes between the snapshot and the tap, giving 409 BATTLE_CHANGED with a fresh snapshot and zero POSTs; only the button's enabled flag flickers (same battleId), giving one POST carrying the fresh revision.
- Role guard: ACCEPT or DECLINE while the scope role is inviter, and WITHDRAW while it is invitee, return 409 BATTLE_ACTION_UNAVAILABLE with zero POSTs.
- Panel error mapping, table-driven: each 409, 429 and 503 code from section 6 maps to the documented relay code and status; the 200 'unknown' receipt maps to result UNCERTAIN; an unknown code maps to 502 PANEL_ERROR and the raw code is not in the body.
- Retry block: after a 503 NATIVE_UI_TIMEOUT on an action, a second tap on the unchanged screen returns 409 RETRY_BLOCKED with zero POSTs and the action is listed enabled:false; after the revision changes the action is sent again. BATTLE_BUSY does not block.
- Effect resolution: withdraw dispatched and F1 then reports open gives RACE_LOST (the real 19:48 sequence); dispatched:true with no state change for the window gives NOT_CONFIRMED (the stale-panel cached acknowledgement); accept followed by the invitation disappearing gives NOT_CONFIRMED.
- Battle prepare: from matchStart it clicks nothing; from cohostModeSelect it posts cohostMode.getStarted exactly once with a server-generated id and waits for matchStart; if matchStart never appears it returns 409 MATCH_START_NOT_READY and no match.start is ever posted.
- SEND confirmation: without confirm 409 CONFIRMATION_REQUIRED; after 20 s, on reuse, or from another session 409 CONFIRMATION_EXPIRED; the opponent changes between prepare and send, giving 409 BATTLE_CHANGED with zero match.start; valid flow posts exactly one match.start.
- Co-host invite: prepare posts {uid, epoch} resolved from the ref and its response contains no draftToken or uid; send posts {uid, epoch, draftToken, requestId}; receipts map pending to PENDING, succeeded to LINKED, failed with an error object to REJECTED with only a safe reasonCode, cancelled to CANCELLED, unknown with a string error to UNCERTAIN.
- Invite errors: CONFIRMATION_EXPIRED, INVITE_BUSY, OPEN_COHOST_PANEL, TARGET_NOT_IN_NATIVE_LIST, NATIVE_INVITE_DISABLED, AMBIGUOUS_NATIVE_TARGET, INVITATION_ALREADY_PENDING, TARGET_UNAVAILABLE, REFRESH_CANDIDATES and SELF_INVITE_NOT_ALLOWED each map to the documented code; an invite confirm token is single use and bound to the preparing session.
- Rate limits with an injected clock: the 7th battle write in 30 s, the 4th invite send in a minute, the 7th invite prepare in a minute and a 5th state request in one second each return 429 with Retry-After and retryAfterMs and make no panel call; a third waiting long-poll for one session is answered immediately.
- Poller discipline: with no subscriber there are no /api/battles calls; with one subscriber at most one per 1500 ms (400 ms only for 6 s after an action); F1 asserts no /api/battles GET overlaps an in-flight /api/battles/action POST.
- Long-poll: since equal to the current v holds the request until F1's state changes and then returns 200 within one poll tick; it returns 204 after wait seconds; a client abort frees the waiter; wait above 8 is capped.
- Audit write-ahead: at the moment F1 receives any action or invite POST, the 'attempt' line for that requestId is already in the file; a 'result' line follows; seq is strictly increasing; the prev hash chain verifies from the first line; file size only grows.
- Audit privacy and failure: the file contains none of the seeded names, handles, numeric IDs, epoch, revision, tokens or client IP; with the writer forced to fail, the write returns 500 AUDIT_UNAVAILABLE and F1 receives no POST; rotation at the size limit renames the file and the chain continues.
- Contract check against the real panel code (F2): bootstrap, GET state, GET battles and ACCEPT through the relay end with the injected battle UI's click counter at 1; a replay and a new requestId on the unchanged screen leave it at 1; the same for invite prepare and send with a fake invite UI. This fails loudly if the panel's HTTP contract drifts.
- Static checks: 'battle-bar.js' is in the gateway allowlist (mobile-gateway.mjs:67) and in sw.js SHELL, the cache name changed, and package.json's test script includes the new test file.
- Browser test of the bar (Playwright fulfilling /api/live/** with canned JSON, as ROOT\test\battle-controls-browser.py does for the panel): every stage, hint, result and error code renders its Hebrew line; a double tap sends one POST; the requestId is a lower-case UUID v4, reused on an automatic re-send and new on a new tap; SEND and INVITE cannot be posted without the confirm step; a name containing markup is shown as text; no horizontal overflow at 360, 390 and 430 px in right-to-left layout; buttons are disabled when stale or when me.canWrite is false; the bar is hidden on BATTLE_RELAY_DISABLED and NOT_CREATOR_SESSION.

## RISKS
- The panel process running now is stale and cannot be told apart from a fixed one: version is '0.2.0' at commit 449f3e9 and at HEAD. Against the stale process a repeated round can return a cached {dispatched:true} without clicking (seen at act L10-11), and minimized Studio returns no controls. The relay must not go live until the owner restarts the panel from HEAD; the relay's NOT_CONFIRMED result limits the damage but does not remove it.
- Accepting and declining an incoming battle through the panel has never run with real accounts (LIVE-VERIFICATION.md:17). The main feature the creator wants from the phone is the least proven part of the chain.
- The panel caches rejected dispatches for five minutes per [action, revision, epoch] (battles.mjs:107-113). A transient bridge or DevTools failure at the moment of an accept makes that accept impossible from the phone until the screen changes. The relay reports RETRY_BLOCKED honestly but cannot fix it.
- The lifetime of an incoming battle invitation is unknown. If it is shorter than a few seconds, detection (up to 1.5 s) plus phone display plus the tap may be too slow, and the relay would need a push from the panel.
- The panel cannot open Studio's Co-host popup or Match panel. On an unattended server the phone will show OPEN_COHOST_PANEL or OPEN_MATCH_PANEL with nobody to act on it. It is also not known whether an incoming invitation renders when the Match panel is closed.
- The live-link identity (bearer ticket, publisher state, creator binding) does not exist on this branch. The relay's whole authorization rests on a module that is still to be built; until then only the loopback session and equal-rights paired devices exist (up to 12, mobile-session.mjs:11).
- The gateway is the only real boundary. Any local process can fetch the panel cookie with GET / (server.mjs:103), and port 9222 gives any local process control of Studio's renderer and the signed-in account. Loopback requests to the gateway are automatically the local session, so correctness depends on the tunnel always adding cf-connecting-ip or x-forwarded-for (mobile-gateway.mjs:11).
- Any local process can crash the panel: new URL(req.url, …) at server.mjs:66 is unguarded in an async handler and '//' throws (confirmed locally for the URL parser only; not sent to the panel). The phone would then see PANEL_OFFLINE with no supervisor to restart it.
- Battle prepare clicks cohostMode.getStarted in Studio before the creator confirms. It sends nothing to the opponent, but it changes what the operator sees on the server screen; if she cancels, Studio stays on the match-start screen.
- A stored phone-link binding makes every invite and battle action fail with ROOM_GUARD_BLOCKED for every new Studio room, until someone unlinks it on the server (phone-link.mjs:57-60). The binding has no expiry.
- The quick tunnel does not support server-sent events and allows 200 in-flight requests (Cloudflare's published limits). Long-polling avoids this, but real latency over a mobile network through the tunnel is not measured.
- Polling /api/battles opens a new DevTools session to Studio's main window on every call. At one call per 1.5 s over a multi-hour LIVE, plus the desktop tab's own polling, the effect on Studio's stability is not known.
- The adapters depend on Studio 1.39.6 internals: data-ix-* and data-cohost-* attributes, the install path, the English 'Search' placeholder. A Studio update can silently remove all controls; the phone would then show hints, not errors.
- Names and handles of other creators reach the creator's phone (needed for explicit confirmation). Real candidate rows may carry no name or handle at all, in which case the invite list is empty even though Studio shows people.
- Co-host and battle may not work with our program page as the camera: Studio reported a camera-only co-host configuration error with the selected co-host camera null (LIVE-VERIFICATION.md:27). The relay cannot detect or fix this.
- The relay, the desktop panel tab and any script share the panel's limit of 200 battle request IDs per five minutes (battles.mjs:106) and its single 'active' slot; heavy use on the desktop can make the phone see BATTLE_RATE_LIMIT or BATTLE_BUSY.
- One Studio, one panel and one creator per machine are assumed; ports and paths are hard-coded in the panel. A second creator on the same server needs changes on both sides.
- The audit file is append-only by convention plus a hash chain; on Windows the file mode gives no real protection, so a local user can still delete or replace the file. The chain shows tampering inside a file but not removal of the whole file.
