# MAP: studio-camera-rule

# How TikTok LIVE Studio 1.39.6 composes the creator's picture in Co-host / Multi-guest / Match

## 1. Answer and confidence

- **It is a Studio-side setting, not a fixed rule.** In Co-host (and therefore Match) the creator's slot shows one of:
  - **"Camera only"** (internal mode `camera_only`): one designated camera-type source and nothing else.
  - **"Current scene"** (internal mode `canvas`): the whole current scene with every visible source, scaled to cover the slot and cropped.
  - **"Share screen"** (internal mode `screen_share`): a camera plus one capture source. Match is not available in this layout.
- **There is a setting for which camera.** Co-host > Settings > "Camera source". It is stored as `layoutConfig.camera_visual_id`.
- **A Window Capture source cannot be the co-host camera.** Only sources of type `camera` are candidates.
- **A virtual camera can be the co-host camera**, provided the account is allowed to use virtual cameras.
- **Confidence: high** for the rule set. It rests on the official help page, the packaged code, this PC's saved Studio config, and Studio's own logs of the 12 Nov real co-host and battles.
- **Confidence: medium** that Match also runs with "Current scene". The official page says so; I did not see it tested here.
- **Not verified:** that phone viewers or the opponent ever saw a real composed picture. On 12 Nov they saw only a virtual-camera placeholder.

## 2. The rule, as best established

Sources: (B) packaged code under `C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\` (unpacked, no asar; `package.json` says version 1.39.6, branch `studio/release/1.39`), and (A) the official help page. Bundles are single-line minified files, so positions are approximate character offsets.

1. **Modes.** `layoutConfig.mode` is one of `camera_only`, `canvas`, `screen_share`, `live_like`. The dialog "Co-host with other creators" offers Layout = Standard or Share screen. Under Standard, "What to show" = Camera only or Current scene. The "Camera source" dropdown is rendered only when the scene has two or more camera sources. (`static\js\async\89811.a716b8ba.js`, offsets ~9,300–13,200 and ~20,500–21,200.)
2. **Camera candidates.** Sources in the current program scene with type `camera`, excluding any whose `stateData.state` or `bizState` is false. Share-screen candidates are visible sources of type game, monitor, window, android, ios, or capture card. (`static\js\async\78977.cb7d771c.js`: `getScreenShareVisualCandidates` ~1,971,490; cast list ~1,940,735; `getExceptionIds` ~2,429,206; type enum ~1,522,999.)
3. **`camera_only`.** `LocalCameraLayer` (~2,953,553) loads the source named by `camera_visual_id`, forces it visible, locks it, resets its theme, and fits it to the slot with cover and centre crop (`Sv`/`SL` ~2,948,963; `coverClip` in `static\js\97762.d1ac5c44.js`). Other sources stay on the canvas but are not shown (locale key `ttlive_ls_layout_cohost_cameraOnly_toast`).
4. **`canvas`.** `LocalCanvasLayer` (~2,971,740) scales all visible scene sources uniformly to cover the slot and crops the overflow. Widget sources are disabled in this mode: alert, goal, chatbox, countdown, leaderboard, ranking sticker, interactive counter. Link/browser sources are in the general group, not the widget group.
5. **Validity.** `validateLayoutConfig` (~1,951,029) re-runs on scene, source, or orientation change. If `camera_only` points at a camera that is not among the candidates and no link is active, the config is reset to null and Studio raises the toast behind key `ttlive_ls_cohostLayout_noCamToast`.
6. **Default when nothing is configured.** `getLayoutConfigStrategy` (~1,972,000): with no camera candidate it throws. With no capture source, it picks `canvas` if cameras cover more than half the visible canvas, otherwise `camera_only` with the first camera. With a capture source present, it picks `screen_share` or `canvas`.
7. **A camera is mandatory to connect.** With no camera candidate and no active link, Studio returns `camera_not_available` / stage `camera_required` (`checkCameraSources` ~1,989,300; `uz` ~2,102,255).
8. **Forced camera-only paths.** Quick pairing, quick match, a direct battle started while not linked, and accepting an incoming battle while not linked all go through one preparation function (`pu` ~2,166,183; battle port ~2,200,040; incoming ~2,213,000). It switches the layout to `camera_only` unless it already is, and fails if the selected camera is unavailable.
9. **Camera-only versus current scene is local to Studio.** The protocol enum `CohostLayoutMode` has only NORMAL and SCREEN_SHARE (~404,407).
10. **What the opponent receives.** A crop of Studio's canvas at the creator's slot (`getRTCVideoOutputConfig` ~1,973,400), so whatever Studio draws in the slot is what the opponent and viewers get.
11. **Multi-guest.** The host side always uses `canvas`, or `live_like` for the game layout (~2,298,295; ~2,284,350). A camera is still required (key `ls_multi_manageModal_addCameraModal_desc`).
12. **Go-live camera requirement.** For non-gaming topics, `checkCameraGoLiveRestrict` (~2,727,200) forbids going LIVE without a visible camera source and warns when the camera is heavily covered. While live, the last camera cannot be hidden or deleted (keys `ttlive_ls_nonGameLiveCam_*`).
13. **Virtual-camera policy.** A device counts as virtual unless its name is on a server list of physical cameras, or its device path contains `\usb#` or `\pci#` (~2,807,370; ~1,495,563). A virtual camera is blocked when the server threshold check says not allowed, or the account is on the `source_deny_virtual_camera` list (~1,280,700; ~2,566,950; ~2,736,500). A blocked camera gets `bizState` false, so it also stops being a co-host candidate. The UI text (keys `ttlive_ls_restrictSensitiveFeatures_virtualCam_*`) says new users must go LIVE on LIVE Studio N more times, 25 minutes each; mobile LIVEs do not count; validation can take 48 hours. N comes from the server.
14. **Match effects attach to the camera source** (`getCameraToShowFaceGift` ~2,803,181).
15. **During co-host** scenes cannot be switched and some sources cannot be added (keys `ls_cohost_scene_toast`, `ttlive_chmg_cannotAddSources_toast`).

