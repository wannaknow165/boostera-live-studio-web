# AUDIT: requirement-trace

# Vardyverse requirement trace R1–R9 (13 Nov 2026, ≈00:20 UTC)

## Summary

- **The published site changed while I was reading.** The build the owner complained about (commit `9b6e056`, "A") was replaced at ≈23:45 UTC by a build that contains the identity kit (commit `3b7b681`, "B"). B is still live at 00:16 UTC.
- **Nobody has opened B with a real session.** The identity kit is now live but has only been exercised once, partially, by the Lovable agent with a throw-away account in its sandbox.
- **Most of R1–R9 exists as code, not as something a new creator can use tonight.** It works only with "בדיקה" buttons, only with Tohar's data, or not at all (R2 scan, R4, two of three creation rows).
- **One built feature is broken by code:** the camera cut-out in the live preview (R8).

Everything was read-only: no sign-in, no form, no database query, no browser.

## 0. The two builds

| | Build A | Build B |
|---|---|---|
| Commit | `9b6e056` (agent message completed 12 Nov 20:37:53Z) | `3b7b681` (completed 23:33:57Z) |
| Why it matters | Latest completed commit before the 23:26:15Z "BUILD Change 2" message; what the owner saw | Identity kit build |
| Evidence on the live site | At 23:43Z the HTML referenced `/assets/index-DNZbD_Ip.js`; its chunk list had `identity-DOTfYZx3.js` and no `identity.functions` chunk | From 23:46:54Z the HTML references `/assets/index-DL9-NV3w.js` with `identity-sl1CJR5m.js` and `identity.functions-Dw8UIM55.js` |

- At ≈23:45Z the old index still returned 200; by 23:45:51Z the old route chunks returned 404.
- The live B chunks contain "צרי לי הכול", "צלמי עכשיו" and the new QR caption. "עוד בבנייה" and "הזהות הזו מתאימה לי" are gone.
- The agent's last message says "nothing has been published", so someone else published. No chat message records it.
- Line numbers below are for B unless marked (A). Files not named as changed are identical in both.

## 1. The sign-up page (looked at, did not register)

- Public GET `/auth` shows "כניסה", "המשך עם Google", email and password, and "אין לך חשבון? הרשמה".
- Sign-up is open in code: `supabase.auth.signUp` with no allow-list (`src/routes/auth.tsx:46`). It may answer "שלחנו לך מייל לאישור החשבון." (:48).
- The home page has no link to it: the live HTML has zero `<a href>` and no "כניסה" or "הרשמה". A creator must type `/auth` or a panel address.
- After sign-in, A goes to `/connect`; B goes to `/connect?first=1` (`auth.tsx:8`).

## 2. Trace

Each row gives: asked · code · published · new creator on a phone · real-session check · gap.

### R1 Navigation

**R1.1 Three headings, no account heading**
- Code: yes. `src/components/build/CreatorNav.tsx:10-12`: "לייב" (/set), "יצירה" (/create), "פרופיל" (/profile).
- Published: A and B (chunk `CreatorNav-C8Y7wKG3.js`, same hash in both).
- Phone: yes on panel pages. Missing on the home page (`src/routes/index.tsx:138-139`) and on the "connect first" screens (`set.tsx:94-100`, `stage-control.tsx:53`).
- Real session: the agent's throw-away account saw it on /connect, /identity, /profile at 375 px in its sandbox. Never on /set, /create, /stage-control.
- Gap: the nav exists, but the home page gives no way into it.

**R1.2 "לייב": wizard, stage controls, test, go live**
- Code: nine steps (`src/lib/fx/rules.ts:41-51`; `src/routes/_authenticated/set.tsx:130-196`), "שליטה בבמה" (:111), test step (:193), go-live (:338-344).
- Published: A and B.
- Phone: only after a handle is saved.
  - Steps 3–5 have nothing to pick: "הספרייה עוד ריקה — אחרי ייבוא האפקטים הם יופיעו כאן לבחירה. אפשר לדלג ולחזור." (:103); "קטלוג המתנות עוד לא יובא…" (:228).
  - Step 9 is a computer task: "ב-TikTok LIVE Studio (או OBS): הוסיפי מקור…" (:340).
  - Progress ticks by itself: "wall" is done when any `stage_settings` row exists and "challenges" when any playbook row exists (`src/lib/fx.functions.ts:213-214, :219`). Those rows are created before a wall is generated (`wall.server.ts:27`) and when the page is opened (`stage.functions.ts:170`).
