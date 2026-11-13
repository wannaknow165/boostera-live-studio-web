# AUDIT: works-when-signed-in

# Vardyverse: what actually works for a normal signed-in creator with a manually entered handle

## 0. Read this first

**The live site is no longer the commit I was told to read.** The baseline (latest completed agent message before the newest user message) is `9b6e056` (12 Nov 20:37:53 UTC). While I was reading, the Lovable agent completed `3b7b681` ("Identity kit: photo upload, one-tap generation…", 23:33:57 UTC). `get_project` now returns `latest_commit_sha=3b7b681`, `agentFinished=true`.

The published site already serves that build, although the agent's report ends "nothing has been published":
- `https://vardy-verse-connect.lovable.app/assets/identity-sl1CJR5m.js` contains "צרי לי הכול", "צלמי עכשיו", "נשארו לך היום … מתוך 30".
- The connect chunk contains "סרקי כדי לפתוח את הדף הזה בטלפון. תתבקשי להיכנס שוב."

So `/identity` is not a placeholder any more. Everything below describes the live build (`3b7b681`); I say where `9b6e056` differs.

**What I read.**
- Code: all 21 `drizzle/migrations` (0000–0020), all 23 `supabase/migrations`, every `_authenticated` route, the creator/stage/fx/identity/ingest-keys/supporter-jobs/tikleap server functions and their `.server` modules, and the public API routes.
- History: the agent's prose for 12 Nov 15:20–23:34 UTC in full; older history (back to 7 Aug) only searched for tool inputs. The message API returns tool inputs and prose, never tool results.
- Public site: anonymous GETs only. Per the read-only rule I did not sign up, sign in or submit anything; the sign-up page was only fetched.
- Line numbers were counted by hand (`read_file` returns unnumbered text): exact for short files, "≈" within a few lines for long ones.

## 1. Accounts, owner role, handles

**Sign-up is open to anyone.** `/auth` (fetched anonymously) shows "כניסה · המשך עם Google · אין לך חשבון? הרשמה".
- Email + password (min 8) calls `supabase.auth.signUp` (`src/routes/auth.tsx:46`); Google goes through `lovable.auth.signInWithOAuth("google")` (`:55`).
- There is no allow-list, invite or approval anywhere in the code.
- After sign-in she lands on `/connect?first=1` (`auth.tsx:8`; baseline: `/connect`).

**Email confirmation: not verified.** It is a Lovable Cloud auth setting, not in the repo. The code expects it may be on (`auth.tsx:48` shows "שלחנו לך מייל לאישור החשבון." when sign-up returns no session). The history back to 7 Aug has only `configure_social_auth {providers:["google"]}`, and no call that changes confirmation. Google sign-in avoids the question.

**Owner role: no path without a database edit.**
- `user_roles` has only a SELECT policy and service-role write (`drizzle/migrations/0006_creator_tiktok_link_and_roles.sql:20-27`: `GRANT SELECT … TO authenticated`, "Users read own roles").
- No server function I read inserts into it.
- The agent says at 18:35, 18:42, 19:57, 20:07 and 20:15 that it is waiting for the owner's email and that nobody holds the role. No later tool call assigns it. Current state not verified.

**What owner unlocks:**
- Ingest keys: `ingest-keys.functions.ts:4-8`, `throw new Error("FORBIDDEN")`.
- Effects and gift-catalogue import: `fx.functions.ts:18-21`, "רק בעלת המערכת יכולה לייבא".
- Approving paid supporter-video jobs: `supporter-jobs.functions.ts:≈124`, `OWNER_ONLY`; the approve tick at creation, `:81-83`.
- Acting on any creator by name: `resolveCreator` in `stage.functions.ts:7-20`, `who()` in `fx.functions.ts:7-17`. The UI exposes this only as `/set?creator=`.
- Reading all creators' rows through RLS.
- An owner with no handle of his own still gets `NOT_CONNECTED` on `/stage-control`.

**Same handle, two users.** First come, first served, with no proof of ownership (the card shows "· הוזן ידנית").
- `setManualHandle` (`creator.functions.ts:38-39`) returns `HANDLE_TAKEN`, shown as "שם המשתמש כבר מחובר ליוצרת אחרת." A unique index on `lower(tiktok_username)` backs it (0006:11).
- The TikTok callback gives "החשבון הזה כבר מחובר ליוצרת אחרת."
- Whoever holds a handle controls everything keyed by it: rotating the stage link (which kills the old one), goals, playbook, queue, the `stage/{handle}/opening|clips` files, and listener events posted for that handle.
- The real creator cannot take it back without a DB edit.