Search terms: "cohost camera", "cameraOnly", "co_host_camera" and "linkmic camera" have 0 hits. `camera_only` has 110 hits in 30 files; `camera_visual_id` 41 in 6; `currLinkMicHostCamera` 42 in 10.

## 3. Evidence A: web

- **Official, updated 3 Nov 2026:** TikTok LIVE Studio Help, "Game together with new co-host layouts", https://www.tiktok.com/live/studio/help/article/Boost-viewer-engagement/Gaming-Co-host?lang=en
  - Start the LIVE with a camera source, then open Co-host.
  - Standard + Current scene lets viewers see both creators' cameras and game screens.
  - Share screen is for up to four creators.
  - The FAQ says a third-party virtual camera can be used while co-hosting.
  - On matches the page says: "For now, only the "Current scene" setting supports LIVE matches." (as returned by the page fetch).
- **Official, updated 10 Nov 2026:** "Add a camera source…" says to keep the camera resolution at or below the LIVE quality and to use 30 FPS for better effect performance. "Add a capture source…" lists game, display, and window capture. Neither mentions the virtual-camera lock.
- **Official FAQ, updated 19 Aug 2026:** only the trial rule (25 minutes, twice in the first week).
- **Third party:**
  - help.castmonkey.com, "How to setup OBS Virtual Camera with TikTok LIVE Studio" (23 Feb 2026) and livecade.io/docs/connect-to-live-studio (1 Aug 2026) both recommend OBS Virtual Camera as a Camera source at 1080x1920.
  - toktutorials.com co-host guide (Nov 2025) and auragabriel.com (14 Nov 2025): no scene switching during co-host.
  - katsbits.com (1 Sep 2024; 1 Jan 2026): a camera source is required to go live.
  - obsproject.com thread 193605 (Jan 2026): OBS Virtual Camera shown as "not available" in LIVE Studio, no fix.
