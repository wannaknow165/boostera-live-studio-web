# MAP: vardyverse

# Vardyverse (Lovable project 96bb8c1b-f0d3-45a6-9546-82fda258a910) — state map, 2026-11-12 ~21:25 UTC

## 0. Method and coverage
- Lovable tools used: get_project, list_files (whole tree), read_file (~60 files), list_messages (2 pages), get_message (2), list_edits (50). No write or credit-spending tool was called. `.env` was not opened.
- Outside the Lovable tools I also ran about 45 anonymous GET/HEAD requests (curl, no tokens, no POST) against the published and preview hosts, to establish deployment state and response headers.
- HEAD = commit `9b6e056149441c03c8abd4d9a59edcef93259f68` (last_edited_at 20:37:53Z). `agentFinished: true`, `is_published: true`, `publish_audience: "public"`.
- Line numbers: read_file returns none, so they are hand-counted from HEAD. They are exact for short files; "~" marks approximate ones.
- Message history read: the newest 30 messages (all user texts in full, agent prose with tool blocks stripped) and the next 12 older ones. Messages before 15:59Z were seen only as an index. The oldest pages were not fetched.

## 1. Stage token
**Generation and hash** — `src/lib/stage/state.server.ts`:
- L8 `export const hashStageToken = (t: string) => createHash("sha256").update(t).digest("hex");`
- L9 `const cleanCreator = (c: string) => c.trim().replace(/^@/, "").toLowerCase();`
- L21 `const token = randomBytes(24).toString("hex");`
- L23 `await db.from("stage_tokens").upsert({ creator, token_hash: hashStageToken(token), rotated_at: new Date().toISOString() }, { onConflict: "creator" });`

So the token is 24 random bytes as 48 lowercase hex characters. The hash is SHA-256 of the token string (UTF-8), stored as 64-character lowercase hex. There is no salt, no HMAC and no base64.

**Storage** — `drizzle/migrations/0009_live_stage.sql` L1-9:
`CREATE TABLE public.stage_tokens ( creator text PRIMARY KEY, token_hash text NOT NULL UNIQUE, rotated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT stage_tokens_creator_chk CHECK (creator = lower(creator) AND creator ~ '^[a-z0-9._]{2,24}$') );`
- RLS is enabled with no policies, so only the service role reads it.
- One row per creator: rotating overwrites the hash and the old link dies immediately.
- The key is the lowercase TikTok username, not a user id, so a stage can exist before the creator links her account.

**Issuing** — the only issuer is `rotateStageLink` in `src/lib/stage.functions.ts` L42-50:
`const token = await rotateStageToken(me.creator); return { ok: true as const, path: \`/stage?creator=${encodeURIComponent(me.creator)}&t=${token}\` };`
- It is called from `/stage-control` (`src/routes/_authenticated/stage-control.tsx` L74) and from wizard step 9 (`GoLiveStep` in `set.tsx`).
- The raw token is returned once and can never be read back from the server.
- The browser keeps the full URL in localStorage key `vardy-stage-link`, on that device only (`rememberStageLink`, `src/components/stage/LivePreviewPane.tsx` L5, L11-13).

**Validation** — `verifyStage`, `state.server.ts` L11-17:
`if (!/^[a-z0-9._]{2,24}$/.test(creator) || token.length < 32) return null;` then `.from("stage_tokens").select("creator").eq("creator", creator).eq("token_hash", hashStageToken(token)).maybeSingle()`.

**How /stage checks `?t=`** — `src/routes/stage.tsx`:
- L6-9 reads `creator` and `t` from the query.
- L33-37 polls every 2 s: `fetch(\`/api/public/stage/state?creator=…&t=…\`, { cache: "no-store" }); if (r.status === 401) { setDenied(true); return; } … if (!stop) setTimeout(tick, 2000);`
- On 401 the page shows the idle wall, and the `return` skips the re-arm, so polling stops until reload.
- The API route is `src/routes/api/public/stage/state.ts` L9-15. It returns 401 `{"error":"STAGE_TOKEN_INVALID"}`, 500 `{"error":"STAGE_UNAVAILABLE"}`, or 200 with `Cache-Control: no-store` and no CORS headers.
- The 200 body is `{ board, supporterRequests, energy, liveId, creator, connected, now, wall, battle, live, likesPerMinute, recentLikes, events, goals, video, front }`.

