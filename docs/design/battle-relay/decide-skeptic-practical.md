# DECIDE: skeptic-practical

claim_refuted: false
confidence: medium

## VERDICT
Not refuted where it matters, but the premise is too absolute, and the recommended chain is unproven on this PC.

THE RULE. In LIVE Studio 1.39.6 the creator's slot is a Studio setting, not a fixed rule: `camera_only` ("Camera only", one camera source), `canvas` ("Current scene", every visible scene source, cover-cropped) or `screen_share`. Multi-guest hosts always use `canvas`. So a Window Capture can reach the opponent in "Current scene". The conclusion still holds for our product:
- Studio will not connect a co-host without a camera-type source, and will not start a non-gaming LIVE without a visible one.
- Accepting an incoming battle and Quick co-host switch the layout to `camera_only` in code. These are exactly the phone-panel flows.
- All 42 layout records of the real 12 Nov co-host and battles on this PC are `camera_only`.
- A Window Capture is never a camera candidate and makes Studio screen-share capable.
"Match under Current scene" is untested. Two strings the readers quoted as proof (en.json:3401 and :17518) are dead text with no code reference.

THE CHAIN. OBS Browser Source to OBS Virtual Camera is the right first candidate; no simpler software chain covers every battle flow. It has never run here: OBS's logs show no virtual-camera start and no browser source in the current OBS setup. Studio has only ever shown OBS's placeholder (9 Nov), though it accepted the device at 1080x1920 NV12 30 fps, and this account is not virtual-camera restricted.

WHAT BREAKS FIRST, in order:
1. Per-account virtual-camera lock for new creators (server-side; a locked camera also stops being a co-host camera).
2. OBS stopping: viewers get OBS's placeholder, and TikTok flags static pictures.
3. No unattended restart today: Studio needs elevation, UAC is on, there is no auto-logon.
4. Studio's own processing of the composite: mirror on, beauty smoothing 0.6 by default, automatic colour-range detection.
5. Audio: no virtual cable installed; Studio's microphone path has noise suppression and automatic echo cancelling; co-host background audio is muted; and there is no return path for the creator to hear or see the opponent on her phone.
6. The page schedules the body mask by frame count, so inside OBS at 30 fps the mask updates at 15 Hz (developers on the 180 Hz monitor see 90 Hz).
7. MediaPipe loads from public CDNs at every start, with a silent CPU fallback.
8. The output canvas follows the incoming video size, so WebRTC resolution changes will change the program picture.
9. Memory: about 0.6 GB of 32 GB was free at inspection.
10. One creator per Windows session (one Studio account, one OBS virtual camera).

A MORE ROBUST CHAIN exists only in hardware: GPU HDMI output into a USB capture dongle used as camera and microphone. It removes OBS, the virtual cable and lip-sync drift, but needs a device per creator, cannot run in a VM, and using it to sidestep the new-account lock is a policy decision for the owner.

NOT VERIFIED: Match under Current scene; a live OBS frame inside Studio; our page on Chromium 127; WebRTC and H.264 inside OBS; the whole audio leg; Studio behaviour with Windows locked or without a display; which field the other programmer read for the "null co-host camera".

