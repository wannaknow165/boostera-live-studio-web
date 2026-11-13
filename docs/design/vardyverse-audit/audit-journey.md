# AUDIT: journey

# Vardyverse — new-creator journey on a phone (375 px), read from code

## 0. Scope, method and one thing that changed while I was reading

- **Commit A = what the owner saw tonight:** `9b6e056149441c03c8abd4d9a59edcef93259f68` (agent message completed 2026-11-12 20:37:53Z, the last completed one before the user message of 23:26:15Z). All unmarked citations are commit A.
- **Commit B = what is live now:** `3b7b681e1829ff9caae72916e755d0df702ddd17` ("Identity kit: photo upload, one-tap generation…", 23:33:57Z). The published site changed under me. My first GETs (~23:44Z) referenced `/assets/styles-BmtpLai9.css`; by 23:53Z the same pages referenced `styles-9H7OzL_K.css`, the old file returns 404, and the live chunks contain "צרי לי הכול", "צלמי עכשיו", "תתבקשי להיכנס שוב" and `/connect?first=1`. The Lovable agent's own report ends "nothing has been published", so someone published between ~23:44Z and 23:53Z. Worth confirming who.
- **What I re-read at B:** auth, connect, identity, profile, BrandKit, BuildChecklist, index, creator.functions, fx.functions, wall.server, identity.*. For set, stage-control, create, effects, stage and LivePreviewPane I only confirmed in the live JS chunks that the strings quoted below are still there.
- **Limits:** read-only. I did not sign in, register or submit anything (the owner's note also says "לא צריך הרשמה"). Signed-in screens are described from code. Phone layout is computed from the Tailwind classes, not seen in a browser. Line numbers are hand-counted (±2); each citation carries a snippet.
- Raw public HTML and chunks are in `C:\Users\shk\AppData\Local\Temp\claude\35e603d462edf4d8\544f0b39-3e01-488d-8ecd-246aa57399c4\scratchpad\pub` (first fetch) and `C:\Users\shk\AppData\Local\Temp\claude\35e603d462edf4d8\544f0b39-3e01-488d-8ecd-246aa57399c4\scratchpad\pub2` (second fetch).

## 1. Screen by screen (commit A unless marked B)

### `/` signed out
- **First thing she sees:** "TikTok LIVE · הזהות של טוהר", "טוהר בל · מלכת הפעמון", "כל מתנה מצלצלת בפעמון. התומכים שלה הם צבא הפעמונים 🔔🪽🎀" (`src/components/vardy/BrandKit.tsx` L39–41). Five hard-coded pictures follow (L2–6, L26–32), one column on a phone, each with a "הערה על התמונה…" input. That is roughly 1,900 px of Tohar before anything else.
- **Then:** "הסרטונים של טוהר" and "230 סרטונים" (live count at fetch; `src/routes/index.tsx` L143–144), and three auto-scrolling rows of 80 px thumbnails (L43).
- **"מה נייצר?":** four cards, all "בקרוב", plain divs that do nothing (L154–161). One reads "דמות צבא הפעמון — הדמות של טוהר נכנסת לסרטון" (L91).
- **Works:** thumbnail opens a player; ☆ and notes save to localStorage only; the floating orb.
- **Shown to every visitor:** × on every clip (L63–70) opens "להסיר את הסרטון מהגלריה?" with a "קוד בעלים" field.
- **Navigation:** none. The live HTML has 0 `<a>` tags, 1,386 buttons and 525 KB. There is no "כניסה" anywhere, so a new creator cannot find sign-in from the home page. `/guide`, `/capabilities` and `/battle` are not linked either.
- **Desktop habits:** rows are an `overflow-hidden` marquee, not swipeable, about 5 minutes per loop (L37–40). × and ☆ are 20 px targets (`h-5 w-5`, L67/L75).
- **Empty state:** exists, "עדיין אין סרטונים בתיקייה." (L148).

### `/` signed in
- Same page plus one card on top (`src/components/build/BuildChecklist.tsx`):
  - No handle: "בניית הלייב שלי / צעד ראשון: חברי את הטיקטוק." (L17–22).
  - With handle: "בניית הלייב שלי · 0/9", "המשיכי: הזהות", nine chips (L29–30).
- Still no nav, no sign-out, no name. Everything below is Tohar.
- **B:** adds "העלי תמונה וצרי את הזהות שלך ←". BrandKit switches to "הזהות שלך" only after at least one approved item. Un-approved slots still show Tohar's emblem, "סמל הקבוצה · Bell Army" and Tohar's character (`pickImage(mine.approved[…], it.src)`).

### `/auth` (the sign-up page the owner mentioned)
- **Sign-in:** h1 "כניסה", outline button "המשך עם Google", fields "אימייל" and "סיסמה" (min 8), primary "כניסה", link "אין לך חשבון? הרשמה".
- **Sign-up:** h1 "הרשמה", button "יצירת חשבון", link "יש לך חשבון? כניסה". Then "שלחנו לך מייל לאישור החשבון." if no session comes back (`src/routes/auth.tsx` L46–48, L54–66).
- **Fits 375 px:** yes (max-w-sm, 16 px inputs).
- **Sign-up is open to anyone:** a bare `supabase.auth.signUp`, no invite or allow-list in code. Whether e-mail confirmation and Google are enabled is a backend setting — not verified.
- **Closest to "one click, no registration":** the Google button; a first Google sign-in creates the account.
- **Problems:**
  - Errors are Supabase's raw English text in grey (`setMsg(r.error.message)` L47, `text-muted-foreground` L63).
  - A failed Google sign-in is ignored (L55). Likely inside WhatsApp or TikTok in-app browsers — not verified.
  - No "forgot password", no explanation of what this is, no link back.
- **Landing after sign-in:** `/connect` (L8); B: `/connect?first=1`.

### `/connect`
- **First thing she sees:** pills "לייב · יצירה · פרופיל", h1 "התחברי עם TikTok", "יציאה". Then the big button "התחברי עם TikTok", disabled once data loads (`disabled={data && !data.oauthReady}`, `src/routes/_authenticated/connect.tsx` L105), with "החיבור הישיר יופעל ברגע שפרטי האפליקציה של טיקטוק יוזנו." (L106).
- **QR:** none on a phone (`matchMedia("(min-width: 768px) and (pointer: fine)")`, L58).
- **Manual path:** "או הזיני שם משתמש ידנית", `@username`, "שמירה".
- **After saving (A):** only `invalidateQueries` (L72). A small text card appears: "@handle · מחוברת · הוזן ידנית" (L90–98). No picture, no success line, no next button. Dead end.
- **After saving (B):** `navigate({ to: "/identity" })` (L79).
- **A and B:** the biggest control on her first screen is a disabled button; the only working path is labelled "או…".

### `/identity`
- **A, first thing on a phone:** the "תצוגה חיה" card, because the grid stacks it first (`src/routes/_authenticated/identity.tsx` L31–32). It is an empty 300×533 frame: "אין עדיין קישור במה במכשיר הזה. צרי קישור או הדביקי אותו למטה.", with "הדליקי מצלמה" and "מסך מלא" (about 670 px tall).
- **A, below it:** "הזהות שלי", then "ערכת הזהות (יצירה מהתמונה שלך ואישור) עוד בבנייה. בינתיים הלייב משתמש בזהות הקיימת:" and three pictures of Tohar labelled "תמונת פרופיל / הסמל / דמות הקרב" (L8–10, L35–38).
- **A, buttons:** "הזהות הזו מתאימה לי ✓" (L42) ticks step 1 on Tohar's identity. With no handle the server throws "חברי קודם את חשבון הטיקטוק" and nothing shows. "לשלב הבא" goes on. No upload, nothing of hers.
- **B:** a real kit, see section 2.

### `/profile`
- **Cards:**
  - "חיבור TikTok".
  - "הזהות שלי — הפריטים שהעלית או אישרת. יצירת פריטים חדשים נמצאת ב"יצירה"." with nothing shown. /create has no identity creation either, so it is circular (`src/routes/_authenticated/profile.tsx` L61–65).
  - "התומכות שלי — רשימת התומכות המלאה בדרך (מחכה לאישור)…" (L67–71).
  - "הרשתות שלי".
  - "הגדרות" with "התנתקי".
- **Possible silent loss:** `saveSocials` is a bare UPDATE, so "נשמר" may show with nothing stored before an account row exists — not verified.
- **Fits 375 px:** yes.
- **B:** shows approved items, or "עוד לא אישרת פריטים. העלי תמונה ותני למערכת ליצור לך הכול." with "צרי את הזהות שלי".

### `/set` (the 9-step wizard)
- **No handle:** bare "בניית הלייב שלי / כדי להתחיל צריך קודם לחבר את חשבון הטיקטוק." and a button, no nav (`src/routes/_authenticated/set.tsx` L94–100).
- **With handle:** nav, "@handle · 0/9 צעדים", "שליטה בבמה", nine scrolling chips. Then the same ~670 px empty "תצוגה חיה" card before the step (L125–126), so the step itself starts below the first screen.
- **Phone blocker (computed):** the fixed bar (L208–216) puts "המשיכי" left-most in RTL, about x 12–89 px and 12–48 px from the bottom. The orb is `fixed bottom-[max(1rem,…)] left-4 z-40` (`src/components/manager/ManagerDock.tsx` L67–71), about x 16–136 px and 16–70 px from the bottom, which matches the project screenshot. The bar has no z-index, so the orb covers "המשיכי" and most of "דלגי". On desktop the bar is centred and does not collide.
- **Feedback off-screen:** `msg` renders above the grid (L123). "נשמר ✓", "הקיר נבחר ✓", "יוצרת 3 הצעות… זה לוקח כדקה" and "היצירה לא הצליחה, נסי שוב מאוחר יותר" appear about 700 px above the tapped button.

| Step | What she sees | What breaks |
|---|---|---|
| 1 הזהות | "השם, הסמל, הצבעים ודמות הקרב שלך — …" and "פתחי את הזהות שלי" (L130–135) | In A it leads to the Tohar placeholder |
| 2 הקיר | "קיר הזהב / ענן ורוד / זירה"; "אין עוד הצעות בסגנון הזה. [צרי]"; real button "צרי 3 הצעות חדשות · קיר הזהב" (L285–290), ~1 min | "צרי" goes to /create, which answers "קירות נוצרים בשלב הקיר — …": a loop (L273). Cap of 3 a day is counted before the call (`src/lib/stage/wall.server.ts` L25–27), so failures burn attempts |
| 3 הפרונט | "הספרייה עוד ריקה — אחרי ייבוא האפקטים…" (L103; library content not verified); "קטלוג המתנות עוד לא יובא — …"; five tier rows with "— בלי אפקט —" and "צרי"; colours preset to Tohar's pink and gold | Gift rows use fixed widths (L242–250), squeezing the select to ~30 px. Every "צרי" leads to /create, where nothing for gifts can be made |
| 4 המכפילים | "הכרטיס שעולה כשמכפיל נכנס לקרב." | Same "צרי" dead end |
| 5 הקרב | Four rows with a 160 px label (L172); "מצב זירה בקרב — …" | Tight but usable |
| 6 האתגרים | "אין אתגר פעיל (חוק 4 הדקות שומר על קצב)." and default "ספר המשחק" rows | — |
| 7 התומכות והסרטונים | "תור סרטונים לקיר"; "התור ריק." | The "גלריה" group is Tohar's Drive videos |
| 8 בדיקה | "מימין: הקיר האמיתי שלך…" (L300); "לייק בדיקה ❤️ / מתנת בדיקה 🎁 / תגובת בדיקה 💬 / סיום בדיקה"; "עוד לא נבחרו אפקטים." | Nothing is "on the right" on a phone. Buttons work, but the confirmation and the reacting stage are off-screen at the top |
| 9 עולה ללייב | "עוד אין קישור."; "צרי קישור"; "שמרי אותו עכשיו — הוא לא יוצג שוב."; "איך טוענים"; "עוד לא התקבלו אירועים מהמאזין. …" | The link is kept only in this device's localStorage. "איך טוענים" is TikTok LIVE Studio / OBS, a computer task (L337–345) |

### `/stage-control`
- **No handle:** one bare line, "קודם צריך לחבר חשבון טיקטוק בעמוד ההתחברות.", with no nav and no link (`src/routes/_authenticated/stage-control.tsx` L53). Dead end.
- **With handle:** the empty preview first (L59–60), then "שליטה בבמה · @handle" and about 14 cards.
- **Empty states (all present):** "אין לייב פעיל. המתנות יופיעו כאן ברגע שהמאזין יעביר אותן.", "אין עדיין סרטונים.", "אין סרטוני פתיחה.", "עוד אין רמיקסים.", "עוד אין קישור. צרי אחד והוסיפי אותו כמקור דפדפן מאחורייך.", "אין לייב פעיל כרגע.", "התור ריק.", "עוד אין אירועים."
- **Disabled until a live exists:** "סיום", "התחילי הצבעה", "נגני פתיחה".
- **Works:** "צרי קישור" with "העתיקי" and "פתחי"; "צרי 3 הצעות · קיר הזהב"; switches; test buttons; uploads.
- **Tohar content:** the "סרטון רקע" picker lists Tohar's videos (`src/lib/stage.functions.ts` L35).
- **Phone:** messages render at the top (L63). Rows with 4–5 buttons leave about 10 px for the label once data exists (`EnergyControl.tsx` ~L99–106, `OpeningControl.tsx`).

### `/create`
- **Cards (not buttons):** "תמונה / סרטון + תיאור ← סרטון" [בקרוב], "מתנות ותומכת" [פתוח למטה ↓], "מחיקת האדם" [בקרוב] (`src/routes/_authenticated/create.tsx` L27–31, L62).
- **Below is only "סרטון לתומכת — לפני הלייב":**
  - Without a handle: "קודם מחברים חשבון טיקטוק בפרופיל." with no link (`SupporterPanels.tsx` ~L95).
  - With a handle: the template grid is Tohar's videos, and a non-owner ends at "הסרטון יחכה לאישור עלות מהבעלים.".
- Nothing for gifts despite "פתוח למטה".

### `/effects`
- **Empty state:** "הספרייה עוד ריקה. בעלת המערכת מייבאת את האפקטים בעמוד הייבוא." (`effects.index.tsx` ~L60).
- **Phone:** the preview is `md:grid-cols-[1fr_300px]` (~L61), so it sits after the whole list. Tapping an effect shows nothing on screen.
- ★ without a handle throws server-side with no message.
- `/effects/import` answers a non-owner with "רק בעלת המערכת יכולה לייבא".

### The floating orb "מה לעשות היום?" (every screen, including /auth)
- Opening it immediately runs an LLM briefing. `getTodayBriefing` has no auth middleware (`src/lib/brain.functions.ts`), so any anonymous visitor can trigger it.
- It is keyed to a random id in the browser (`src/hooks/useVardySession.ts`), not to her account.
- A new browser gets "זירת הדגמה · עוד לא חוברו נתוני הקרבות שלך".
- "לייצר את הקליפ" and "🎬 שלחי למנוע הווידאו" navigate to `/` (`ManagerDock.tsx` L58–62), where no engine is mounted. Nothing happens.

## 2. What the live build (B) adds on `/identity`

- **Header:** "1 חיברת את החשבון ✓ · 2 העלי תמונה · 3 צרי את הזהות שלך".
- **Photo:** "צלמי עכשיו" (front camera, `capture: "user"`, ~L169) and "בחרי מהגלריה"; then "מעלה…", "מוכן ✓" or "ההעלאה נכשלה. נסי שוב".
- **Form:** "הפרטים שלך (כבר מולא — אפשר לדלג)".
- **One tap:** sticky "צרי לי הכול" with "10 תמונות · בערך 7 דק׳ · נשארו לך היום 30 מתוך 30".
- **Five cards:** "תמונת פרופיל / הסמל שלך / סמל הקבוצה / דמות הקרב / 6 פרצופים", each with "צרי" and "להעלות משלי", then "אשרי".
- The "תצוגה חיה" pane is gone from this page.

**Risks I see in the code:**
- The 10-image run is driven from the browser one call at a time (`identity.tsx` L57–64), with no wake lock and no resume. A phone that auto-locks during the ~7 minutes loses the in-flight image.
- The daily cap is taken before each call (`src/lib/identity/images.server.ts`), so failures cost quota.
- "צרי" / "עוד אחד" has no try/finally (~L213). A network error leaves the tile on "יוצרת…" until reload.
- Ten separate "אשרי" taps; no approve-all.
- The left footer button "לבניית הלייב" is partly under the orb.

**The agent's own "not tested" list:** the full 10-image run, a real phone camera, "להעלות משלי", the home brand kit, a wall made from her emblem.

## 3. Tohar's fixed content reaching a different creator

- **Home:** BrandKit, "הסרטונים של טוהר", page title (`index.tsx` L21). In B, the Tohar fallbacks under "הזהות שלך".
- **Stage default wall, and so every "תצוגה חיה":** `creator === "tohar.bell" ? emblem : crest` (`src/components/stage/StageView.tsx` L42). Everyone else gets the Bell Army crest.
- **Wall generation reference:** the same crest (`wall.server.ts` L30 in A; in B only when she has no approved emblem).
- **Wall prompt:** the "ענן ורוד" style asks for "small floating golden bells" (`src/lib/stage/rules.ts` ~L81).
- **Live-node export:** `emblem_url` is always `tohar-emblem.png` (`src/routes/api/public/sets/active.ts` L2, L16).
- **Video library:** Tohar's Drive videos in the "סרטון רקע" picker, the "גלריה" queue group, and the supporter-video templates (`supporter-jobs.functions.ts`, `getSupporterStudio`).
- **Stage texts and colours:** "הלייב הבא בקרוב 🔔", "🔔✨ היעד הושג!", and "(Tohar: pink + gold…)" in `src/styles.css`.

## 4. Desktop-only assumptions

- The QR `matchMedia` gate.
- Preview pane first in `md:grid-cols-[320px_1fr(_280px)]`, with a 1080×1920 iframe scaled in (`LivePreviewPane.tsx` L99, L117) that polls every 2 s.
- Feedback at the page top.
- "מימין:" wording in step 8.
- OBS instructions in step 9.
- Fixed pixel widths in gift and battle rows.
- Effect preview after the list.
- Marquee without swipe; 20 px targets.
- `text-sm` selects, which make iOS zoom on focus.
- **Not found:** tables, or hover-only functions. Hover is cosmetic.
- **Probable bug, by reading:** "הדליקי מצלמה" likely draws nothing. `setState("on")` is followed at once by `canvas.current!` (`LivePreviewPane.tsx` L42–43), while the canvas only renders when the state is "on" (L76).

## 5. Three direct answers

**(1) What made the owner say "there is nothing in it"?**
- He landed on /connect: a disabled TikTok button, a QR that reopens the same page, and a small handle field.
- Saving the handle produced one text card and no next step.
- "הזהות שלי" said "עוד בבנייה" and showed three pictures of Tohar with "הזהות הזו מתאימה לי ✓".
- /profile listed nothing. /create was two "בקרוב" cards plus a supporter-video form built on Tohar's videos.
- /set opened at 0/9 on an empty "תצוגה חיה" box. /stage-control was about 14 empty cards.
- The home page is entirely Tohar.
- Nowhere could he upload a photo or see anything carrying his face or name.

**(2) Where can he "scan with his phone", and what happens?**
- Only the QR on /connect, and only on a computer (L107–112).
- It encodes plain `origin + "/connect"` (L57), with no pairing.
- The phone is not signed in, so `/_authenticated/route.tsx` L8 sends him to `/auth?redirect=/connect`. He signs in again and gets the same page without a QR. Nothing is created.
- **B:** the caption is honest ("סרקי כדי לפתוח את הדף הזה בטלפון. תתבקשי להיכנס שוב."). But he still lands on /connect without `first=1`, so if the handle is already saved nothing forwards him.
- **The real scan in B:** /identity, "צלמי עכשיו" (selfie).
- The camera in "תצוגה חיה" records nothing by design ("שום דבר לא מוקלט או נשלח") and probably does not draw.

**(3) Shortest path today to something generated for him, and where it breaks**
- **Live now (B):** type `/auth` by hand → "המשך עם Google" → /connect → @handle → "שמירה" → /identity → "צלמי עכשיו" → "צרי" on "תמונת פרופיל" (~40 s) or "צרי לי הכול" (~7 min) → "אשרי".
- **Even shorter:** "צרי" on "הסמל שלך", which needs no photo.
- **Where it breaks:**
  - No sign-in link on the home page.
  - Handle already taken: "שם המשתמש כבר מחובר ליוצרת אחרת.".
  - Phone lock during the run; quota charged on failures.
  - Results show only on /profile and the home kit, mixed with Tohar's.
  - The stage and the export still show Tohar's crest and emblem.
  - Never run on a real phone.
- **Tonight (A):** the only generation was a wall (step 2), and it came out with the Bell Army crest.

## 6. Prioritised fixes for the first ten minutes (most painful first)

1. **A way in, and a home that is hers.** Add "כניסה / הצטרפי" and a signed-in header to the home page. `src/routes/index.tsx`, `src/components/build/CreatorNav.tsx`.
2. **Orb off the bottom buttons on phones.** Raise or hide it where a fixed bar exists; give the bar a z-index and safe-area padding. `src/components/manager/ManagerDock.tsx` L67–71, `src/routes/_authenticated/set.tsx` L208.
3. **/connect first screen.** While TikTok keys are missing, make the handle field the primary action. Add "המשיכי" under the account card. Point the QR at `/identity` and keep the query through sign-in. `src/routes/_authenticated/connect.tsx` L58, L112–126; `src/routes/_authenticated/route.tsx` L8.
4. **Identity run that survives a phone.** Wake lock, resume after lock or reload, try/finally, "אשרי הכול", and charge the cap only on success. `src/routes/_authenticated/identity.tsx` L50–64, L213; `src/lib/identity/images.server.ts`.
5. **Take Tohar out of other creators' output.** `src/components/vardy/BrandKit.tsx` (no fixed fallback under "הזהות שלך"), `src/components/stage/StageView.tsx` L42, `src/lib/stage/state.server.ts`, `src/lib/stage/wall.server.ts`, `src/routes/api/public/sets/active.ts` L16, `src/lib/stage/rules.ts` ~L81, `src/lib/stage.functions.ts` L35, `src/lib/supporter-jobs.functions.ts`.
6. **Preview pane on phones.** Collapse it or move it after the content, and fix the canvas ref. `set.tsx` L125–126, `stage-control.tsx` L59–60, `src/components/stage/LivePreviewPane.tsx` L42–43, L76.
7. **Feedback where she tapped.** Toasts; Hebrew errors and Google error handling on /auth. `set.tsx` L123, `stage-control.tsx` L63, `src/routes/auth.tsx` L47, L55, L63.
8. **Dead ends without a handle.** `stage-control.tsx` L53, `set.tsx` L94–100, `src/components/supporters/SupporterPanels.tsx` ~L95, `src/components/build/SocialsEditor.tsx`.
9. **Honest /create and "צרי" pills.** `src/routes/_authenticated/create.tsx` L27–31, L62; `set.tsx` L149, L163, L174, L237, L249, L273.
10. **Wizard rows and wording for phones.** `set.tsx` L242–250, L300, L198–205, L337–345.
11. **Wall quota and false ✓.** `wall.server.ts` L25–27; `src/lib/fx.functions.ts` (`wallPicked: !!st.data`).
12. **Home gallery on a phone.** Swipeable rows, hide × and ☆ from non-owners, lighter DOM. `index.tsx` L37–86.
13. **Orb.** Tie it to the account, require sign-in for LLM calls, remove the dead "send to video engine". `ManagerDock.tsx` L58–62, `src/hooks/useVardySession.ts`, `src/lib/brain.functions.ts`.
14. **Guard open sign-up before inviting more creators.** `src/routes/auth.tsx` plus a server-side allow-list.

## 7. Not verified

- Any signed-in screen in a real browser or on a real phone.
- Whether Google sign-in and e-mail confirmation are enabled.
- Whether the effects library and gift catalog are empty in production.
- Whose data the "demo arena" is.
- Database policies for the new kit tables.
- Who published the new build.
- Whether the image gateway works for the owner's own account.

## TOP FINDINGS
- The published site was redeployed while I was auditing (between ~23:44Z and 23:53Z on 12 Nov): it now serves the identity-kit build 3b7b681 (live chunks contain "צרי לי הכול", "צלמי עכשיו", `/connect?first=1`), although the Lovable agent's report ends "nothing has been published". Confirm who published. The owner's reaction was to commit 9b6e056.
- Tonight (9b6e056) "הזהות שלי" was a placeholder: "ערכת הזהות … עוד בבנייה. בינתיים הלייב משתמש בזהות הקיימת:" plus three pictures of Tohar and a button "הזהות הזו מתאימה לי ✓" (identity.tsx L8–10, L35–42). There was no photo upload anywhere, and the only thing a non-owner could generate was a wall embossed with Tohar's Bell Army crest (wall.server.ts L30).
- The only "scan" is the QR on /connect, shown only on a computer (connect.tsx L58) and encoding a plain link to /connect. On the phone he must sign in again and gets the same page; nothing is created. In the live build it still lands on /connect, not /identity, when the handle is already saved, because `first=1` is lost through the sign-in redirect (route.tsx L8). The real phone scan is now "צלמי עכשיו" on /identity.
- The public home page has zero links (live HTML: 0 anchors, 1,386 buttons, 525 KB), so there is no sign-in entry. Signed in, it is still entirely Tohar ("טוהר בל · מלכת הפעמון", "הסרטונים של טוהר", 230 videos, four "בקרוב" cards) with no navigation.
- Phone blocker in the 9-step wizard (computed from classes, not screen-tested): the floating "מה לעשות היום?" orb (fixed, left-4, z-40) sits on top of the fixed bottom bar's "המשיכי" and most of "דלגי" (set.tsx L208–216; ManagerDock.tsx L67–71).
- On phones the empty "תצוגה חיה" box (300×533, "אין עדיין קישור במה במכשיר הזה…") is stacked before the content on /set and /stage-control (and on /identity tonight), so the first screen is an empty frame. Feedback such as "נשמר ✓" or "היצירה לא הצליחה…" renders about 700 px above the tapped button (set.tsx L123–126; stage-control.tsx L59–63).
- First-screen dead ends tonight: after "שמירה" on /connect nothing happened except a small "@handle · מחוברת · הוזן ידנית" card (connect.tsx L72); the live build now forwards to /identity. Still live: /stage-control without a handle is one bare line with no link (L53); /create is two "בקרוב" cards plus "פתוח למטה ↓" with nothing for gifts; every "צרי" pill in the wizard leads there; the wall "צרי" link loops back to the wall step.
- Tohar's content still reaches other creators in the live build: the stage default wall and every preview use the Bell Army crest for anyone who is not tohar.bell (StageView.tsx L42); the live-node export always sends tohar-emblem.png (sets/active.ts L16); Tohar's Drive videos fill the background, queue and template pickers; and the home BrandKit shows Tohar's emblem, crest and character under the heading "הזהות שלך" for slots she has not approved.
- Live identity kit risks on a phone: the 10-image run (~7 min) is driven from the browser with no wake lock or resume; the daily cap is charged before each generation; "צרי" / "עוד אחד" can stick on "יוצרת…" after a network error; ten separate "אשרי" taps. By the agent's own report, the full run, a real phone camera, "להעלות משלי", the home kit and a wall from her emblem were not tested.
- The sign-up page is open to anyone (plain supabase.auth.signUp, no invite or allow-list; auth.tsx L46) and "המשך עם Google" is the one-tap path. Errors are raw English in grey and a failed Google sign-in is ignored. The orb's LLM briefing can be triggered without signing in (brain.functions.ts has no auth). I did not sign in or register; whether Google and e-mail confirmation are enabled is not verified.
- By code reading, "הדליקי מצלמה" in the preview pane likely never draws: the canvas ref is read right after setState("on") while the canvas only renders in that state (LivePreviewPane.tsx L42–43, L76). The pane is also preview-only by design ("שום דבר לא מוקלט או נשלח").