- **Conflicts:**
  - Studio's own older string (key `ttlive_joinScreen_livePage_noMatchToast`) says Match needs camera only; the official page says Current scene. Both are the Standard layout; only Share screen is excluded. The 12 Nov battles ran in `camera_only`.
  - The unlock count for virtual cameras is 7 in the string key name, and 3 or 1 in TikTok "discover" page titles and community posts.

## 4. Evidence B: this PC's Studio state and logs

- **Saved scenes** (`C:\Users\shk\AppData\Roaming\TikTok LIVE Studio\TTStore\services.json`, `SourceService.state`). Every source in every scene is type `camera`. There are no window, browser, or image sources.
  - "Default" (dual): two cameras on "Integrated Camera", 1280x720@30.
  - "Full-screen camera" (vertical, current): one camera on "Animaze Virtual Camera", 1280x720@30.
  - "Full-screen camera" (horizontal): one camera on "OBS Virtual Camera", 1080x1920@30.
- **Saved co-host setting** (`CoHostContextService.state.layoutConfig`): mode `camera_only`, `camera_visual_id` = the Animaze camera source.
- **Stream setting:** 1080x1920, 60 fps, 7000 kbps.
- **Account policy:** `sensitiveRestrictionEnabled` has enable false; `sourceAccessControl` has an empty blacklist. `LS-renderer.2026-11-12.9.log` (01:19 local) records the threshold check as allowed. Virtual cameras are unlocked for this account.
- **Real co-host and battles, 12 Nov** (`...\logs\LS-renderer.2026-11-12.2.log`; Studio logs are GMT+2, bridge logs are UTC):
  - Line 485: layout mode `camera_only`, one camera visual, zero capture visuals.
  - Lines 1179–1180: self slot at x 0, y 0.245, width 0.497333, height 0.51 of a 1080x1920 canvas. Output rect 536x978 px at 30 fps, bitrate 3000 with minimum 1500.
  - Layout key `cohost_normal_expand_2` throughout.
  - Each battle round (21:39:25, 21:41:02, 21:42:43, 21:43:07, 21:44:09, 21:48:36, 21:49:56) logs a "battle" layout pipeline with the same key and stays in `camera_only` (`.1.log` lines 75–76, 236–237, 457–458; `.log` lines 376–377, 640–641).
  - The opponent's stream arrived as 720x1280.
- **Cached server config** (`...\TTStore\localStore.json`, `dynamicSettings`): the co-host preset is 30 fps at every tier with bitrates of 5000/4000/3000/2700/2200/1800 kbps; `enable_non_game_camera_restrict` is true.
- **Built-in tools.** Studio registers 150 agent tools at start (`LS-renderer.2026-11-12.4.log` line 3229), including `coHost.configureCoHostLayout`, `coHost.getCoHostInfo`, `camera.getObsVirtualCameraPermission`, and `source.getSensitiveCaptureSourcePermission`. I did not call any of them.

## 5. Evidence C: the other programmer's observation

- `C:\My Web Sites\boostera-live-studio-web\docs\LIVE-VERIFICATION.md` line 27 records a camera-only configuration error before successful play: the scene had an Animaze camera but the selected co-host camera was null. Line 15 says the Studio side showed its virtual-camera image.
- **The fields behind it are not found in anything persisted.**
  - `C:\Users\shk\Projects\boostera-live-studio-web\runtime\native-live-observations.jsonl` (25 lines) and `native-live-actions.jsonl` (22 lines) carry only health, room, battle, linked, operations, controls, and scopes.
  - `src\*.mjs` in both copies has zero matches for camera, layout, or linkmic.
  - `server.mjs` lines 37–47 read only `interactionConnection.*`, `coHostContext.invitePanelState`, `coHostContext.battleStatus`, `coHostContext.linkedUsers`, and `user.*`.