## EVIDENCE
- Inspection was read-only: files, registry, process list, listening-socket list and nvidia-smi. No connection was made to 9222, 9225 or 47831; nothing was started, stopped or changed.
- C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\static\js\async\78977.cb7d771c.js (single-line file, character offsets) @~1,972,550 getLayoutConfigStrategy: `>.5?{mode:"canvas",recover_scene_after_linkmic_end:!0}:{mode:"camera_only",camera_visual_id:this.screenShareCtx.cameraVisuals[0].id}`. The slot content is a mode; with a camera covering more than half the canvas the default is canvas.
- Same file @2,953,643 LocalCameraLayer.doLoad: `this.cameraVisual=await SV(this.owner.config.layout.camera_visual_id)` then `SW({visualIds:[this.cameraVisual.id]})`. @2,971,872 LocalCanvasLayer.draw iterates `this.localScene.visuals` and calls `drawSingleVisual`. Camera only draws one camera; Current scene draws every scene source.
- Same file @2,166,182 function pu: `if(s&&"camera_only"===o.mode||(await t.updateLayoutConfig({mode:"camera_only",camera_visual_id:n})`. @2,211,841 incoming battle preparation ends with `await pu(this.linkmic,this.coHostContext,r)` after the prompt "Accepting this battle connects your camera with the other host and may expose this restricted LIVE room. Continue?". @2,164,273 Quick co-host uses the same `prepare:i=>pu(...)`.
- Same file @~1,990,300: `checkCameraSources(){...if(!(e.length>0)&&!t)return dM("error","camera_not_available")}`. @~2,103,500: `stage:"camera_required",message:"Add a camera source before connecting"`. @2,726,940 checkCameraGoLiveRestrict: `restrictMode:_6.L.forbidden,reason:r.length?_6.s.noVisibleCamera:_6.s.noCamera`; a covered camera only yields `restrictMode:_6.L.remind` (@2,725,900).
- Same file @~1,971,700: `cameraVisuals:e.filter(e=>e.type===l6.Y.camera&&i(e))`; cast list `dE=[l6.Y.game,l6.Y.monitor,l6.Y.window,l6.Y.android,l6.Y.ios,l6.Y.analog]`. @2,429,206 getExceptionIds: `(!1===e?.stateData?.state||!1===e?.stateData?.bizState)&&e?.id&&r.push(e.id)`. A camera that fails to load stops being a co-host candidate.
- Same file @2,298,309 [MultiGuest]: `layoutConfig:{mode:"canvas",recover_scene_after_linkmic_end:!1}`. Multi-guest hosts send the whole scene, so the claim is false for Multi-guest by code.
- C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\static\js\async\89811.a716b8ba.js @~20,131: the "What to show" dropdown has `{value:"camera_only"...}` and `{value:"canvas"...}`; the "Camera source" dropdown renders only when `I.length>1`.
- Dead strings: C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\locales\Live_Studio\en.json:3401 (`ls_cohost_new_desc3`, "Only camera sources will be displayed when you co-host with others."), :17518 (`ttlive_joinScreen_livePage_noMatchToast`) and :22669 have no reference in static, electron, html, build or plugins; only `ls_cohost_new_desc1` is referenced. A live string is en.json:20009 "No camera available for a camera-only co-host LIVE. Adjust co-host settings and try again.", used in 77918.d6ec54c0.js @3,037,431.
- C:\Users\shk\AppData\Roaming\TikTok LIVE Studio\logs\LS-renderer.2026-11-12.2.log L75-77: `layoutId: '200201', mode: 'camera_only', abr: { scale: 0.7 }` and `[linkmic_layout],layout_camera_only,skip layout`. Tally over all LS-renderer.2026-11-12*.log: camera_only = 42, no other mode logged.
- C:\Users\shk\AppData\Roaming\TikTok LIVE Studio\TTStore\services.json: `CoHostContextService.state.layoutConfig.mode = camera_only`, `outputResolution = 1`. Every saved source in all three scenes is type camera (no window, link or text source). The current vertical scene holds 'Animaze Virtual Camera' 1280x720 with scale 0.5695, translateY 443, flipH true. The horizontal scene holds 'OBS Virtual Camera' 1080x1920 at 30, format 6. `sensitiveRestrictionEnabled={"enable":false,"dualEnable":false,"restNum":0}`.
- C:\Users\shk\AppData\Roaming\TikTok LIVE Studio\logs\LS-renderer.2026-11-12.10.log L359: `isSensitiveRestrictionEnabled result,{ enable: false, dualEnable: false, restNum: 0}`. This account is not virtual-camera restricted; other creator accounts are not checked.
- C:\Users\shk\AppData\Roaming\TikTok LIVE Studio\logs\LS-renderer.2026-11-09.11.log L665: `[switch camera] setCamera from,<device path>,to,OBS Virtual Camera`. The same day's logs show `width: 1080, height: 1920, ... rate: 30, ... format: 3` (3 = PIXEL_FORMAT_NV12 in the main-bundle enum) and `fpsPrompt: 'raise'`. OBS has no log for 9 Nov, so Studio was showing OBS's placeholder, not live frames.
- C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\electron\main-bundle.js @255,527: `payload:{deviceId:"OBS Virtual Camera",name:"OBS Virtual Camera",rate:30,format:6,width:1080,height:1920,...key:"Smooth_ALL_High",value:.6}`. Studio ships a portrait OBS camera preset with beauty smoothing on by default. en.json:3263 and :3268 are OBS-specific notices ("go to OBS > Settings > Video").
- C:\Users\shk\AppData\Roaming\obs-studio\logs\2026-11-11 18-10-39.txt: L6 `Running as administrator: false`; L14 `Browser Hardware Acceleration: true`; L56 `Loading up D3D11 on adapter NVIDIA GeForce RTX 4080 Laptop GPU (0)`; L63-66 `base resolution: 1920x1080`, `output resolution: 1280x720`, `fps: 30/1`; L93 `CEF Version 127.0.6533.120`; L121 `logi_obs_plugin_x64.dll`; L176-177 the only source is `'Media' (ffmpeg_source)`. Neither OBS log has a virtual-camera start. C:\Users\shk\AppData\Roaming\obs-studio\basic\scenes\Untitled.json has no browser_source. C:\Users\shk\AppData\Roaming\obs-virtualcam.txt = `1080x1920x333333`, dated 11 Sep, older than the current OBS config (26 Oct). The .sentinel folder is empty, so no crash dialog is expected on next start.
- C:\Program Files\obs-studio\obs-plugins\64bit\obs-browser.dll (string scan): contains `autoplay-policy`, `no-user-gesture-required`, `disable-gpu-compositing`, `reroute_audio`; does not contain `enable-media-stream` or `use-adapter-luid`. libcef.dll product version 127.145.7+chromium-127.0.6533.120.
- C:\Program Files\TikTok LIVE Studio\1.39.6\TikTok LIVE Studio.exe manifest: `requestedExecutionLevel level="highestAvailable"`. Studio's command lines are unreadable from a normal shell (elevated). Registry: EnableLUA=1, ConsentPromptBehaviorAdmin=5; Winlogon AutoAdminLogon not set. Listening sockets: 9222 and 9225 on 127.0.0.1 owned by TikTok LIVE Studio (the bridge flags are active), 47831 and 8801 on 127.0.0.1, 8800 on all interfaces, 4455 closed.
- Audio: present endpoints are two microphones and two headset speaker endpoints; no virtual cable. services.json StreamSetting: audio input `disabled:true, isMute:true, enable_aec:"auto", byteAudioANS:5`; `linkmicBgAudio={"mute":true,"enable":true,"volume":1}`; `fps=60`, `resolution=[1080,1920]`, `bitrate=7000`, `videoEnc="HEVC_NVENC"`.
- C:\My Web Sites\boostera-live-studio-web\server-integration\wanna-studio-server\fx\index.html:45 `<video id="src" playsinline muted loop>`; :113-124 the sources are a file URL, getUserMedia or the ADB MJPEG stream (no WebRTC source yet). fx\fx-engine.js:4 `import ... from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'`; :73-74 GPU with silent CPU fallback; :340 `this.W = this.out.width = w; this.H = this.out.height = h;`; :471 `n % 2 === 1 && (busy || cut || n % 6 === 1)`; :1062 requestAnimationFrame loop. server.mjs:200 redirects `/clean/program` to `/fx/?clean=1`.
- Exposure controls in en.json: :27186 "you can choose who can watch this LIVE: Everyone, Friends, Selected people, or Super Fans"; :27177 "By inviting this creator, you'll allow viewers in their LIVE to watch your LIVE."; :27199 private-account rule. Static-picture warnings: :2992 "Your LIVE appears to contain static images or still scenes." and :9703.
- C:\My Web Sites\boostera-live-studio-web\server.mjs:37-40 reads only `interactionConnection.snapshot/providerReady` and `coHostContext.invitePanelState/battleStatus/linkedUsers`; :16-23 requestAllowed (Host must be 127.0.0.1 or localhost :47831, cookie `boostera_session`); :103 the cookie is set on any GET of `/`. src\rpc.mjs:39-42 is a generic `get_service_state`. src\native-ui.mjs:79 clicks with `e.click()` through `Runtime.evaluate`. docs\LIVE-VERIFICATION.md:17 says incoming accept and decline have "synthetic coverage only"; :27 is the camera-only error note. No camera or layout field exists in C:\Users\shk\Projects\boostera-live-studio-web\runtime\*.jsonl.
- 78977.cb7d771c.js @~5,604,033 tool schema: `obsVirtualCameraUsable` described as "true when OBS is enumerated AND obsVirtualCameraBlockedByPolicy is false"; @~5,946,300 `mode:Ye.enum(["camera_only","canvas","screen_share"])`. LocalCameraLayer.doUnload calls `this.sourceService.$setCurrLinkMicHostCamera(null)`, so a null selected co-host camera outside a co-host is normal.
- Machine state at inspection: RAM free 634 MB of 32,415 MB; CPU 51%; GPU 37% with 4.7 of 12.3 GB VRAM used; 39 chrome processes. A UnityCapture virtual-camera proof of concept from 12 Sep exists on the Desktop ('DuoPlus Test Camera' is registered as a DirectShow device).