- Real session: none ("I couldn't open it signed in", agent 20:01Z).
- Gap: three of nine steps are empty and the "X/9" count is not trustworthy.

**R1.3 "פרופיל": connection, identity items, my supporters, keys**
- Code: `src/routes/_authenticated/profile.tsx`: connection (:50-62), identity (:64-71), supporters placeholder (:73-77), keys (:84).
- Keys render only for an owner (`src/lib/ingest-keys.functions.ts:4-7`).
- Published: A and B. Phone: yes.
- Real session: the agent's test account saw its approved picture there (B, sandbox).
- Gap: "my supporters" is one sentence, and the keys block is hidden from everyone because no account has the owner role (agent 20:07Z and 20:15Z; not checked in the database).

### R2 Connect the account

**R2.1 Scan a barcode with the phone or TikTok**
- Code: not built.
  - The QR encodes only `${window.location.origin}/connect` (`connect.tsx:58, :116`).
  - It renders only on `(min-width: 768px) and (pointer: fine)` (:59, :114).
  - The TikTok button is disabled with "החיבור הישיר יופעל ברגע שפרטי האפליקציה של טיקטוק יוזנו." (:112-113). It needs three secrets (`src/lib/tiktok/oauth.server.ts:4-10`).
- Published: verified live. GET `/api/public/tiktok/callback` returns 302 to `/connect?error=not_configured` (`callback.ts:13`).
  - A caption: "סרקי עם הטלפון כדי להמשיך משם" (`connect.tsx:110`, A).
  - B caption: "סרקי כדי לפתוח את הדף הזה בטלפון. תתבקשי להיכנס שוב." (:117).
- Phone: no QR at all and a greyed-out button.
- Real session: the owner hit this in A. Nobody has run the TikTok round trip.
- Gap: there is nothing to scan; the only QR reopens the same page and asks for sign-in again.

**R2.2 Manual handle fallback**
- Code: `src/lib/creator.functions.ts:28-45`. B then goes to /identity (`connect.tsx:79`); A only refreshed the page (`connect.tsx:72`, A).
- Published: A and B. Phone: yes.
- Real session: the agent saved a handle through the UI in B (sandbox). For A it "didn't test the signed-in page" (18:35Z).
- Gap: the handle is not verified. With open sign-up anyone can claim a free handle, including tohar.bell, and manage that creator's stage, which is keyed by username (`stage.functions.ts:17-19`). "מחוברת" starts no listening.

### R3 Identity

**R3.1 Upload her photo**
- Code A: no. Placeholder "ערכת הזהות (יצירה מהתמונה שלך ואישור) עוד בבנייה. בינתיים הלייב משתמש בזהות הקיימת:" with Tohar's three files (`identity.tsx:35, :8-10`, A).
- Code B: yes (`identity.tsx:146-163`).
  - "צלמי עכשיו" (:156, front camera :169) and "בחרי מהגלריה" (:157).
  - "…רק את והמנהל רואים אותה." (:153).
  - Shrunk in the browser to a JPEG (`src/components/identity/upload.ts:5-12`), then a signed upload to the private bucket `creator-media` (`src/lib/identity.functions.ts:6, :67-79`).
- Published: B only. Phone: yes by code.
- Real session: the agent used "בחרי מהגלריה" once in its sandbox. The file was the AI-made `tohar-character.jpg`, not a real photo. Camera and a real phone are untested.
- Gap: the bucket was created by a tool call, not by migration `0020_identity_kit.sql` (51 lines, no storage statement), so its existence behind the published site is unproven.