- **Matching Studio fields, by code:** `coHostContext.layoutConfig`, `coHostContext.screenShareCtx` (`cameraVisuals` and the resolved `cameraVisual`), and `source.currLinkMicHostCamera`.
- **Plausible cause (not verified):** rule 5 above. A `camera_visual_id` that no longer resolves in the current scene gives a null selected camera and the toast.
- **Why the opponent saw a placeholder:** the Animaze application is not installed here; only its camera driver is.

## 6. What exists on this PC (nothing launched)

- **DirectShow video devices:**
  - Integrated Camera (USB, physical), plus an Integrated IR Camera in PnP.
  - Animaze Virtual Camera (driver 2.3.0.63 by e2eSoft).
  - OBS Virtual Camera.
  - WarudoCam, four instances.
  - DuoPlus Test Camera.
  - ByteCast VirtualCamera 1–4 (Studio's own; Studio hides them).
  - Studio's log also once listed a phone exposed as a Windows Virtual Camera (owner name masked).
- **OBS Studio 32.2.2** is installed at `C:\Program Files\obs-studio` with the virtual-camera modules, obs-websocket, and obs-browser. It is not running.
- **Other software:** DroidCam OBS Plugin 2.5.0, NDI 6 Runtime 6.3.2.0, and Warudo are installed.
- **Animaze:** driver only; no application found.
- **Audio:** no virtual audio cable (no VB-CABLE or Voicemeeter). Present endpoints are two microphones and two headset speaker endpoints. Virtual audio drivers exist (NVIDIA Virtual Audio, a "Voice Changer" device, Boom Audio) but none has a present endpoint.
- **Running:** TikTok LIVE Studio, Chrome, node.

## 7. What our system must provide to Studio

- **A camera-type video device that carries the finished program picture** (creator cutout, cloud wall, effects). A Window Capture of the program page is not enough, because:
  - Co-host will not connect without a camera source.
  - Non-gaming LIVEs will not start without a visible camera.
  - The quick and battle-from-idle paths show only the camera.
  - Match effects attach to the camera.
- **Format:** portrait 1080x1920 at 30 fps, matching Studio's 1080x1920 canvas and its 30 fps co-host preset.
- **Scene:** exactly one camera source on that device, filling the canvas, with no capture sources in the same scene. Then "Camera only" and "Current scene" give the same picture, Studio never proposes Share screen, and Match stays available.
- **Co-host setting:** Standard > Camera only, pointing at that camera. Re-check it after any scene or source change.
- **Safe area.** In the two-host layout seen on 12 Nov the slot is 536x978 (aspect about 0.548), which trims roughly 1.3% from each side of a 9:16 feed. The other bundled two-host layout (`cohost_normal_2`, ratio 1.25) would trim roughly 4.8% from top and bottom. Layouts with more hosts crop more.
- **Legibility.** The opponent receives about 536x978 at up to 3 Mbps, so small text will not survive.
- **All live changes must happen inside the feed.** Scenes cannot be switched and widgets are disabled during co-host.
- **Per account:** virtual-camera permission must be unlocked before a creator's first co-host.
- **Candidate feeder already on this PC:** OBS 32.2.2 with OBS Virtual Camera. Not tested.

## 8. Not verified

- Match with "Current scene" in practice.
- A real composed feed end to end: Chrome page to virtual camera to Studio to the opponent's phone, including latency and audio sync.
- How TikTok's battle UI overlaps the slot edges on phones.
- The exact unlock count for new accounts.
- Whether the bridge may call `coHost.configureCoHostLayout`.
- The audio route for the phone microphone.

## GOTCHAS
- A Window Capture or Link/browser source can never be the co-host camera: Studio only accepts scene sources of type camera. Without one, co-host will not connect at all (camera_not_available), and a non-gaming LIVE will not even start.
- Quick pairing, quick match, a direct battle started while not linked, and accepting an incoming battle while not linked all force the layout to Camera only, even if Current scene was saved. Whatever is not inside the camera feed disappears in those flows.
- Putting any capture source (window, game, display, phone cast, capture card) in the same scene as the camera makes Studio screen-share capable. It may then default to Share screen, which has no Match, and inviting is blocked until the layout dialog is confirmed.
- The saved co-host camera is a source id inside one scene. Switching scene or orientation, or re-creating the camera source, makes it unresolvable; Studio then resets the setting and shows its no-camera toast. This is the likely cause of the null selected camera the other programmer saw (not verified).
- Virtual cameras are gated per account by a server check. New LIVE Studio users are locked out until they complete a server-defined number of 25-minute LIVE Studio sessions (mobile LIVEs do not count, validation up to 48 hours). A locked virtual camera also stops counting as a co-host camera. This PC's account is unlocked; each creator account must be checked.
- Studio classifies a camera as virtual unless its device path contains usb# or pci#, or its name is on a server list of physical cameras. OBS Virtual Camera, Animaze, and WarudoCam are all treated as virtual.
- Every saved camera source on this PC has horizontal flip on and a default skin-smoothing effect at 0.6, including the OBS and Animaze sources. A composed program picture would be mirrored and filtered unless both are switched off on that source.
- On 12 Nov the opponent saw only a placeholder: the selected co-host camera was the Animaze Virtual Camera, and the Animaze application is not installed here (driver only). Any virtual camera shows a placeholder whenever its feeder is not running, and OBS is not running now.
- The creator's side is sent as a crop of Studio's canvas: 536x978 px at 30 fps and at most about 3 Mbps in the two-host layout observed. The camera is cover-fitted and centre-cropped, and the crop changes with the layout, so edge content and small text are at risk.
- During co-host, scenes cannot be switched, sources cannot be added while guests are connected, and widget sources are disabled in Current scene. Every visual change must happen inside the camera feed.
- Studio's older in-app string says Match needs camera only, while the official help page (3 Nov 2026) says Current scene supports matches. Both mean the Standard layout; only Share screen is excluded. Match under Current scene was not tested here.
- The camera-only observation in LIVE-VERIFICATION.md is not backed by any persisted field: the runtime JSONL logs and src/*.mjs contain no camera or layout data, and server.mjs does not read coHostContext.layoutConfig or screenShareCtx.
- An OBS Virtual Camera carries no audio, and this PC has no virtual audio cable. Studio's saved microphone input is currently disabled and muted.
- Studio logs are in GMT+2 and the bridge logs are in UTC. Both contain real account, room, and battle IDs, and one device name contains the owner's name; all are masked in this report.

## OPEN QUESTIONS
- Does Match actually run when Co-host is set to Standard > Current scene on this account and version? The official page says yes; only Camera only was observed locally.
- What does a phone viewer and the opponent see when the co-host camera carries a real composed 1080x1920 feed, and where does TikTok's battle UI (score bar, timer, gifts) cover the slot? This needs a two-account test with a screenshot.
- Which feeder should turn the Chrome program page into a camera device (OBS Virtual Camera via window capture or browser source, or another virtual camera), and what are its latency, frame pacing, and audio sync? Nothing was launched in this pass.
- How will the phone microphone reach Studio as an audio input, and what does the opponent hear? There is no virtual audio cable on this PC, and Studio has a separate toggle for sharing non-microphone audio with co-hosts.
- What is the exact unlock requirement for virtual cameras on a new creator account (reports say 1, 3, or 7 sessions of 25 minutes), and how should onboarding handle creators who are still locked?
- May the Codex panel's bridge read coHostContext.layoutConfig and screenShareCtx, and call Studio's built-in coHost.configureCoHostLayout tool to set Camera only and the camera id without touching the window? The tools exist in code and in the startup log but were not called.
- Which bridge field did the other programmer actually read when he recorded that the selected co-host camera was null, and what changed before the successful run? Camera settings were opened at about 21:33 local, but the cause is not confirmed.
- Should the co-host output resolution setting (Original, HD 1.5x, FHD 2x; currently Original) be raised so overlays stay legible for the opponent? Its availability in the UI was not checked.