## PLAN IMPACT
KEEP: "program page = LIVE Studio camera", with exactly one camera source in the scene and nothing else, so "Camera only" and "Current scene" give the same picture. DROP for battles: the three-layer Studio browser-source design (STUDIO-CONNECT.md:21-24). HOLD until the test is done: OBS automation and watchdog, virtual cable install, onboarding flows.

Corrections to the readers' recipe:
- Do not delete the Animaze camera source and add a new one: that invalidates the saved co-host camera id and Studio resets the setting (toast en.json:20009). Change the device on the existing source instead.
- Set OBS to 1080x1920 before the first "Start Virtual Camera"; the current profile is 1920x1080 base, 1280x720 output.
- Studio's LIVE is set to 60 fps and it nags to raise the camera FPS; set the LIVE to 30 fps or accept the nag.
- Do not use `currLinkMicHostCamera` as a readiness signal: Studio sets it to null whenever no co-host layout is loaded.
- Treat locale strings as hints only; several are unreferenced.

HOW EACH RESULT CHANGES THE PLAN
Part 1 (no LIVE):
- "OBS Virtual Camera" missing, greyed, or "Virtual camera access restricted": account-level blocker. Plan the unlock sessions per creator, or the hardware capture loop. Nothing else changes.
- Stretched or landscape picture: try "Use presets", pick 1080x1920 by hand, then 720x1280, then a landscape canvas plus "Rotate 90°".
- Studio does not recover by itself after OBS restarts: attended operation only until a watchdog can re-select the camera through the bridge.
- Page log says CPU, or more than 1% missed frames, or the wall is missing: keep OBS Virtual Camera but render the page in Chrome (own profile, anti-occlusion flags) with OBS Window Capture, or fix the page for Chromium 127.
Part 2 (LIVE):
- Test A, marker hidden (expected): every visual must live inside the camera feed. Marker visible: the code reading is wrong; stop and re-read before investing.
- Test B, marker visible and Match runs: Studio-native layers are possible only for matches started from an existing co-host. Match blocked or marker vanishes: the camera is the only path for every battle.
- Test C, marker hidden and setting flipped to "Camera only" (expected): battles accepted from the phone always show only the camera. Marker visible: a Link-source fallback becomes possible for accounts without virtual-camera permission.
- Edge words cut or covered: those measurements become the page's battle-safe area.