**`tohar.bell` is at risk.** The agent reported it unlinked as of 20:27 UTC, so the first account to type it takes Tohar's stage.
- Linking also changes `wallFolder()` from `tohar.bell/` to the account's session id (`stage/wall.server.ts:14-18`, `return data?.session_id ?? creator`). Her three existing gold walls stop being found.
- Her set saved under `stage:tohar.bell` is orphaned the same way (`fx/set.server.ts`, `setOwnerKey`).

**Two smaller defects:**
- Handle lookups use `.ilike()`, where `_` is a wildcard, so `a_b` collides with `a.b`.
- `creator_accounts` grants INSERT/UPDATE to `authenticated` with an own-row FOR ALL policy (`supabase/migrations/20260808164703_…sql:9,14-19`). A signed-in user can therefore rewrite her own `tiktok_username` or `session_id` directly through the API, bypassing `normalizeHandle`.

## 2. Feature by feature

Result labels: WORKS / OWNER-ONLY / NEEDS SECRET / NEEDS DATA / SILENT.

| Feature | Server functions | Tables and RLS | Preconditions | Result for the normal creator |
|---|---|---|---|---|
| Manual handle | `setManualHandle` | `creator_accounts` (service-role write) | signed in | WORKS; then goes to `/identity` (`connect.tsx:79`). Errors: "שם משתמש לא תקין." / "השמירה נכשלה, נסי שוב." |
| "התחברי עם TikTok" | `startTikTokConnect`, `/api/public/tiktok/callback` | `creator_accounts` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` (`tiktok/oauth.server.ts:4-10`) | NEEDS SECRET. Button disabled: "החיבור הישיר יופעל ברגע שפרטי האפליקציה של טיקטוק יוזנו." (`connect.tsx:112-113`) |
| Stage link create / rotate | `rotateStageLink` → `rotateStageToken` (`stage.functions.ts:42-50`, `stage/state.server.ts:19-26`) | `stage_tokens`: RLS on, no policies, SHA-256 only (0009:1-9) | handle | WORKS. Shown once ("שמרי אותו עכשיו — מטעמי אבטחה הוא לא יוצג שוב."); re-creating cancels the old link |
| Wall image | `generateStageWalls` → `generateWalls`; `pickStageWall` | `stage_settings` ("no client access", 0010:11); bucket `stage` | handle; AI Gateway | WORKS for any creator, no owner gate. See note A |
| Goals | `getStageControl`, `saveStageGoal` | `stage_goals` (RLS `my_stage_creator`, 0009:67-76) | handle | WORKS to save; max 3 active ("אפשר עד 3 יעדים פעילים"). Partly SILENT on the wall, see note B |
| Meters and board on the wall | `stageState` → `boardState`, via `/api/public/stage/state` (stage token) | `live_sessions`, `live_events`, `stage_likes`, `battle_supporters` (server-only) | a live row for her session | NEEDS DATA. Without the listener the wall idles on "הלייב הבא בקרוב 🔔". Test buttons create a "לייב בדיקה" and the wall reacts |
| Energy engine | `getEnergyControl`, `saveStagePlaybook`, `activateStageSuggestion`, `setStageClosing`, `stageQueueAction`, `stageTestEvent` | `stage_playbook`, `stage_challenges`, `stage_pulse`, `stage_queue` ("server only", 0011) | handle; a live | WORKS on the test live (8 default playbook rows are auto-created). Otherwise "אין לייב פעיל כרגע." |
| Quiet, sounds, closing, poll, remixes | `getStageBoard`, `setStageBoard`, `startStagePoll`, `addRemix` | `stage_settings`, `stage_events`, `effects` | handle; poll and closing need a live | WORKS. "כניסה חוזרת" test gives "לא הצליח: NO_SUPPORTERS" |
| "סרטון רקע" from the gallery | `sendStageCommand` (insert with her JWT) | `stage_commands`, policy "Creator manages own stage commands" (0009:73-74) | handle; Drive connector | WORKS, but the gallery is global: the owner's Drive folder (Tohar's 230 clips) for every creator (`stage.functions.ts:35`) |
| Supporter clips, opening, back/front | `stageClips`, `stageOpening` | bucket `stage` under `{handle}/clips` and `/opening`; `stage_commands`; `stage_queue` | handle | "נגני מאחור" WORKS full-wall. Upload is capped at 50 MB by the bucket. "נגני מלפנים" is SILENT: the stage draws nothing, it is only exported as `now_playing` for the external live node. Empty state: "אין עדיין סרטונים." |
| "תומכות עכשיו" and supporter video | `getSupporterStudio`, `adaptSupporterPhoto`, `createPreLiveJob`, `createLiveRequest`, `approveSupporterJob` | `supporter_videos`, `supporter_requests`, `supporter_consents`; bucket `supporter-videos` | owner approval; consent; `FAL_API_KEY` | OWNER-ONLY in practice. See note C |
| Wizard `/set` | `getSetEditor`, `saveSet`, `getLiveBuild`, `setStepProgress` | `live_sets.config` (server-only, 0013) | handle | WORKS as a checklist; steps 3–5 are NEEDS DATA. See note D |
| Live preview pane | none (browser only) | localStorage `vardy-stage-link` | a stage link on this device; camera permission | WORKS per code. Without a link: "אין עדיין קישור במה במכשיר הזה. צרי קישור או הדביקי אותו למטה." Camera refused: "בלי מצלמה — מוצגת צללית". Accepts same-origin `/stage` links only. Removed from `/identity` in the live build |
| `/create` rows | none | none | none | Rows 1 and 3 ("תמונה / סרטון + תיאור ← סרטון", "מחיקת האדם") show "בקרוב". Row 2 is the supporter video (note C). Every "צרי" link from the wizard ends here and cannot create an effect |
| Effects library | `getEffectsLibrary`, `toggleFavorite` | `effects`, `effect_favorites` (server-only) | imported data | NEEDS DATA: "הספרייה עוד ריקה. בעלת המערכת מייבאת את האפקטים בעמוד הייבוא." |
| Effects and gift import | `effectUploadTarget`, `importEffects`, `importGifts` | `effects`, `gift_catalog`; bucket `effects` | owner | OWNER-ONLY: "שגיאה: רק בעלת המערכת יכולה לייבא". The page opens by URL for anyone |
| Identity kit | `getIdentity`, `saveIdentityForm`, `identityUploadUrl`, `confirmIdentityUpload`, `generateKitItem`, `approveKitCandidate`, `getMyKit` | `creator_identity_kits` (select own or owner), `identity_image_usage`; bucket `creator-media` (15 MB) | signed in; photo for 3 of the 5 items | WORKS per code. See note E |
| TikLeap snapshot | cron → `tikleapTick`; `refreshTikleap` has no UI | `creator_profile_snapshots`, `tikleap_*`, `api_calls` | `TIKLEAP_API_KEY`; cron | Runs server-side for every connected handle and is shown nowhere (no client chunk references it). See note F |
| Ingest keys | `listIngestKeys`, `createIngestKey`, `revokeIngestKey` | `service_keys` (no policies) | owner | OWNER-ONLY and SILENT: the section does not render for her |
| `/profile` | `getMyCreator`, `getMyKit`, `getSocials`, `saveSocials` | `creator_accounts` | none | WORKS: handle card, approved-kit thumbnails, socials that rotate on the wall, sign-out. "התומכות שלי" is a placeholder: "רשימת התומכות המלאה בדרך (מחכה לאישור)…" |

**Note A, wall image.**
- Call: `editImage` from `@lovable.dev/ai-gateway`, model `"openai/gpt-image-2.6-sunburst"` (`stage/wall.server.ts:7,46`), 3 candidates, 1088x1920, medium quality.
- Cap: 3 batches per day per creator (`stage/rules.ts:62,70-72`). It is counted before the call, so failed attempts use it up.
- Reference image: her approved kit emblem if she has one, otherwise the Bell Army crest (`wall.server.ts:31-42`, `creator === "tohar.bell" ? toharEmblem : crest`). At `9b6e056` it was always the crest for non-Tohar creators.
- With no wall at all, the stage draws a CSS wall with the Bell Army crest (`StageView.tsx:42`).
- Messages: "הגעת ל-3 יצירות היום" / "היצירה לא הצליחה, נסי שוב מאוחר יותר".

**Note B, goals.** `StageView.tsx` defines `Goals` and `Celebration` but never mounts them. Only the hourly-likes contest (board) and the diamonds goal (jar) are drawn. Shares, followers and comments goals are saved and logged but never appear on the wall.

**Note C, supporter video.**
- A non-owner's job is stored as `awaiting_approval` (`engine/jobs.server.ts:72`). She sees "הסרטון מחכה לאישור עלות" and "הסרטון יחכה לאישור עלות מהבעלים."
- Only an owner can approve, and the owner's screen lists only his own session's jobs. Her job never starts.
- Even an approved job fails `CONSENT_MISSING` unless that supporter wrote "כן" in a live chat delivered by the listener. The consent form is not built.
- `startJob` also needs `FAL_API_KEY` (`jobs.server.ts:106-107`).
- "צרי תמונה מותאמת" does run for anyone: one OpenAI image per click, with no cap (`jobs.server.ts:32-61`).
- With no live: "אין לייב פעיל. המתנות יופיעו כאן ברגע שהמאזין יעביר אותן."

**Note D, wizard steps and what each saves.**
1. הזהות: ticked when a profile picture is approved (baseline: a button "הזהות הזו מתאימה לי ✓").
2. הקיר: `pickStageWall` writes `stage_settings`. The step ticks as soon as any `stage_settings` row exists, even after a failed generation.
3. הפרונט: tiers and per-gift effects, plus the supporter badge (on/off, minimum diamonds, colours), into `live_sets.config`.
4. המכפילים: ×2 / ×3 / ×5 cards.
5. הקרב: snipe, win, MVP, head effect and the arena flag (saved and exported only).
6. האתגרים: playbook rows. Ticks itself the first time any page mounts the energy panel.
7. התומכות והסרטונים: `stage_queue`.
8. בדיקה: test events.
9. עולה ללייב: stage link and listener status ("עוד לא התקבלו אירועים מהמאזין…").

Steps 3–5 show "הספרייה עוד ריקה — אחרי ייבוא האפקטים הם יופיעו כאן לבחירה. אפשר לדלג ולחזור." and "קטלוג המתנות עוד לא יובא…". Every select offers only "— בלי אפקט —". There is no milestones editor.

**Note E, identity kit (live build only).**
- "צרי לי הכול" makes 10 images one after another: profile, emblem, team emblem, character, six faces.
- Calls: `editImage` / `generateImage`, same model (`identity/images.server.ts:6,49-50`), 1024x1024.
- Cap: 30 images per UTC day per account, in SQL (`identity_image_take`, 0020:40-52; taken before the call, `images.server.ts:35-37`).
- The server does not require a handle (`identity.functions.ts:13-16`).
- Errors: "הגעת ל-30 התמונות של היום. אפשר להמשיך מחר." / "צריך קודם להעלות תמונה שלך." / "המערכת סירבה ליצור את התמונה הזו. נסי שוב או העלי משלך."
- The agent tested 2 real images on the preview only. The full run, a real phone camera, "להעלות משלי" and the signed-in home kit are untested.
- Not changed by this build: the stage fallback and reward burst still use the Bell Army crest; `/api/public/sets/active` still exports Tohar's emblem for every creator (`routes/api/public/sets/active.ts:2,16`).

**Note F, TikLeap.**
- The account limit is 50 calls a day. Each connected handle can take up to 24 live checks a day plus a snapshot (`tikleap/rules.ts:3-7`).
- Two or three sign-ups with any typed handle starve Tohar's tracking.
- The agent reported the cron exists but has a 5-second timeout; delivery is not verified.

**Outside the list, but on every page.** The "ורדי / מה לעשות היום?" dock is mounted on all routes except `/stage` (`__root.tsx:≈166`).
- Its server functions have no auth middleware and take a client-made `sessionId` (`chat.functions.ts:26-31` `sendChat`, `:48` `confirmChat`).
- `confirmChat` accepts `deep_sync`, `create_video`, `post_queue`, `post_draft`, `schedule_post` (`:36`).
- An anonymous visitor can spend AI credits. `create_video` calls `startRender`, labelled in code as an action that costs credits; I did not read `vardy.server.ts`.
- For a signed-in creator the dock is tied to her browser, not her account, so it shows nothing of hers.

## 3. Secrets the code reads (names only)

| Secret | Gates | State |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | everything; the publishable key also authorises the `process-jobs` cron | present (site runs) |
| `LOVABLE_API_KEY` | vision gates for supporter video (`engine/gates.server.ts:17-21`), chat, Drive/OneDrive connector auth, `/api/public/library/sync`; presumably the image SDK too (wall, kit, face-fit; SDK internals not in repo) | present (gallery media answered 200/206) |
| `GOOGLE_DRIVE_API_KEY_1` | home gallery, wall background videos, supporter-video source download | present (same evidence) |
| `MICROSOFT_ONEDRIVE_API_KEY` | older OneDrive-sourced library items | reported present |
| `GALLERY_OWNER_CODE` | the × on the home gallery ("קוד בעלים עדיין לא הוגדר" / "קוד שגוי", `library.functions.ts:39-41`) | add-secret request in history; not verified |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` | TikTok login | reported missing |
| `FAL_API_KEY` | supporter-video engine; legacy Kling renders | reported present (a paid test ran 12 Nov) |
| `TIKLEAP_API_KEY` | TikLeap snapshot and stream tracking | reported set 12 Nov 20:03 |
| `TIKTOOLS_WEBHOOK_SECRET` | `/api/public/live/tiktools` (503 "Webhook is not configured."); without it TikLeap polls every 30 min | reported missing |
| `TIKTOOLS_API_KEY`, `TIKTOOLS_API_BASE` | legacy in-app poller (fixture mode without it) | not verified |
| `SOCIALECHO_API_KEY`, `SOCIALECHO_BASE_URL` | legacy publishing queue | add-secret request in history |
| `APIFY_API_KEY`, `VARDY_OAUTH_ISSUER`, `GOOGLE_DRIVE_API_KEY` | legacy profile sync, GPT/MCP OAuth, old Drive panel | seen only in history; files not re-read |