**R3.2 Generate profile picture, emblem, team emblem, battle character, funny faces**
- Code B:
  - Five items and six faces (`src/lib/identity/rules.ts:3, :9`).
  - "צרי לי הכול" (`identity.tsx:89`) runs ten server calls from the page (:57-64).
  - Per slot: "צרי / עוד אחד / נסי שוב" (:214) and "אשרי" (:206).
  - Cap of 30 a day in SQL (migration 0020:40-50; `images.server.ts:35`).
- Published: B only.
- Phone caveats: the loop lives in the page ("10 תמונות · בערך 7 דק׳"; the 40 s per image is a guess, `rules.ts:11`), so locking the phone stops it. The cap is taken before the image call (`images.server.ts:35` vs :47-51), so failures use up quota.
- Real session: 2 of 10 images, once. "Not tested: the full 10-picture run" (agent).
- Gap: the owner's test (real face photo, ten pictures, on his phone) has never been run. Earlier today a real-photo request for the six faces was blocked by the image service's safety filter (agent 15:45Z).

**R3.3 Or upload her own**
- Code B: "להעלות משלי" (`identity.tsx:216`). Always saved as JPEG (`upload.ts:11`; `identity.functions.ts:74`), so a transparent emblem is flattened.
- Real session: "Not tested" (agent).
- Gap: untested and cannot keep transparency.

**R3.4 Every generated image from OpenAI**
- A broke the rule: the battle poster used "google/gemini-3-pro-image-preview" (`src/lib/ai.server.ts:209`, A).
- B: all four call sites I read use `openai/gpt-image-2.6-sunburst`:
  - wall (`src/lib/stage/wall.server.ts:7, :46`)
  - supporter face fit (`src/lib/engine/jobs.server.ts:44`)
  - kit (`src/lib/identity/images.server.ts:6, :49-50`)
  - poster (`ai.server.ts:205`), which the agent "didn't run".
- Gap: other generators in the repo were not searched; `.lovable/plan.md:6` still names gpt-image-2.5.

**R3.5 Her approved items replace Tohar's**
- Code B, replaced:
  - /profile (`profile.tsx:56, :66-70`).
  - Home kit when signed in (`src/components/vardy/BrandKit.tsx:41-52`). Each unapproved item falls back to Tohar's file (:50) under titles such as "סמל הקבוצה · Bell Army" (:32).
  - Wall reference (`wall.server.ts:31-35`), else Tohar's team crest (:39).
- Not replaced:
  - Stage art before a wall exists and the reward burst (`src/components/stage/StageView.tsx:42, :308`).
  - The emblem sent to the live node (`src/routes/api/public/sets/active.ts:2, :16`).
- Real session: /profile only.
- Gap: her kit shows on two pages; the wall, the stage and the export still carry Tohar's art.

### R4 My supporters

**R4.1 A manual list**
- Code: not built. `profile.tsx:75`: "רשימת התומכות המלאה בדרך (מחכה לאישור). בינתיים — תור הסרטונים לתומכות בלייב."
- Published: verified. GET `/supporters` returns 404 "העמוד לא נמצא" in A and B.
- Gap: the feature does not exist.

**R4.2 Choose supporters, then generate videos**
- Code: one supporter at a time (`create.tsx:67-68`; `src/components/supporters/SupporterPanels.tsx:48-88`). A job cannot run for a creator:
  - Only an owner approves ("OWNER_ONLY", `supporter-jobs.functions.ts:124`; "הסרטון יחכה לאישור עלות מהבעלים.", `SupporterVideoMaker.tsx:146`).
  - `startJob` refuses unapproved rows and needs `FAL_API_KEY` (`jobs.server.ts:102, :107-108`).
  - Consent must be a live-chat "כן" or a form; the form page is not built (agent 15:54Z).
- Published: A and B.
- Real session: none ("I haven't run a single real one", agent 20:15Z).
- Gap: no supporter video can be produced tonight.