SAFE TO BUILD NOW, whatever the outcome:
1. The authenticated phone to gateway to panel relay. Narrow allow-list only (state, battles, battles/action, invites). The gateway can obtain the panel cookie from GET / on 127.0.0.1:47831 with no panel change. Surface Studio's confirmation prompts on the phone (for example the restricted-room prompt on battle acceptance). Accept and decline of incoming battles through the panel still has synthetic coverage only.
2. The WebRTC live link: STUN plus TURN, VP8, an unmuted audio element with adjustable delay, reconnect, and a moving "no signal" slate (never a still image).
3. Page hardening: fixed 1080x1920 stage independent of the incoming size; time-based mask and pose cadence; self-hosted MediaPipe files; on-picture diagnostics (GPU or CPU, fps); a test-card page with edge rulers and a millisecond clock.
4. Read-only readiness in the panel: `coHostContext.layoutConfig`, the `screenShareCtx` camera list, and Studio's own `camera.getObsVirtualCameraPermission`.
5. A written runbook.

LATER, separately scoped: audio in and back (two virtual audio devices: voice to Studio, opponent sound back to the phone), video return to the phone, OBS watchdog, auto-start (elevated scheduled task or a standard Windows user), per-account onboarding, one machine or VM per creator.

## SMALLEST DECISIVE TEST
Two parts. Part 1 needs no LIVE and settles whether the chain works. Part 2 is one short restricted LIVE and settles the camera rule. Do not restart LIVE Studio at any point.