## 4. What the owner must do himself, in order

1. **Sign up (Google is simplest) and get the owner role inserted** for that account: one row in `public.user_roles`. The Lovable agent has been waiting for his email. Until then there are no ingest keys, no imports and no video approvals.
2. **Decide which account holds `tohar.bell` before typing it anywhere.** For his phone test he should use a different handle. When Tohar's account links, regenerate or re-pick her wall, because the stored walls move out of reach (section 1).
3. **Link Tohar's handle** at `/connect`. Until a `creator_accounts` row has it, the listener's ingest answers `CREATOR_UNKNOWN` (`live/ingest.server.ts:32-34`) and the TikLeap cron skips her.
4. **As owner on `/profile`, press "מפתח חדש"**, copy the key (shown once) and put it in the external listener as `X-Vardy-Service-Key`. Without it no real live data reaches any wall.
5. **As owner at `/effects/import`, import the effects catalogue with its media and the 663-gift JSON.** Wizard steps 3–5 and gift icons stay empty until then.
6. **On `/stage-control`, press "צרי קישור"**, save it, and load it in the studio server. Tohar's current link was issued on the preview domain and dies when anyone presses "צרי קישור חדש".
7. **Add the three TikTok secrets**, with redirect `https://vardy-verse-connect.lovable.app/api/public/tiktok/callback`, to get real handle verification. Add `TIKTOOLS_WEBHOOK_SECRET` if the lifecycle webhook is wanted.
8. **Decide on cost exposure while sign-up is open.** Each account can make 30 kit images and 9 wall images a day plus uncapped face-fit images; each typed handle eats TikLeap quota; the ורדי dock needs no sign-in. Restricting sign-up or locking the chat functions is a code change for the Lovable agent.
9. **Check the email-confirmation setting** in Lovable Cloud, and that the cron reaches the published `/api/public/hooks/process-jobs`.
10. **Supporter videos:** approve each job's cost (owner only) and decide the consent-form wording. Today only his own account's jobs can be approved.

