# DECIDE: skeptic-evidence

claim_refuted: true
confidence: high

## VERDICT
REFUTED as stated. "Studio sends only the camera" is a setting plus a few forced flows, not a rule, and "must be a virtual camera" does not follow from it.

KNOWN (read directly: official page, installed 1.39.6 code, Studio's own logs on this PC)
- Co-host has three modes. "Camera only" (camera_only) draws the one selected camera and hides every other visible source. "Current scene" (canvas) draws the whole scene into the creator's slot, including Window Capture and Link sources; only widgets are hidden. "Share screen" is the third.
- Multi-guest: the host side is hard-coded to canvas, and the hide-other-sources step does not run. The claim is wrong for Multi-guest outright (code only; no multi-guest session in the logs).
- Match: the official help page (updated Nov 3, 2026) says matches are supported with "Current scene". In 1.39.6 the Match panel only requires "linked and no screen share".
- This PC already ran the claim's scenario. On 9 Nov (Studio 1.38.0) co-host and battles ran in canvas mode; during one battle the creator's slot was a Chrome window capture with the camera 100% covered. Same mode on 26 Oct.
- What is true in the claim: on the installed 1.39.6, quick pairing, quick match, sending a direct battle while not linked, and accepting an incoming direct battle all switch the layout to Camera only. The saved setting on this PC is Camera only now, and every 1.39.6 session in the logs (9 Nov evening, 12 Nov) used it.
- A working camera-type source is still mandatory to start a co-host and, outside the exempt topic, to go LIVE. A covered camera gives only a reminder.

INFERRED (not observed)
- On 1.39.6, a Match started while already linked in Current scene keeps the scene. Code has no forced switch on that path, and the official page and the 1.38.0 logs agree; no 1.39.6 log has a canvas co-host.
- The opponent and viewers receive what Studio draws in the slot (the RTC output is a crop of the canvas at the slot).
- The 1.38.0 to 1.39.6 change for quick pairing (canvas kept, then Camera only) comes from the new preparation function; 1.38.0 code is no longer on disk.

NOT VERIFIED
- Any phone-side picture of a canvas-mode battle, or of a real composed feed in either mode.
- Whether switching back to Current scene after a forced Camera-only link works live (the settings dialog does not block it).
- A vendor claim that browser overlays are stripped when a battle starts: search snippet only, absent from the fetched page. No creator testimony found for either side.

## EVIDENCE
- OFFICIAL. TikTok LIVE Studio Help, 'Game together with new co-host layouts' (https://www.tiktok.com/live/studio/help/article/Boost-viewer-engagement/Gaming-Co-host?lang=en), shown as updated Nov 3, 2026. FAQ on matches: "For now, only the \"Current scene\" setting supports LIVE matches." Paraphrased from the same page: Standard + Current scene lets viewers see both creators' cameras and game screens; step 1 is to go LIVE with a camera source; a third-party virtual camera may be used while co-hosting; the words 'Camera only' do not appear.
- CODE 1.39.6, C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\static\js\async\78977.cb7d771c.js (single-line file, character offsets). @3012882: the layout flow is chosen from layoutConfig.mode: camera_only -> class bw, canvas -> class bk, screen_share -> bO, live_like -> bP.
- Same file @2986940-2988100, class named VisualVisibleProcessor. With a camera layer it keeps only the selected camera and calls setVisible(false) on every other visible source, restoring them on unload. With a canvas layer it keeps every source whose type is in list bd: game, monitor, window, media, image, camera, analog, android, ios, browser, text, replay, restream. It returns early when the scene is not co-host.
- Same file @2971872 (LocalCanvasLayer.draw): all visuals of the current scene are scaled uniformly to cover the creator's slot. @2953649 (LocalCameraLayer): loads only camera_visual_id. @1972000 (getRTCVideoOutputConfig): the output rect is the self slot of the canvas.
- Same file @2298314 (multi-guest buildSdkMixStreamTransformContext): layoutConfig is hard-coded to mode canvas. @5618951: Studio's own tool messages name this a full-canvas co-host and refuse only widget sources there.
- Same file @2166182, function pu (quick preparation): requires a camera candidate, then sets layoutConfig to camera_only unless it already is. Callers: quick co-host port @2164273; battle port prepare @2200040 (direct_battle and quick_battle); incoming direct battle @2213023. canStartBattleTarget @~2206279 refuses when another host is already linked, so this port serves battles from idle only.
- Same file @1989137 (checkCameraSources): no working camera-type source and not linked -> error camera_not_available. @1972000 (getLayoutConfigStrategy): throws without a camera; default is canvas when visible cameras cover more than half the canvas, else camera_only. @2103534 (uY): the default is applied only when no layout is saved, so a saved Current scene is honoured for manual invites. @2726934 (checkCameraGoLiveRestrict): topic id 5 exempt; otherwise forbidden without a visible camera; heavy obstruction returns only a reminder.
- C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\static\js\async\89811.a716b8ba.js @~19700-20300: under the Standard layout the 'What to show' select has exactly two values, camera_only and canvas, with no feature-flag condition. @~11900-12950: only switching between Standard and Share screen is blocked while inviting or linked.
- C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\static\js\async\77918.d6ec54c0.js @566298: the Match panel is shown when co-host is linked or connecting and no screen share is active; there is no camera_only condition. @410355: an ordinary battle invitation is accepted with a plain request; only invite type 5 goes to acceptIncomingDirectBattle (which runs pu).
- LOCALE, C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\locales\Live_Studio\en.json. Lines 20024-20025 (keys ttlive_ls_cohostLayout_whatNewModal_title/_desc, wired in education_config.cohost at 78977 @1398073) announce showing your scene in co-host instead of just the camera. Lines 3401 (ls_cohost_new_desc3), 17518 (ttlive_joinScreen_livePage_noMatchToast) and 22669 (ttlive_ls_layout_cohost_cameraOnly_toast) have zero references in 1,536 scanned .js/.html/.json files outside locales. Line 3400 (ls_cohost_new_desc2, 'only the camera' wording) is still referenced at 77918 @3059250, but only in a reminder dialog whose button is 'Add camera'.
- LOGS, Studio 1.38.0, C:\Users\shk\AppData\Roaming\TikTok LIVE Studio\logs\LS-renderer.2026-11-09.25.log (GMT+2): line 1236 manual invitation accepted; line 1879 layout config mode canvas; lines 1964-1965 the canvas layer draws visuals named chrome.exe and Camera. LS-renderer.2026-11-09.24.log: line 238 layout pipeline with bizSource battle; line 262 mode still canvas; line 385 (04:13:20, during the battle) composition types rtc, window, camera: window about 26% of the canvas with displayProportion 0.985, camera overlap equal to its area (displayProportion 0).
- LOGS, Studio 1.38.0, LS-renderer.2026-11-09.18.log: line 2003 start_quick_pair; line 2646 mode canvas; lines 2689-2691 visuals Link, chrome.exe, Integrated Camera; line 2895 battle pipeline; line 2919 mode canvas. Same pattern in LS-renderer.2026-11-09.15.log (lines 306, 387-389, 611, 635) and in LS-renderer.2026-10-26.log (battle at 10:45:45 with mode canvas).
- LOGS, Studio 1.39.6, LS-renderer.2026-11-09.3.log: line 9 quick pair; line 467 mode camera_only; line 475 layout_camera_only load start. All 12 Nov sessions are camera_only (for example LS-renderer.2026-11-12.3.log). No 1.39.6 log contains a canvas co-host. Across all logs (3 Sep to 13 Nov): 34 co-host layout updates in canvas, 32 in camera_only. Versions were read from install paths inside the same log files.
- SAVED STATE, C:\Users\shk\AppData\Roaming\TikTok LIVE Studio\TTStore\services.json: CoHostContextService.state.layoutConfig is mode camera_only with camera id <id>; SourceService now holds 4 sources, all type camera. The 12 Nov test therefore could not show whether a window source is hidden. localStore.json has dynamicSettings.server_ab.enable_cohost_full_canvas = true, a key with 0 references in 1.39.6 code.
- OTHER PROGRAMMER'S NOTE, C:\My Web Sites\boostera-live-studio-web\docs\LIVE-VERIFICATION.md lines 15 and 27: the Studio side showed its virtual-camera image, and a camera-only co-host configuration error occurred before play. C:\Users\shk\Projects\boostera-live-studio-web\runtime\native-live-observations.jsonl (25 lines) and native-live-actions.jsonl (22 lines) contain 0 occurrences of camera, layout, canvas or visual. The note describes one Camera-only session with a camera-only scene; it does not test the claim.
- THIRD PARTY. A search snippet for tik.tools/guides/obs-tiktok-live-captions says browser-source overlays in LIVE Studio are removed when a battle starts and OBS Virtual Camera keeps them; the fetched page text did not contain it. Unverified, and consistent with the forced Camera only flows. No creator report was found showing overlays or window captures visible, or hidden, during LIVE Studio battles.

## PLAN IMPACT
1. Keep "program picture arrives as a camera device" as the primary route, but change the reason. On 1.39.6 the flows the phone app needs (quick match, send battle from idle, accept incoming direct battle) force Camera only, and Camera only hides every non-camera source. It is a robustness choice, not a Studio law.
2. Record a real no-install fallback: program page as Window Capture or Link source, plus any working camera source, plus Co-host > Settings > Standard > Current scene. It fits invite-first co-host followed by Match, and creators whose account is still locked out of virtual cameras. Limits: the whole scene is cover-cropped to the slot, widgets are hidden, quick/idle battle flows flip to Camera only, and a camera-type source must still exist (a server with no physical camera needs a camera device anyway).
3. The single full-canvas camera scene proposed in the maps stays the safest layout: it gives the same picture in both modes.
4. Phone panel relay: read and show coHostContext.layoutConfig.mode, and re-check it after every quick or idle battle, because Studio rewrites the saved setting to Camera only.
5. Correct the maps. en.json:3401 and en.json:17518 are unreferenced legacy strings and must not be cited as current behaviour. "A Window Capture is not enough" is true only in Camera only mode. "Match with Current scene not seen here" is outdated: the 9 Nov logs show it on 1.38.0.
6. Behaviour changed between 1.38.0 and 1.39.6 within one day on this PC. Pin or monitor the Studio version and repeat the decisive test after each update.
7. Before building the OBS + virtual-cable chain as a hard requirement, run the test below; it decides whether the fallback in point 2 is usable on 1.39.6.

## SMALLEST DECISIVE TEST
One two-account session on the installed 1.39.6, about 10 minutes (not run here: read-only task, live account).
1. Scene: the existing camera source plus a Window Capture or Link source showing a distinctive test card that covers the canvas.
2. Co-host > Settings > Standard > What to show = Current scene.
3. Invite the second owned account manually, accept on its phone, start a Match.
4. During the match, take one screenshot on the opponent's phone. This is the single settling observation.
   - Test card visible in the creator's half: the claim is false in practice on 1.39.6 and the Window Capture fallback is usable.
   - Only the camera visible, or the log shows the mode flipping to camera_only: the claim holds for Match on this version.
5. Cross-check in the newest LS-renderer log: the 'update layout config' line (mode value) and the '[linkmic_scene]: visual name' lines at link and at battle start.
Optional second run from idle (quick match, or accept an incoming direct battle): code predicts mode camera_only and the test card gone.