BEFORE YOU START
- Close programs you do not need (only about 0.6 GB of 32 GB memory was free).
- Check that Studio is not LIVE.
- Keep the external monitor connected as it is now.

PART 1: CHAIN CHECK, NO LIVE, about 20 minutes
1. Start OBS Studio. Cancel any update offer or setup wizard.
2. OBS menu: Profile > New > name it BOOSTERA. Scene Collection > New > name it BOOSTERA.
3. Settings > Video: Base (Canvas) Resolution 1080x1920, Output (Scaled) Resolution 1080x1920, FPS 30. Click OK. Do this before step 5.
4. Sources "+" > Color Source, pick a strong green. Right-click it > Transform > Stretch to screen. Then Sources "+" > Text (GDI+) five times: "CAMERA FEED" in the centre, "TOP" touching the top edge, "BOTTOM" touching the bottom edge, "LEFT" touching the left edge, "RIGHT" touching the right edge.
5. Click "Start Virtual Camera".
6. In LIVE Studio, vertical scene "Full-screen camera": open the settings of the existing camera source and change its device from "Animaze Virtual Camera" to "OBS Virtual Camera". Do not delete the source. Choose 1080x1920 and 30 FPS if offered. Right-click the camera in the preview > "Fill screen".
   Look at:
   a. Is "OBS Virtual Camera" listed and selectable, with no "Virtual camera access restricted" message?
   b. Does the green picture fill the whole vertical preview?
   c. Are the words readable, not mirrored? If mirrored, turn off "Flip horizontally" / "Mirror flip".
   d. Are letters normal, not squeezed, and all four edge words visible?
   e. Is the picture sharp? If softened, turn off Enhance / beauty on this camera.
   f. Is the green the same as in OBS? If washed out, set the camera's colour range to "Limited".