**R4.3 Gift data only informative**
- Code: the only list is gift-ranked and empty without the listener: "אין לייב פעיל. המתנות יופיעו כאן ברגע שהמאזין יעביר אותן." (`SupporterPanels.tsx:60`).
- Gap: the opposite of the request.

### R5 Creation

- **R5.1 Image or video + prompt → video:** a card with "בקרוב" (`create.tsx:28, :62`). Stub.
- **R5.2 Gifts with a supporter:** the card says "פתוח למטה ↓" (:29, :62). Below it is the R4.2 form with no gift choice. Template clips are Tohar's Drive gallery for every creator (`supporter-jobs.functions.ts:173`).
- **R5.3 Erase a person:** "בקרוב" (:30, :62). Stub.
- **R5.4 Effects library:** the page exists, but import is owner-only (`fx.functions.ts:18-21, :84, :129`). It shows "הספרייה עוד ריקה. בעלת המערכת מייבאת את האפקטים בעמוד הייבוא." (`effects.index.tsx:60`). Every "צרי" link in the wizard lands on /create, where nothing can be made (agent 20:03Z).
- Published: A and B. Real session: none.
- The home page also shows "מה נייצר?" with four "בקרוב" cards (`index.tsx:89-94, :161`); verified live.

### R6 The wall

**R6.1 Still gold wall with her emblem**
- Code: generator (`wall.server.ts:21-65`; prompt in `src/lib/stage/rules.ts:74-84`), "הקיר מאחורייך" (`stage-control.tsx:90`), "צרי 3 הצעות חדשות" (`set.tsx:290`), three batches a day (`rules.ts:62`).
- Phone: she starts with no wall.
  - Until she generates one, her stage shows Tohar's team crest (`StageView.tsx:42`).
  - Colours are always "pink and gold" (`rules.ts:78`).
- Real session: the app's generator has never run from the UI. Tohar's three candidates came from a one-off sandbox script (trace 19:09Z); candidate 1 carries "TOHAR BELL" lettering.
- Gap: a wall with her emblem needs kit → approve → generate, a chain nobody has run. Tohar's existing walls sit in folder "tohar.bell" and will vanish from the pickers once that handle is linked to an account (`wall.server.ts:14-18, :67-74`).

**R6.2 Full, clean, premium**
- Code: status line, glass board, LED line, jar (`StageView.tsx:293-309`). The old goals rail and celebration are dead code (:147, :186).
- Real session: one screenshot on a synthetic route with no wall image; "haven't been seen during a real live" (agent 20:37Z).
- Gap: never viewed over a real wall.

**R6.3 Supporter and opening videos full-wall, with buttons**
- Code: "נגני מאחור" / "נגני מלפנים" (`SupporterClips.tsx:56`), "הוסיפי לפתיחה" (:58), "העלי סרטון" (:41), "נגני פתיחה" (`OpeningControl.tsx:18`). Full-wall by default (`StageView.tsx:132`).
- Real session: none ("tapping the buttons themselves is unchecked", agent 20:28Z).
- Gap: built but unclicked. The "נגני על הקיר" button the agent reported no longer exists in code.

**R6.4 Two opening videos already uploaded**
- They exist only for the handle tohar.bell: storage `stage/tohar.bell/opening/…` and queue rows for 'tohar.bell' (trace 20:27Z).
- Any other handle sees "אין סרטוני פתיחה." (`OpeningControl.tsx:23`) and "אין עדיין סרטונים." (`SupporterClips.tsx:46`).
- Not verified in the published backend.

**R6.5 Front/back per video**
- Code: yes (`SupporterClips.tsx:56`; `OpeningControl.tsx:27`; `EnergyControl.tsx:104`).
- Gap: "מלפנים" only hands the video to an external program that does not read it yet (`state.server.ts:175`; agent 20:32Z).

### R7 Meters, contest, goals, energy engine