The same token also authorises `GET /api/public/sets/active?creator&t` and `POST /api/public/sets/played` (body `{creator, t, effect_id, trigger?, at?}`).

## 2. Routes and navigation (HEAD, `src/routeTree.gen.ts`)
- **Public pages:** `/`, `/auth`, `/stage`, `/battle`, `/capabilities`, `/guide`, `/mcp`, plus MCP/OAuth plumbing.
- **Signed-in pages** (layout `src/routes/_authenticated/route.tsx` L4-11, `ssr: false`, redirects to `/auth` with the pathname only): `/connect`, `/create`, `/identity`, `/profile`, `/set`, `/stage-control`, `/effects`, `/effects/import`.
- **API:** `/api/public/stage/state`, `/api/public/sets/active`, `/api/public/sets/played`, `/api/public/live/ingest`, `/api/public/live/openapi.json`, `/api/public/live/tiktools`, `/api/public/hooks/process-jobs`, `/api/public/library/sync`, `/api/public/library/$kind/$fileId`, `/api/public/tiktok/callback`, `/api/public/vardy/$tool`, `/api/public/vardy/openapi/json`.
- **Not found:** `/supporters`, `/live`, or any go-live / ticket route.

**Top navigation: yes, the three headings exist at HEAD.** `src/components/build/CreatorNav.tsx` L10-12 has `<Link to="/set" …>לייב</Link>`, `<Link to="/create" …>יצירה</Link>`, `<Link to="/profile">פרופיל</Link>`. It is rendered per page, not in a shared layout:
- `active="live"` on `/set` and `/stage-control`.
- `active="create"` on `/create` and `/effects`.
- `active="profile"` on `/profile`, `/connect`, `/identity`.
- `/effects/import` was not opened.

**Live area:**
- **`/stage`** — `src/routes/stage.tsx` plus `src/components/stage/StageView.tsx`, `ArenaBoard.tsx`, `StageBoard.tsx`. The frame is `aspect-[9/16] w-[min(100vw,56.25vh)]` on an opaque `bg-stage-night` background with `pointer-events-none`. Wall videos render as `<video src={v.url} autoPlay muted playsInline loop …>`.
- **`/stage-control`** — `stage-control.tsx`: L60 `<LivePreviewPane />`, L64-67 `<SupportersNow /> <SupporterClips /> <OpeningControl /> <BoardControl />`, then "קישור לבמה", "הקיר מאחורייך", "סרטון רקע", `<EnergyControl>`, "יעדים (עד 3 פעילים)", "בדיקה (לא אמיתי)".
- **Wizard "בניית הלייב שלי"** — `/set?step=`, `src/routes/_authenticated/set.tsx`. Steps come from `BUILD_STEPS` in `src/lib/fx/rules.ts`: identity, wall, front, multipliers, battle, challenges, queue, check, golive. Step 9 only creates and copies the stage link, shows loading instructions and shows listener status; there is no go-live action.
- **"תצוגה חיה"** — `src/components/stage/LivePreviewPane.tsx`, used on `/stage-control`, `/set`, `/identity`:
  - L99 `<iframe title="הבמה שלך" src={src} allow="autoplay" …>` at 1080×1920, scaled; same-origin `/stage` only (L114).
  - L37 `getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 1280 } }, audio: false })`.
  - L6-8 MediaPipe tasks-vision 0.10.14 from `cdn.jsdelivr.net`, selfie model from `storage.googleapis.com`, GPU then CPU.
- **`/create`** — rows 1 and 3 are "בקרוב"; only `PreLiveSupporterVideo` works.
- **`/identity`** — a placeholder with static Tohar assets.
- **`/profile`** — TikTok connection, identity link, a "התומכות שלי" stub ("מחכה לאישור"), socials, owner-only ingest keys, sign-out.

## 3. Auth, creator resolution, env
**Sign-in:** Supabase Auth with email+password and Google (`src/routes/auth.tsx`). The session lives in localStorage (`src/integrations/supabase/client.ts`).

**Client to server:** `attachSupabaseAuth` (`src/integrations/supabase/auth-attacher.ts` L7-15) adds `Authorization: Bearer <access_token>` to every server function. It is registered in `src/start.ts` L28-31 alongside `createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" })` (L24-26), so server functions are same-origin only.