7. Recovery: in OBS click "Stop Virtual Camera" (Studio should show an OBS placeholder), then Start again. Then close OBS completely, reopen it and click "Start Virtual Camera". Look at: does Studio's preview come back by itself each time?
8. Real page: in OBS, Sources "+" > Browser. First use the panel version of your usual program link (for example http://localhost:8800/fx/?src=phone), Width 1920, Height 1080. In the page's log box find the line starting "MediaPipe ready"; it must end with "GPU", not "CPU". Then edit the source: URL = your clean program link (http://localhost:8800/clean/program?src=phone&streamer=<name>, plus &stage=<wall link> if you use the wall), Width 1080, Height 1920. Leave "Use custom frame rate", "Shutdown source when not visible" and "Refresh browser when scene becomes active" unticked. Drag it below the text labels.
   Look at: the creator cut out over the wall, in OBS and in Studio. Trigger one effect from http://localhost:8800/links and see it in both. After 2 minutes open OBS View > Stats (or Docks > Stats): "Frames missed due to rendering lag" should be under 1%.

PART 2: THE CAMERA RULE, ONE SHORT LIVE, about 20 minutes
Exposure: both accounts restricted, microphones muted, no face needed.
9. In OBS keep the five text labels on top. Underneath, prefer the real page (it is genuinely live). If Part 1 step 8 failed, use the green card and keep the LIVE under 15 minutes, because TikTok flags static pictures.
10. In Studio: Add source > Text, type "SCENE ONLY", make it big and red, place it in the upper-middle of the canvas, not at an edge. This is the non-camera marker. Add it now; Studio refuses new sources once a guest is connected.
11. In Studio's Go LIVE settings set "Who can watch" to "Selected people" (your second account; it must follow the first if that one is private) or "Friends". If the option is missing, rely on the account being private. Keep the microphone muted. Go LIVE. On the second phone also go LIVE: mic muted, camera at a wall, restricted if the app offers it. Co-hosting lets each side's viewers see the other LIVE.
12. TEST A, Camera only. Studio: Co-host > Settings > Layout "Standard", What to show "Camera only". Invite the second account and accept on the phone. Screenshot the phone and the Studio preview. Then start a Match and screenshot both again.
   Look at: is the red "SCENE ONLY" visible on the phone? (Expected: no.) Which edge words are cut off or hidden under TikTok's score bar and timer?
13. TEST B, Current scene. End the match. Set What to show to "Current scene". If Studio refuses while connected, disconnect, change it, invite again. Screenshot. Then start a Match and screenshot.
   Look at: is "SCENE ONLY" visible now? (Expected: yes.) Does the Match start? Does the text vanish when it starts? Any message about camera only? (Unknown; this is the open question.)
14. TEST C, incoming battle from idle. Disconnect the co-host and leave "Current scene" selected. From the second phone send a Match invitation straight to the Studio account. Accept it. Optional: accept from the BOOSTERA web panel instead of Studio's popup, to check that path too; if it fails, accept in Studio. Expect a prompt about exposing a restricted LIVE. Screenshot the phone, then open Co-host > Settings and read "What to show".
   Look at: is "SCENE ONLY" visible? Did the setting flip to "Camera only"? (Expected: not visible, flipped.)
15. End both LIVEs. If Studio asks "Restore scene settings before co-host LIVE?", choose Restore. Remove the Text source. Switch the camera back to "Animaze Virtual Camera" if you want the old setup. Click "Stop Virtual Camera".

KEEP: the six screenshots, the answers to 6a-6f, 7 and 8, and the OBS Stats numbers.

READING THE RESULT
- Steps 6-8 all good: the OBS chain is viable on this PC for video.
- Test A marker hidden and Test C marker hidden with the setting flipped: the program must be the camera; overlays placed in Studio never reach battles accepted from the phone.
- Test B tells whether Studio-level layers are ever usable in a Match.
- The cut or covered edge words give the battle-safe area for the page.
Audio, lip-sync and the return path to the phone are not covered by this test; they need a second, separate test after a virtual audio cable is installed.