## 5. Not built

- `/supporters` ("התומכות שלי", plan Change 1): the list, photo fetch, "ראינו בלייב", greeting mode, gift leaderboard.
- The `/live` screen and realtime updates.
- `/create` rows 1 and 3; any way to create an effect from a "צרי" link.
- The consent form (method `form`).
- An owner view of other creators and their pending jobs; any UI to grant the owner role; per-creator ingest keys in the UI (the server supports them).
- Any screen for TikLeap data, and the "רענון" button.
- Handle ownership verification (TikTok login is coded but inactive).
- The ingest contract in OpenAPI: the published `/api/public/live/openapi.json` lists only `/api/public/sets/active` and `/api/public/sets/played`.
- Arena mode on the wall, the battle timer, a milestones editor.
- Per-creator emblem on the stage and in the live-node export; per-creator colours in wall prompts; a per-creator video library.
- Front-layer playback: it depends on the external live node reading `now_playing`.

## 6. Not verified

- Email-confirmation setting; whether anyone holds the owner role now; who, if anyone, holds `tohar.bell`.
- Database contents: `query_database` was off-limits.
- Bucket existence and limits beyond the agent's tool inputs (`supporter-videos` 200 MB, `stage` 50 MB, `effects` 200 MB, `creator-media` 15 MB).
- Cron delivery; identity generation on the published runtime.
- Legacy modules I did not open: `vardy.server.ts`, `tiktok.server.ts`, the drive, posts, battle, team, brain and mcp files, `live/control.server.ts`, `StageBoard.tsx`, `ArenaBoard.tsx`.