**Server:** `requireSupabaseAuth` (`src/integrations/supabase/auth-middleware.ts` ~L33-109) verifies the bearer with `supabase.auth.getClaims(token)` and calls `next({ context: { supabase, userId: data.claims.sub, claims: data.claims } })`.

**Handle resolution:**
- `resolveCreator(ctx, requested?)` — module-private, `src/lib/stage.functions.ts` L7-20:
  `const { data } = await supabaseAdmin.from("creator_accounts").select("session_id, tiktok_username").eq("user_id", ctx.userId).maybeSingle(); if (!data?.tiktok_username) return null; return { creator: data.tiktok_username.toLowerCase(), sessionId: data.session_id };`
  An owner may pass another creator, checked with `ctx.supabase.rpc("has_role", { _user_id, _role: "owner" })`.
- `who(ctx, requested?)` in `src/lib/fx.functions.ts` (~L7-17) is the twin helper.
- `getMyCreator` (`src/lib/creator.functions.ts` L5-15) is the exported read.

**Tables:**
- `creator_accounts`: user_id, session_id, email, tiktok_open_id, tiktok_username, display_name, avatar_url, status, link_method ('none'|'tiktok_oauth'|'manual'), connected_at, socials. Unique index on `lower(tiktok_username)` (`0006_creator_tiktok_link_and_roles.sql`). The base CREATE TABLE was not located.
- `user_roles` plus `has_role(_user_id uuid, _role app_role)`, enum ('owner','creator').

**Linking:** the OAuth callback sets `link_method: "tiktok_oauth"`. `setManualHandle` (`creator.functions.ts` L26-43) sets `link_method: "manual"` with no ownership proof.

**Conventions a new "issue live ticket" function would follow:**
- Shape: `createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(…).handler(async ({ data, context }) => …)` in a `src/lib/*.functions.ts` file.
- Result: `{ ok: true as const, … }` or `{ ok: false as const, code: "NOT_CONNECTED" }`.
- Service role: `const { supabaseAdmin } = await import("@/integrations/supabase/client.server")` inside the handler.
- Secrets: `process.env["NAME"]`, read inside the function, with a soft "not configured" result.

**Existing auth patterns for non-browser callers:**
- Stage token (`verifyStage`).
- Service key header (`authenticateKey`, `src/lib/live/ingest.server.ts` L17-27).
- Supabase bearer: `callerFromRequest(request)` (`src/lib/api/identity.server.ts` ~L101), used by `/api/public/vardy/$tool` with `Access-Control-Allow-Origin: *`.
- Signed short-lived token: `makeState` / `readState` (`src/lib/tiktok/oauth.server.ts` L12-31), `${base64url(JSON{uid,exp,n})}.${HMAC-SHA256 base64url}`, 600 s TTL, `timingSafeEqual`.

**Env names seen in code:**
- Supabase: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_PUBLISHABLE_KEYS, VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_SUPABASE_ANON_KEY.
- TikTok and live data: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI, TIKTOOLS_API_KEY, TIKTOOLS_API_BASE, TIKTOOLS_WEBHOOK_SECRET, TIKLEAP_API_KEY.
- Other: FAL_API_KEY, LOVABLE_API_KEY, GOOGLE_DRIVE_API_KEY_1, MICROSOFT_ONEDRIVE_API_KEY, GALLERY_OWNER_CODE, SOCIALECHO_API_KEY, SOCIALECHO_BASE_URL.
- Docs only: APIFY_API_KEY, GOOGLE_DRIVE_API_KEY.
- No variable names our gateway or the live node. `ai.server.ts`, `vardy.server.ts`, `drive.server.ts`, `tiktok.server.ts` and `engine/*.server.ts` were not opened.