- **R7.1 Likes meter:** built (`ArenaBoard.tsx:142, :155-178`). It counts total likes to the next 10,000 (`board.ts:12-16`).
- **R7.2 Hourly contest, a video for the top liker:**
  - Goal 10,000 "סרטון לזוכה" per UTC clock hour (`stage/rules.ts:6, :17`); the winner is written to a log (`state.server.ts:98-106`).
  - No code creates a video for the winner. The "מייצרת סרטון…" ring shows when any job is running (`StageView.tsx:301-302`).
  - The bar counts all likes and the contest counts this hour's, so they can disagree.
- **R7.3 Goals:** five kinds are editable (`stage-control.tsx:130`), but only the contest and the diamonds jar are drawn. A reached shares or followers goal shows nothing (agent 20:37Z).
- **R7.4 Energy engine:**
  - 240 s gap (`energy.ts:14`), dip rules (:37-56), playbook (:79-88).
  - Two dip challenges need her tap within 60 s in the panel (`EnergyControl.tsx:72-77`).
  - Two reward texts are the agent's own placeholders (:83, :87).
- **R7.5 Real data:** events arrive only from an external listener with a key (`src/lib/live/ingest.server.ts:17-21, :32-34`), and only an owner can mint keys.
- Published: A and B.
- Real session: the agent clicked the energy test buttons on a signed-in /stage-control with a throw-away account at 1280 px in its sandbox (trace 19:49Z). No real live, no phone.
- Gap: with no owner there is no key, so tonight the wall reacts only to "בדיקה" buttons.

### R8 See her live while building

**R8.1 Live preview**
- Code: "תצוגה חיה" on /set (`set.tsx:126`) and /stage-control (`stage-control.tsx:60`). Removed from /identity in B (it was at `identity.tsx:32` in A).
- It needs a stage link saved on the same device: "אין עדיין קישור במה במכשיר הזה. צרי קישור או הדביקי אותו למטה." (`src/components/stage/LivePreviewPane.tsx:118`).
- The create button is in step 9 or far down stage-control, and "יצירה מחדש מבטלת את הקישור הקודם" (`stage-control.tsx:72`).
- Real session: the pane has never been rendered in any test.
- Gap: an empty frame tops every step, and making a link on the phone kills the one loaded on the studio PC.

**R8.2 Her camera cut out in front of the wall**
- Code: present, but `setState("on")` (`LivePreviewPane.tsx:42`) is followed at once by `canvas.current!.getContext("2d")` (:43), while the canvas is rendered only when the state is "on" (:76).
- With React 19 the canvas is not mounted yet, so this throws and nothing is drawn. The published chunk has the same order.
- Real session: none. The agent's "the cut-out loaded" was a stand-alone MediaPipe snippet with a fake camera (trace 20:06Z), not this component.
- Gap: by code the cut-out cannot work as published. I did not run it.

### R9 Usable from the phone

- **R9.1 One screen with panels:** not built that way.
  - Seven separate pages.
  - /stage-control is one column of about twenty cards.
  - /set stacks a ~300×533 px preview above each step (`set.tsx:125-126`).
  - Only /identity in B is phone-first.
- **R9.2 Blockers by code:**
  - The floating "מה לעשות היום?" pill is fixed bottom-left above everything (`ManagerDock.tsx:70`; `__root.tsx:152`). The wizard's bottom bar puts "המשיכי" at the far left in RTL (`set.tsx:208-214`). By layout the pill covers that button on a narrow screen; not seen in a browser.
  - Dead end: "קודם צריך לחבר חשבון טיקטוק בעמוד ההתחברות." with no link and no nav (`stage-control.tsx:53`).
- Real session: only the identity path at 375 px emulation.

## 3. Where the agent's reports and the code differ

- **18:35Z "a QR code to continue on a phone":** it reopens /connect with a new sign-in.
- **20:01Z "steps tick themselves from what she actually did: the wall once picked":** they tick on any settings row.
- **20:06Z preview "on the identity page":** gone in B, unmentioned. "The cut-out loaded" was a library smoke test.
- **20:15Z "her starred gallery videos":** stars come from this browser's local storage (`SupporterVideoMaker.tsx:16`) and the gallery is Tohar's Drive folder.
- **20:37Z ring "while her video is being made":** no winner job exists.
- **19:57Z–20:32Z "no accounts, couldn't click through":** at 19:49Z it had made a throw-away account to click /stage-control. Later pages could have been tested the same way and were not.
- **23:33Z "made from a photo":** the file was an AI character image.
- **23:33Z "nothing has been published":** true then; published ≈23:45Z.