## TOP FINDINGS
- The live site is already at commit 3b7b681 (identity kit, completed 23:33:57 UTC), not the 9b6e056 baseline: the published bundle contains "צרי לי הכול" and the new QR caption, although the agent's report says nothing was published. /identity is no longer a placeholder.
- Sign-up is open to anyone (email+password or Google, src/routes/auth.tsx:46,55) with no allow-list. Whether email confirmation is enforced is a Lovable Cloud setting that is not in the repo: not verified.
- There is no path to the owner role without a database edit: user_roles is SELECT-only for users (migration 0006:20-27) and no server function writes it. The agent repeatedly reported nobody holds the role and that it is waiting for the owner's email.
- Until an owner exists, three things are dead for everyone: ingest keys (so no real live data reaches any wall), effects and gift-catalogue import (wizard steps 3-5 show "הספרייה עוד ריקה…"), and supporter-video approval.
- Manual handles are first come, first served with no ownership proof. The second user gets "שם המשתמש כבר מחובר ליוצרת אחרת." The holder controls the stage link, goals, queue and stage/{handle} files for that creator.
- tohar.bell was reported unlinked as of 20:27 UTC, so the first account to type it takes Tohar's stage. Linking also moves the wall folder to the account's session id (wall.server.ts:14-18), so her three existing walls stop showing.
- For a normal creator these work today: stage link create/rotate, wall generation (openai/gpt-image-2.6-sunburst via the Lovable AI Gateway, 3 batches a day), goals, energy engine and board on a test live, playing uploaded clips behind her, opening playlist, live preview pane, socials, and the identity kit (30 images a day, SQL cap).
- Supporter videos cannot run for a normal creator: jobs wait as "מחכה לאישור עלות", only an owner can approve and his screen lists only his own jobs, and consent exists only as a live-chat "כן" delivered by the listener (the consent form is not built).
- Silent gaps: "נגני מלפנים" shows nothing without the external live node; shares, followers and comments goals are saved but never drawn (Goals is defined but not mounted in StageView.tsx); the ingest-keys section just does not render; TikLeap data is collected but shown on no screen.
- Other creators still get Tohar's assets: the gallery is the owner's single Drive folder (230 clips) for everyone, the stage fallback and wall reference default to the Bell Army crest, and /api/public/sets/active always exports Tohar's emblem.
- Open cost exposure: every sign-up can make 30 kit images and 9 wall images a day plus uncapped face-fit images (engine/jobs.server.ts:32-61), each typed handle can use up to 24 of the 50 daily TikLeap calls, and the ורדי chat dock's server functions have no auth at all (chat.functions.ts:26-48).
- Reported missing secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI (TikTok login disabled) and TIKTOOLS_WEBHOOK_SECRET. LOVABLE_API_KEY and GOOGLE_DRIVE_API_KEY_1 are confirmed working on the published site; FAL_API_KEY and TIKLEAP_API_KEY are reported set.
- Not built: /supporters, /live, /create rows 1 and 3, the consent form, any owner admin view, any TikLeap screen, and the ingest contract in the published OpenAPI (it lists only the two sets endpoints).