## 4. PWA
- **Manifest:** `public/manifest.webmanifest` has name "Vardy Viral — סטודיו וידאו AI", short_name "Vardy", lang he, dir rtl, `start_url "/"`, `scope "/"`, `display "standalone"`, `orientation "portrait"`, colours `#05070f`. Icons are `/app-icon-192.png` and `/app-icon-512.png` (any, plus 512 maskable). It is served 200 on the published host.
- **Head** (`src/routes/__root.tsx` ~L80-110): viewport `width=device-width, initial-scale=1, viewport-fit=cover`, `theme-color #05070f`, `apple-mobile-web-app-capable yes`, `apple-mobile-web-app-status-bar-style black-translucent`, `apple-mobile-web-app-title Vardy`, links for icon, apple-touch-icon and manifest, Google Fonts, `<html lang="he" dir="rtl">`.
- **Service worker: none.** There is no SW file in the tree and no PWA dependency in `package.json`. Published `/sw.js` and `/service-worker.js` return 404.
- **Install button:** `src/components/vardy/InstallAppButton.tsx` exists but is not mounted by `src/routes/index.tsx`. Other mount points were not checked.

## 5. iframes and security headers
- The only iframe found is `LivePreviewPane.tsx` L99. No grep tool exists, so components under `vardy/`, `battle/`, `manager/` and the `guide` / `capabilities` routes were not checked.
- App code sets no CSP, Permissions-Policy or X-Frame-Options (`src/server.ts`, `src/start.ts`, `vite.config.ts`).
- Published responses for `/` and `/stage?creator=&t=` carry only `Strict-Transport-Security`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache, must-revalidate, max-age=0`, a Cloudflare cookie and `x-deployment-id`. Nothing blocks a cross-origin iframe of `/stage`.
- `/stage` with no query answers 307 to `/stage?creator=&t=`.

## 6. Message queue
The queue is empty. The newest item is a completed agent message at 20:37:53Z. Nothing is in progress, queued, failed or carrying `awaiting_input`. Every user message shows `accepted` and its agent response `completed`.

Last 25 messages, newest first (U = brief sent with role=user, A = Lovable agent; all done):

| # | UTC | From | Summary | Commit |
|---|---|---|---|---|
| 1 | 20:37:53 | A | Art direction built: glass arena board, LED likes line, glass jar, status line, head zone clear; 133 tests. No battle timer. | 9b6e056 |
| 2 | 20:34:14 | U | Art direction brief for the wall's live look | |
| 3 | 20:32:45 | A | "נגני מאחור" / "נגני מלפנים" per video; front items exported as `now_playing` | e1e1b23 |
| 4 | 20:30:53 | U | Front/back layer rule | |
| 5 | 20:28:58 | A | "סרטוני תומכים" grid: play full-wall, add to opening, upload | 1be7bd3 |
| 6 | 20:27:55 | U | Addendum: supporter videos grid and buttons | |
| 7 | 20:27:53 | A | Opening playlist, two opening videos stored, 120 s demo (preview only), restart bug fixed | 9ef0d07 |
| 8 | 20:25:16 | U | Two opening videos plus demo | |
| 9 | 20:25:15 | A | Full-wall clean rule: full-wall default, corner chips, no meter columns | 5cd3bea |
| 10 | 20:23:31 | U | Owner correction: wall full and clean | |
| 11 | 20:23:29 | A | Part G built (12 items), 126 tests | 8d62a04 |
| 12 | 20:15:17 | U | BUILD Part G | |
| 13 | 20:15:15 | A | Part F built (pre-live and in-live supporter videos, chat consent, owner approval); no paid job run | 7440b1f |
| 14 | 20:07:46 | U | BUILD Part F | |
| 15 | 20:07:43 | A | Three headings לייב / יצירה / פרופיל and new `/profile` | b88daca |
| 16 | 20:06:26 | U | Navigation rule: three headings | |
| 17 | 20:06:24 | A | "תצוגה חיה" pane on `/stage-control`, `/set`, `/identity` | 8074a34 |
| 18 | 20:04:37 | U | No video model; live preview pane; plan still waits | |
| 19 | 20:04:36 | A | TikLeap snapshot run, parser fixed, cron exists but targets the published site | b410d23 |
| 20 | 20:03:06 | U | TIKLEAP_API_KEY configured; run snapshot, check cron | |
| 21 | 20:03:04 | A | Two-heading nav and "צרי" deep links (superseded by #15) | 10f469f |
| 22 | 20:01:23 | U | Navigation rule: two headings | |
| 23 | 20:01:16 | A | 9-step wizard at `/set`, home checklist, `/identity` | a18b7f3 |
| 24 | 19:57:32 | U | Part E addendum: guided workflow | |
| 25 | 19:57:30 | A | Part E built: `/effects`, `/effects/import`, `/set`, sets/active, sets/played, openapi | 9055530 |

Just before these: Part D energy engine, completed 19:49:54 (71f7fae), and the gold-wall correction, completed 19:09:23 (162e9c6).

**The briefs you asked about:** all completed in code — Part D, Part E, the wizard, three-heading nav, live-preview pane, Part F, Part G, opening videos and demo buttons, full-wall rule, art direction, front/back buttons, TikLeap snapshot check.

**Not built: the "התומכות שלי / הזהות שלי" plan.**
- It was presented at 18:51:16Z through `plan--show requires-approval="true"`; the text is in `.lovable/plan.md`.
- Agent reports up to 20:15Z say it still waits for owner approval in the editor.
- There is no `/supporters` route, no `supporters.functions.ts`, and no migration for `supporters` or `creator_identity_kits`.

**Caveat on "completed":** the agent states it never tested a signed-in page, because the project had no user accounts. Several features are reported as built but unverified on a real live.

## 7. Deployment
- **Published URL:** `https://vardy-verse-connect.lovable.app`.
- **The latest edits are not deployed.** The published build matches commit `162e9c6` (19:09:23Z, gold wall), 14 commits behind HEAD.
- **Evidence:**
  - `/auth`, `/connect`, `/stage-control` return 200 and `/api/public/stage/state` returns 401 JSON.
  - `/set`, `/effects`, `/identity`, `/create`, `/profile`, `/api/public/sets/active` and `/api/public/live/openapi.json` return 404.
  - The published stage-control chunk contains "הקיר מאחורייך" and "צרי 3 הצעות" but none of the Part D strings.
  - The published head still loads Heebo 400;500;700;800 without Rubik.