## 4. Works only for Tohar or is hard-coded to her

- **Home page:** five fixed pictures and "טוהר בל · מלכת הפעמון" (`BrandKit.tsx:30-34, :56`), "הסרטונים של טוהר" and 230 videos (`featured-creator.ts:5-6`; `index.tsx:143`), "הדמות של טוהר נכנסת לסרטון" (:91).
- **Gallery:** every "gallery" picker is the owner's Drive folder (`stage.functions.ts:35`).
- **Stage:** Tohar's emblem or crest switch (`StageView.tsx:42, :308`) and 🔔 in generic strings (:206, :219).
- **Walls:** reference emblem and pink/gold palette.
- **Live-node export:** Tohar's emblem for every creator (`sets/active.ts:2`; `set.server.ts:85, :89`).
- **Data under 'tohar.bell' only:** three wall candidates, two opening videos, the TikLeap snapshot.

## 5. Stubs and placeholders

- "בקרוב": `index.tsx:161` (four cards), `create.tsx:62` (two rows), `ArenaBoard.tsx:131`, `StageBoard.tsx:130`, `StageView.tsx:206`.
- `profile.tsx:75` "בדרך (מחכה לאישור)".
- `QrCard.tsx:6` "placeholder until real pairing codes are wired up" (no use found in the files I read).
- Guessed constants: 40 s per image (`identity/rules.ts:11`), 0.04 cost (`images.server.ts:69`), 6 minutes per video (`engine/requests.ts:5`).
- Three chime files of identical size (5,556 bytes) made by the agent.
- No TODO comments in the files I read; the whole repo was not searched.

## 6. Not verified

- Whether any account has the owner role.
- Whether the backend behind the published site holds the data the agent wrote from its sandbox. The live bundle and `supabase/config.toml` name the same project, but at 23:28Z the agent saw no creator accounts and wondered about "a different DB".
- `FAL_API_KEY`, and whether sign-up needs email confirmation.
- Any runtime behaviour behind sign-in on B.
- A full stage link including its `t=` value was printed in the Lovable chat at 19:04Z (<redacted> here); whether it is still valid.

## 7. Ten most important gaps, by first-session visibility (Build B)

1. **No way in.** The first screen is Tohar's showcase with no sign-in link.
2. **Nothing to scan.** The TikTok button is disabled (keys missing, verified live), there is no QR on a phone, and the desktop QR only reopens the page.
3. **Identity kit is live but unproven.** No real photo, no real phone, no full ten-picture run, not on the published site; the run takes about seven minutes with the page open.
4. **Her pictures stop at two pages.** Home, stage, wall and export still show Tohar's emblem, crest, colours and gallery.
5. **The "לייב" wizard is a shell.** Three steps are empty, progress ticks by itself, "המשיכי" is likely covered by the floating pill, and step 9 needs a PC.
6. **The camera cut-out is broken by code** and the preview pane has never been rendered in a test.
7. **"יצירה" is mostly "בקרוב".** Two of three rows are stubs, the third cannot finish, and the effects library is empty.
8. **"התומכות שלי" does not exist** (`/supporters` is 404).
9. **No real live data can arrive.** Listener keys need an owner and none exists; the contest's prize video is never created.
10. **Wall content is Tohar's.** A new creator has no wall and no opening videos; "מלפנים" shows nothing; Tohar's own walls will be orphaned when her handle is linked.

## What I read

- **Messages:** the prose of all 61 messages from 12 Nov 15:20Z to 23:33Z. Tool traces: the 23:33Z build in full; keyword searches of the 19:09Z, 19:49Z, 20:06Z and 20:27Z traces. Nothing before 15:20Z.
- **Code:** about 50 files at A and all 18 changed or new files at B. Not read: battle, brain, vardy, tikleap, `live/control.server.ts`, `effects.import.tsx`, older migrations.
- **Working copies** (both commits, decoded traces, published chunks): `C:\Users\shk\AppData\Local\Temp\claude\35e603d462edf4d8\544f0b39-3e01-488d-8ecd-246aa57399c4\scratchpad\rt79`. The raw message dumps in that folder contain the stage link value.

## TOP FINDINGS
- Published build changed mid-audit: commit 9b6e056 (what the owner saw, identity placeholder) was replaced at about 23:45 UTC by commit 3b7b681, which contains the identity kit. The agent's last message says 'nothing has been published', and nobody has opened the new build with a real session.
- Gap 1 - no way in: the public home page is Tohar's showcase (her five pictures, 'הסרטונים של טוהר', 230 videos, four 'בקרוב' cards) with zero links; a creator must type /auth. Sign-up is open in code with no allow-list (src/routes/auth.tsx:46).
- Gap 2 - nothing to scan (R2): TikTok app keys are still missing on the live site (GET /api/public/tiktok/callback redirects to /connect?error=not_configured), so 'התחברי עם TikTok' is disabled; no QR renders on a phone and the desktop QR only encodes /connect (connect.tsx:58, :116). Manual handle is the only path and is unverified, so anyone who signs up can claim tohar.bell.
- Gap 3 - identity kit (R3) is live only since 23:45 UTC and unproven: the agent made 2 of 10 images once in its sandbox using an AI character image as the 'photo'. A real face photo, a real phone camera, the full ten-image run (about 7 minutes, driven by the open page), 'להעלות משלי' and the published site are all untested; the creator-media bucket is not in migration 0020.
- Gap 4 - her approved pictures reach only /profile and the signed-in home kit (with Tohar's files as fallback). The stage art (StageView.tsx:42, :308), walls generated before an emblem is approved (wall.server.ts:39), the pink/gold palette and the live-node export (api/public/sets/active.ts:2) still use Tohar's emblem or Bell Army crest.
- Gap 5 - the 'לייב' wizard is a shell for a new creator: steps 3-5 have an empty effects library and gift catalog (owner-only import, no owner), progress ticks on side effects (fx.functions.ts:213-219), the floating 'מה לעשות היום?' pill sits over the 'המשיכי' button on a phone by layout (ManagerDock.tsx:70 vs set.tsx:208-214), and step 9 tells her to use LIVE Studio or OBS.
- Gap 6 - R8 camera cut-out is broken by code: LivePreviewPane.tsx:42-43 reads canvas.current right after setState('on') while the canvas only renders in that state (:76), so with React 19 it throws and nothing is drawn. The pane was never rendered in any test; the agent only ran a stand-alone MediaPipe snippet. The preview also needs a stage link saved on the same device.
- Gap 7 - 'יצירה' (R5): rows 1 and 3 are 'בקרוב' stubs (create.tsx:62); row 2 opens a supporter-video form with no gift choice that cannot finish (owner-only cost approval, consent via live chat or an unbuilt form, FAL key); the effects library page is empty.
- Gap 8 - 'התומכות שלי' (R4) is not built: /supporters returns 404 on the live site and the profile shows 'רשימת התומכות המלאה בדרך (מחכה לאישור)'. The only supporter list is gift-ranked and empty without the listener.
- Gap 9 - no real live data can arrive (R7): events need an external listener with a key only an owner can mint (ingest-keys.functions.ts:4-7) and no owner role is assigned, so the likes meter, contest and energy engine react only to 'בדיקה' buttons. The contest's 'סרטון לזוכה' is never created, and the bar counts total likes while the contest counts the clock hour.
- Gap 10 - wall content (R6) is Tohar's: a new creator starts with no wall and no opening videos (the two uploads sit under stage/tohar.bell/opening), 'נגני מלפנים' shows nothing until an external program reads it, and Tohar's three existing walls will be orphaned once her handle is linked (wall.server.ts:14-18).