- **Preview host** `https://id-preview--96bb8c1b-f0d3-45a6-9546-82fda258a910.lovable.app` answers `401 Unauthorized` (text/plain) on every app route without a Lovable login. The stage link the agent printed is on that host.

## 8. Ingest API (HEAD; also present in the published build)
- **Request:** `POST /api/public/live/ingest` with header `X-Vardy-Service-Key: <raw key>` and JSON body `{ creator_handle: string(2..40), room_id: string(1..64), events: [ { type: 'gift'|'like'|'member'|'chat'|'follow'|'share'|'viewers'|'battle'|'session_start'|'session_end', ts: <positive int, ms>, dedupe_key: string(1..200), payload: {} } ] }`. The key's SHA-256 hex is matched against `service_keys.key_hash`; scope `live:ingest`, or `live:ingest:all` for an owner key. Limits are 1-200 events per call and 120 calls per minute per key.
- **Response:** 200 `{ live_id, accepted, duplicate, rejected: [{ index, code: 'VALIDATION'|'DUPLICATE_IN_BATCH' }] }`. Errors are 401 KEY_INVALID, 403 SCOPE_MISSING or CREATOR_MISMATCH, 404 CREATOR_UNKNOWN, 413 TOO_MANY_EVENTS, 422 VALIDATION, 429 RATE_LIMITED, 500.
- **Source:** `src/routes/api/public/live/ingest.ts` L10-29, `src/lib/live/ingest.rules.ts` L5-22, `src/lib/live/ingest.server.ts` L11-27.

## GOTCHAS
- The published site is 14 commits behind HEAD (it matches 162e9c6, 19:09Z). Everything from Part D onward is missing there, including /set, /create, /profile, /api/public/sets/active and the redesigned wall. The owner must republish before the program page or live node can use any of it.
- The preview host returns 401 without a Lovable login, so LIVE Studio, OBS or our Windows Chrome cannot load a preview stage link. Only the published host is usable.
- A stage token cannot be read back and there is exactly one per creator. rotateStageLink is the only issuer and it kills the previous link everywhere. An 'issue live ticket' function must either accept that or add a separate ticket table or signed ticket; the makeState/readState HMAC pattern in src/lib/tiktok/oauth.server.ts is a ready template.
- The stage URL exists only in localStorage key 'vardy-stage-link' on the device that pressed 'צרי קישור'. A link made on the phone is not available to the Windows machine unless it is passed over explicitly.
- /stage stops polling for good after the first 401 (src/routes/stage.tsx L34). If the token is rotated mid-live, the embedded wall drops to idle until the iframe is reloaded.
- /api/public/stage/state and /api/public/sets/* send no CORS headers, and server functions are CSRF-protected. Browser JS on our :8800 page cannot call them; the Node gateway must fetch them. Only /api/public/vardy/$tool sends Access-Control-Allow-Origin: *.
- Wall videos play muted (StageView.tsx: autoPlay muted playsInline loop), so opening and supporter videos add nothing to desktop audio. Only the optional chimes make sound, and they are off by default.
- 'מלפנים' items are not rendered by /stage. The live node has to poll /api/public/sets/active and play now_playing {layer:'front', label, url, until} itself; the agent notes the node still needs to be built for this.
- As of the agent's last reports there were no user accounts, no owner role (it is waiting for the owner's email) and no linked TikTok for Tohar. Until that changes, no ingest key can be minted, ingest for tohar.bell returns 404 CREATOR_UNKNOWN, and the wall stays idle.
- setManualHandle lets any signed-in user claim any unclaimed handle with no proof, and stage data is keyed by username. Whoever claims tohar.bell first controls her stage. A live ticket should require link_method 'tiktok_oauth' or owner approval.
- Handle lookups use .ilike('tiktok_username', handle), and '_' is a LIKE wildcard. Handles with underscores can match other creators or make maybeSingle fail.
- Tohar's stage link, token included, is printed in the Lovable chat (agent message 19:04:07Z, preview host). Treat it as exposed and rotate before production. It is probably still valid, since the agent avoided rotating afterwards.
- The app is not a full PWA: manifest and icons exist but there is no service worker. start_url is '/', the public gallery, not the creator panel, and the install button is not mounted on the home page.
- The ingest contract is not in /api/public/live/openapi.json; that file documents only sets/active and sets/played. sets/active also returns battle.head and battle.arena_mode, which the schema omits.
- The server runtime is serverless (nitro, Cloudflare target). It cannot reach a LAN address such as our gateway on :8801 and cannot hold websockets. Any Vardyverse-to-gateway call needs a public URL.
- The process-jobs cron runs every minute against the published site with a 5-second caller timeout, and only checks creators with a linked TikTok.
- The agent never tested a signed-in page. All /stage-control, /set, /create and /profile flows are unverified by a real session; fal jobs, remixes, the battle view and a real live start are also untested.
- Known gaps in delivered briefs: no battle timer on the board, the arena wall switch in battle is saved and exported but not drawn, rows 1 and 3 of /create are 'בקרוב', /identity is a placeholder, and the effects library and gift catalogue are empty until an owner imports them.
- The _authenticated redirect keeps only the pathname, so a deep link like /set?step=golive loses its step after sign-in. /stage without a query answers 307 to /stage?creator=&t=, so always embed the full URL.

## OPEN QUESTIONS
- Do preview and published share one database and storage? If not, Tohar's stage token, walls and opening videos created from the sandbox will not exist on the published host. Agent statements imply they are shared, but I did not test it because that would mean using the token.
- Which email is the owner? No account has the owner role, which blocks ingest keys, effects and gift import, and per-job cost approval.
- Are TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI and TIKTOOLS_WEBHOOK_SECRET configured now? They were missing at 18:45Z; only TIKLEAP_API_KEY was reported as added.
- Should 'issue live ticket' rotate the stage token, or mint a separate short-lived ticket? And how does the Windows gateway redeem it: a public Vardyverse route called from Node, or offline HMAC verification with a new shared secret?
- Will the owner approve the 'התומכות שלי / הזהות שלי' plan in the Lovable editor? Until then /supporters and the identity kit stay unbuilt.
- Which app is the creator's installable PWA: Vardyverse itself (it would need a start_url such as /set and a service worker) or our gateway's /mobile/ page?
- When will the owner republish? The embedded wall and sets/active depend on it.
- Is InstallAppButton mounted anywhere at HEAD, and are there other iframes in components I did not open (vardy/, battle/, manager/, guide, capabilities)?
- Are there further env names in the server files I did not open (ai.server.ts, vardy.server.ts, drive.server.ts, tiktok.server.ts, engine/*.server.ts)?
