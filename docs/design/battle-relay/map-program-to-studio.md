# MAP: program-to-studio

# Program page into TikTok LIVE Studio: video as Camera, voice as Microphone

## 1. Recommendation
Render the program page in an **OBS Browser Source**, output it through **OBS Virtual Camera** (portrait 1080x1920, 30 fps) and add that as LIVE Studio's **Camera** source. Send the page's sound (the creator's voice) from the same browser source through OBS audio monitoring into a **virtual audio cable**, and make the cable LIVE Studio's only microphone. Use this one chain for solo LIVE and for battles; do not also add the page as a Link or Window source.

Nothing in this chain was run in this pass (read-only). OBS 32.2.2 with its virtual camera is already installed; a virtual audio cable is not.

## 2. Why the page must arrive as the camera
Evidence from the installed LIVE Studio 1.39.6 (`C:\Program Files\TikTok LIVE Studio\1.39.6\resources\app\`):
- `locales\Live_Studio\en.json:3401`: "Only camera sources will be displayed when you co-host with others."
- `en.json:19994-19995`: the co-host choice is "Camera only" or "Current scene"; `:20001` "Your current scene will be cropped in the co-host layout". `electron\main-bundle.js:769` uses the modes `"camera_only"` and `"screen_share"`.
- Today's real battle, `docs\LIVE-VERIFICATION.md:15`: "The Studio side showed its virtual-camera image"; `:27`: "Its scene had an Animaze camera, but the selected Co-host camera was null."
- `en.json:24819`: "A camera source is required to ensure real-time interactions during your LIVE."; `:24811`: "Your camera source is heavily obstructed."
- Virtual cameras are an accepted camera type: `en.json:6648` "including your device camera and any virtual cameras". `main-bundle.js:32` embeds a camera source `deviceId:"OBS Virtual Camera",name:"OBS Virtual Camera",rate:30,format:6,width:1080,height:1920` (format 6 is `PIXEL_FORMAT_YUY2`, `:35`). `en.json:3268` gives OBS-specific advice: "go to OBS > Settings > Video to adjust your resolution".
- The voice must be the microphone: `en.json:19305` describes a toggle, "During co-host or multi-guest LIVE, allow other creators or guests to hear the background music played on your computer." Computer sound is not sent to the other creators by default.

## 3. Installed on this PC (file system, registry and PowerShell queries only)
- **OBS Studio 32.2.2**: `C:\Program Files\obs-studio\bin\64bit\obs64.exe`, not running. Log `%APPDATA%\obs-studio\logs\2026-11-11 18-10-39.txt`: line 14 `Browser Hardware Acceleration: true`; lines 92-93 `[obs-browser]: Version 2.26.9`, `CEF Version 127.0.6533.120`; line 95 obs-websocket `Version: 5.7.4`; lines 63-66 `base resolution: 1920x1080`, `output resolution: 1280x720`, `fps: 30/1`. obs-websocket server is disabled (port 4455, auth required).
- **OBS Virtual Camera**: registered for 64-bit and 32-bit apps (`data\obs-plugins\win-dshow\obs-virtualcam-module64.dll`, v32.2.2). `%APPDATA%\obs-virtualcam.txt` contains `1080x1920x333333` (modified 2026-09-11), so its last start on this PC was 1080x1920 at 30 fps.
- **Other virtual cameras**: ByteCast VirtualCamera1-4 (LIVE Studio's own `sdk\lib\camera\castmateappvirtualcamera.dll`), Animaze Virtual Camera (e2eSoft), WarudoCam x4, and a UnityCapture test filter named "DuoPlus Test Camera" registered from a Desktop POC folder.
- **Virtual audio cable**: none. No VB-CABLE, Voicemeeter or VAC. Present but unsuitable: "Voice Changer Virtual Audio Device (WDM)", "Boom Audio", "NVIDIA Virtual Audio Device", Realtek "Stereo Mix".
- **NDI / Spout / others**: only "NDI 6 Runtime 6.3.2.0" (no NDI Tools, no DistroAV plugin). Spout, vMix, ManyCam, SplitCam, Streamlabs: not found.
- **TikTok LIVE Studio 1.39.6**: running. `main.dll` is Electron 36.4.0 (Electron 36 ships Chromium 136). Its command line could not be read from this shell, so the bridge flags are not verified.
- **Chrome** 154.0.8037.58. Windows 11 Pro build 26200, i9-13950HX, 32 GB, RTX 4080 Laptop 12 GB plus Intel UHD, external 5120x2160 180 Hz HDR display at 150% scaling.

## 4. Options compared
| # | Route | Battle camera? | Covered / minimized | New installs here | Verdict |
|---|---|---|---|---|---|
| 1 | Page in OBS Browser Source, out through OBS Virtual Camera | Yes | No window exists; unaffected | VB-CABLE only | Recommended |
| 2 | Page in Chrome, OBS Window Capture, OBS Virtual Camera | Yes | Covered: Chrome stops drawing unless started with anti-occlusion flags. Minimized: no picture | VB-CABLE only | Fallback renderer |
| 3 | LIVE Studio Window Capture of Chrome | No (scene source) | Same as 2; `en.json:6653` "If the window is minimized, the video source may lose its signal" | none | Solo LIVE only |
| 4 | LIVE Studio Link source ("Browser capture") | No (scene source) | No window; unaffected | none | Solo LIVE only |
| 5 | NDI (DistroAV + NDI Webcam Input) or Spout (SpoutCam) | Yes, still via a virtual camera | Unaffected | two tools | No gain on one machine |
| 6 | Other virtual cameras (Animaze, Warudo, UnityCapture, vMix, ManyCam) | Yes | n/a | varies | Not needed; OBS is here |
| 7 | No software: HDMI output into a USB capture dongle | Yes (physical camera plus USB audio) | Needs its own display output | hardware | Last resort; see gotchas |

**Compositing.** The page is a 2D canvas above the wall iframe (`fx\index.html:38-41`, `:95-110`; `fx\fx-engine.js:50`, `:52-54`). A browser source or a window capture takes the composited page. `canvas.captureStream` (`fx\index.html:188`) would lose the wall. The page paints its own black background (`fx\index.html:11`, `:36`), so the output is opaque.

**WebRTC and MediaPipe inside OBS.**
- OBS's embedded browser is Chromium 127. OBS 31.0 notes: "Updated the browser source/docks CEF (Chromium) to version 127 (6533) on all platforms"; the installed 32.2.2 still carries `libcef.dll` 127.0.6533.120. The developers' Chrome is 154, so the page must be tested on 127.
- Hardware acceleration is on (`global.ini` `BrowserHWAccel=true`; setting name "Enable Browser Source Hardware Acceleration", OBS `en-US.ini:1494`). With it off, obs-browser adds `disable-gpu-compositing` and the engine would drop to its CPU path (`fx-engine.js:73-74`).
- Autoplay with sound is allowed: obs-browser always appends `autoplay-policy=no-user-gesture-required` (browser-app.cpp).
- Receiving WebRTC in a browser source is VDO.Ninja's documented workflow. Its docs warn that browser sources hide local IPs, "which can force TURN relay", so STUN and TURN are needed. getUserMedia needs extra CEF launch flags (not needed for receive-only; not re-verified).
- Without "Use custom frame rate", OBS drives the page (`external_begin_frame_enabled = true` when `!fps_custom`, obs-browser-source.cpp), so requestAnimationFrame equals the OBS frame rate. The engine works per animation frame (`fx-engine.js:1062`), refreshes the body mask every second frame (`:471`) and reads it back to the CPU (`:475`).

**Frame rate, delay, GPU (estimates, not measured).**
- Route 1: 30 fps locked to OBS. Added delay from page to Studio preview is roughly 4-7 frames (130-230 ms): browser texture hand-off up to 1 frame, OBS output 1-2, virtual camera up to 1 (a 3-slot ring read at "latest", shared-memory-queue.c), Studio's camera path 1-3. GPU cost is the page itself; OBS compositing is negligible (log: graphics thread median 0.41 ms).
- Route 2 adds one capture hop, and Chrome draws at the monitor rate (180 Hz here).
- Routes 3 and 4 have the fewest hops but cannot be the battle camera.

**Portrait.** OBS Virtual Camera outputs whatever Output (Scaled) Resolution is set (`obs_output_get_width/height`, virtualcam.c), as NV12/I420/YUY2, and rescales if the app asks for another size. LIVE Studio accepting it in portrait is supported by `main-bundle.js:32`, `en.json:19912` ("vertical camera source"), `en.json:6089` ("Rotate 90°"), the CastMonkey guide (updated 2026-02-23) and the BytePlus guide (updated 2026-09-07). It is not verified on this PC.

**Audio and lip-sync.**
- OBS Virtual Camera is video only (the only DirectShow audio capture filter registered here is Studio's "ByteCast VirtualAudio").
- "Control audio via OBS" (obs-browser `en-US.ini:12`) mutes the page and routes its sound into OBS (`SetAudioMuted(true)` under `reroute_audio`).
- BytePlus documents the same pattern: OBS monitoring into VB-Cable, then "set ONLY one Main Microphone — CABLE Output (VB-Audio Virtual Cable)".
- OBS "Sync Offset" does not reach the monitoring device (OBS forum: monitoring "grabs the audio before any processing is done to it"). Tune sync with LIVE Studio's "Audio offset" (`en.json:3244`) or a delay inside the page.

**Automation.** The installed `obs64.exe` contains `--startvirtualcam`, `--scene`, `--profile`, `--collection`, `--minimize-to-tray`, `--disable-updater`, `--disable-missing-files-check`, `--only-bundled-plugins`, `--safe-mode`, `--multi`. It does not contain `--disable-shutdown-check`. The virtual-camera output type is stored in the scene collection (`"virtual-camera":{"type2":3}`).

**LIVE Studio's Link source.** It runs on Studio's own Chromium 136 with anti-throttling switches (`main-bundle.js:834` `disable-backgrounding-occluded-windows`). Audio is only un-muted playback (`main-bundle.js:523` `let P=!i.enableAudio` then `setAudioMuted(P)`); how that reaches the mix is not verified. A third-party help page (updated 2026-02-23) reports a bug where link sources load at 0x0 pixels.

## 5. Recommended chain on this PC: settings and order
Do this while no LIVE is running.
1. Install VB-CABLE (vb-audio.com/Cable; run the x64 setup as administrator; reboot). In Windows Sound, set "CABLE Input" and "CABLE Output" to 2 channels, 48000 Hz. Keep the normal speakers as default device.
2. OBS: Profile > New > "BOOSTERA"; Scene Collection > New > "BOOSTERA".
3. Settings > Video: Base (Canvas) Resolution `1080x1920`, Output (Scaled) Resolution `1080x1920`, Common FPS Values `30`.
4. Settings > Audio: Sample Rate 48 kHz; Desktop Audio and Mic/Auxiliary Audio = Disabled; Advanced > Monitoring Device = "CABLE Input (VB-Audio Virtual Cable)".
5. Settings > Advanced: "Enable Browser Source Hardware Acceleration" ticked; Process Priority "Above Normal".
6. Add Source > Browser: URL = the program link (`/clean/program?...` on the local server, with the live-link source and `stage=`); Width 1080, Height 1920; tick "Control audio via OBS"; leave "Use custom frame rate", "Shutdown source when not visible" and "Refresh browser when scene becomes active" unticked; Page permissions "No access to OBS".
7. Edit > Advanced Audio Properties > the Browser source > Audio Monitoring "Monitor Only (mute output)".
8. Controls > gear beside "Start Virtual Camera" > Output Type "Program (Default)"; click "Start Virtual Camera".
9. LIVE Studio, portrait scene: add a Camera (Webcam) source, device "OBS Virtual Camera", 1080x1920 at 30 if offered. If it is stretched or fails to load, switch on "Use presets" (`en.json:19921`: "Try this if the camera fails to load or if you use a virtual camera"). Fill the screen, mirror off, Studio enhance/effects/filters off, remove the old Animaze camera source.
10. LIVE Studio mixer: Add audio source > Audio devices > "CABLE Output (VB-Audio Virtual Cable)". Remove or mute the real microphone and any speaker source. Noise suppression and echo cancellation off for the cable. Sampling rate 48 kHz.
11. Co-host settings: What to show = "Camera only"; Camera source = the OBS Virtual Camera source. In the co-host audio settings, "Select speaker" must not be the cable; "Background music" off.
12. Daily order: gateway, then OBS (virtual camera on), then LIVE Studio.

Unattended start, for the programmer (run from `C:\Program Files\obs-studio\bin\64bit`; the working-directory requirement is known behaviour, not re-verified): delete `%APPDATA%\obs-studio\.sentinel`, then `obs64.exe --profile "BOOSTERA" --collection "BOOSTERA" --scene "<scene>" --startvirtualcam --minimize-to-tray --disable-updater --disable-missing-files-check`.

If LIVE Studio's camera notice asks for 720, set Output (Scaled) Resolution to `720x1280` and re-add the camera.

## 6. Future GPU Windows server
- Same chain and settings. The page is drawn off-screen, so it does not depend on a monitor, window order or screen lock.
- Needs a real GPU with its vendor driver in an interactive console logon, auto-logon, and a display for Windows (a virtual display driver such as VirtualDrivers/Virtual-Display-Driver, or an HDMI dummy plug).
- Do not run the live session over RDP. OBS forum: over RDP Windows provides "an emulated GPU that lacks all accelerated graphics operations required by OBS". Use a console-sharing remote tool.
- Prefer Windows 11 Pro on GPU hardware. OBS forum (Nov 2025): "OBS Studio isn't designed to run on a server you connect with rdp"; a Server 2022 user could not see a virtual cable in OBS and moved to Windows 11 Pro. LIVE Studio on Windows Server is not verified.
- Windows Audio services must run; VB-CABLE supplies the audio endpoints.
- One creator per Windows instance: OBS's virtual camera uses one fixed shared-memory name (`OBSVirtualCamVideo`, "fail if already in use").
- Watchdog through obs-websocket 5.7.4 (enable it; keep the password; firewall the port): `GetVirtualCamStatus`, `StartVirtualCam`, `PressInputPropertiesButton` (`refreshnocache`), `GetSourceScreenshot`, `GetStats`.
- Pin the OBS version, and self-host the MediaPipe files the page now loads from public CDNs (`fx-engine.js:4`, `:12-15`).

## 7. Must be proven by a real test
1. The page in an OBS browser source: log shows `MediaPipe ready (... GPU)`, wall visible behind the cut-out, OBS Stats shows no frames missed to rendering lag.
2. WebRTC receive inside OBS from a phone on Wi-Fi and on mobile data (with TURN).
3. Page sound moves the OBS meter, reaches the cable, moves LIVE Studio's microphone meter, with no doubling.
4. LIVE Studio lists "OBS Virtual Camera" as selectable, offers 1080x1920 at 30, shows it unstretched with correct colours.
5. A battle with a second owned account: the other side sees creator, wall and effects, and hears her. Record how the camera is cropped and define a battle-safe area.
6. Clap test for lip-sync; set LIVE Studio "Audio offset".
7. End-to-end delay, phone to viewer.
8. Cover OBS, minimize it to tray, lock the screen, kill and restart OBS: does the Studio camera recover without re-adding?
9. Two-hour soak: memory of the browser source, audio drift, laptop GPU temperature.
10. Reboot: everything comes back with no dialog.

## 8. Fallbacks
- **Page misbehaves on Chromium 127**: keep the chain, change only the renderer. Run the page in Chrome with its own `--user-data-dir`, `--app=<link>`, `--autoplay-policy=no-user-gesture-required` and anti-occlusion switches (`--disable-features=CalculateNativeWinOcclusion`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`; not verified on Chrome 154). Bring it into OBS with Window Capture (client area, no cursor) and Application Audio Capture.
- **Portrait not accepted or stretched**: OBS canvas 1920x1080 with the browser source rotated 90°, then "Rotate 90°" on the Studio camera.
- **Cable trouble**: LIVE Studio "Applications" audio source on OBS with "Background music" on. Whether Studio then ducks or processes the voice is not verified.
- **Whole OBS path unusable on a physical machine**: full-screen Chrome on an HDMI output into a USB capture dongle, used as camera and microphone. Not tested.

## 9. Licensing
- OBS Studio and obs-browser: GPL v2 or later; free for commercial use as stock binaries.
- VB-CABLE: donationware; "you are expected to pay your license if you find it useful or if you make any professional use" (about EUR 3.61 per unit at 100). VB-CABLE A+B and C+D must be purchased.
- NDI Tools: free, proprietary. DistroAV and Spout: open source.
- MediaPipe: Apache-2.0 (not re-verified in this pass).

## Sources
- OBS 31.0 notes: https://github.com/obsproject/obs-studio/releases/tag/31.0.0
- OBS KB: https://obsproject.com/kb/launch-parameters , https://obsproject.com/kb/browser-source , https://obsproject.com/kb/virtual-camera-guide
- obs-browser source: https://github.com/obsproject/obs-browser (browser-app.cpp, obs-browser-source.cpp)
- OBS virtual camera source: https://github.com/obsproject/obs-studio (plugins/win-dshow/virtualcam.c, virtualcam-module/virtualcam-filter.cpp, shared/obs-shared-memory-queue)
- obs-websocket protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
- OBS forum, 2025-09-24, shutdown check removed: https://obsproject.com/forum/threads/obs-version-32-0-0-removed-disable-shutdown-check.190590/
- OBS forum, sync offset and monitoring: https://obsproject.com/forum/threads/does-sync-offset-work-with-audio-monitoring-switched-on-in-advanced-audio-properties.122877/
- OBS forum, 2026-01-05, virtual cam "not available" in LIVE Studio: https://obsproject.com/forum/threads/obs-virtual-cam-not-available-on-tiktok-live-studio.193605/
- OBS forum, Windows Server: https://obsproject.com/forum/threads/windows-server-2022-and-obs.192282/ , https://obsproject.com/forum/threads/windows-server-and-obs-compatibility.170971/
- BytePlus, updated 2026-09-07: https://docs.byteplus.com/docs/byteplus-livesaas/Going_live_on_TikTok_via_Digital_Human_and_OBS
- CastMonkey, updated 2026-02-23: https://help.castmonkey.com/en/pages/how-to-setup-obs-virtual-camera-with-tiktok-live-studio , https://help.castmonkey.com/en/pages/link-source-not-visible
- VDO.Ninja: https://docs.vdo.ninja/guides/enabling-webrtc-sources-in-obs , https://docs.vdo.ninja/common-errors-and-known-issues/loss-of-audio-when-obs-minimized
- Chromium occlusion: https://chromium.googlesource.com/chromium/src/+/HEAD/docs/windows_native_window_occlusion_tracking.md
- Electron 36 (Chromium 136.0.7103.48): https://releases.electronjs.org/release/v36.0.0
- VB-Audio: https://vb-audio.com/Cable/ , https://vb-audio.com/Services/licensing.htm
- NDI Webcam Input: https://docs.ndi.video/all/using-ndi/ndi-tools/ndi-tools-for-windows/webcam-input
- Spout plugin: https://github.com/Off-World-Live/obs-spout2-plugin
- LSVCam hang, 2024-10-09: https://engineered.at/articles/webcam-randomly-pausing-in-obs-discord-and-websites-lsvcam-and-tiktok-studio

## GOTCHAS
- Battles show the camera, not the scene: LIVE Studio 1.39.6 en.json:3401 says "Only camera sources will be displayed when you co-host with others." A Link or Window source will not reach the opponent's side in "Camera only" mode.
- New accounts may be locked out of virtual cameras: en.json:25845 "For content safety, new users cannot add virtual cameras. You can still add physical cameras to go LIVE." and :25831 "Unlock virtual camera by going LIVE on LIVE Studio {s_num} more time for 25 minutes each. Mobile LIVE streams do not count. Validation may take up to 48 hours." Studio's camera dropdown disables devices flagged isVirtualCamera (static\js\49161.f517598e.js). This is an onboarding blocker for every new creator account; today's test account was not blocked (it used the Animaze virtual camera).
- The HDMI capture-dongle route must not be used to get around the virtual-camera restriction without TikTok's agreement; treat the unlock rule as an onboarding requirement.
- No virtual audio cable is installed on this PC, and OBS Virtual Camera carries no sound. The creator's voice must enter LIVE Studio as the microphone, because other creators hear computer sound only if the "Background music" toggle is on (en.json:19305).
- OBS "Sync Offset" does not delay the monitoring output that feeds the cable. Lip-sync must be tuned with LIVE Studio's "Audio offset" (en.json:3244, range not verified) or with a delay in the page.
- OBS 32 shows a blocking "OBS Studio Crash Detected" dialog after an unclean exit (OBS en-US.ini:135-140), and the installed 32.2.2 has no --disable-shutdown-check. Delete %APPDATA%\obs-studio\.sentinel before each automated start. Safe Mode disables WebSockets.
- OBS's embedded browser is Chromium 127 while the developers' Chrome is 154. Test the page there, and load only trusted pages in it (the cloud wall is a cross-origin iframe).
- If OBS stops, LIVE Studio shows OBS's own placeholder picture (data\obs-plugins\win-dshow\placeholder.png, 1920x1080, stretched in portrait) to viewers until OBS is back. A watchdog and a branded placeholder are needed before unattended use.
- Only one OBS Virtual Camera stream can exist per Windows session (fixed shared-memory name OBSVirtualCamVideo). Plan one creator per machine or VM.
- The engine's workload follows the host frame rate (fx-engine.js:1062 requestAnimationFrame; mask every second frame, :471). In OBS at 30 fps the cut-out mask refreshes at 15 Hz; in Chrome on this PC's 180 Hz monitor it runs up to six times as often. What developers see is not what goes on air.
- The page's video element is muted today (fx\index.html:45) and the phone source is still the ADB picture stream (fx\index.html:116-123). The WebRTC audio playback element does not exist yet. In plain Chrome it needs a gesture or the autoplay flag; in OBS it does not.
- OBS browser sources hide local IP addresses, which can force a TURN relay. Configure STUN and TURN for the live link.
- Do not give OBS or its embedded browser a debugging port of 9222 or 9225; the LIVE Studio bridge uses them.
- Chrome ignores new command-line flags when the same profile is already running (77 chrome processes are running now). The Chrome fallback needs its own --user-data-dir.
- This PC's main display is HDR at 150% scaling. That affects window and monitor capture (colour and pixel size) but not the OBS browser source.
- Today's battle test hit a "camera-only Co-host configuration error" because "the selected Co-host camera was null" (docs\LIVE-VERIFICATION.md:27). After switching the camera to OBS Virtual Camera, re-select it in the co-host settings.
- %APPDATA%\obs-virtualcam.txt says 1080x1920 at 30 fps, but the current OBS profile is 1920x1080 base and 1280x720 output. Set the profile to 1080x1920 before the first virtual-camera start, or the camera format becomes 1280x720 and LIVE Studio must re-add it.
- This is a dual-GPU laptop. OBS and its browser helper must stay on the NVIDIA GPU for the hardware-accelerated browser source. The log also shows "D3D11 GPU priority setup failed (not admin?)"; VDO.Ninja reports choppy browser-source audio when OBS is minimized unless it runs as administrator.
- LIVE Studio's own enhance, effects and filters would process the whole composite picture. Keep them off on the OBS camera source.
- LIVE Studio's installed virtual cameras (LSVCam / ByteCast) have been reported to hang camera listing in other apps (October 2024 report). If OBS or Chrome camera lists freeze, suspect that.
- The page loads MediaPipe code and models from public CDNs at every start (fx-engine.js:4, :12-15). Go-live depends on those hosts unless the files are self-hosted.
- The existing record button uses canvas.captureStream (fx\index.html:188), which records the canvas without the wall iframe.
- obs-websocket is currently disabled (port 4455, password required). The minimal chain does not need it; enable it only for the watchdog and keep it firewalled.
- The vendor page lists the current VB-CABLE package as Pack46 dated NOV 2026, i.e. a brand-new driver build.
- Latency and GPU figures in the report are estimates from the pipeline structure, not measurements.

## OPEN QUESTIONS
- Is the virtual camera unlocked for each creator account that will sign in to LIVE Studio on the server, and how many 25-minute LIVE Studio sessions does TikTok currently require?
- Does LIVE Studio 1.39.6 offer 1080x1920 at 30 fps natively for OBS Virtual Camera on this PC, without stretching or a colour shift?
- How exactly is the camera cropped in the battle layout, and what central safe area must the program page keep?
- Is the "Current scene" co-host option available in battles for these accounts, and is it wanted given the crop?
- Can noise suppression and echo cancellation be fully switched off for the cable microphone in LIVE Studio, and what is the range of its "Audio offset"?
- How will the creator hear and see the opponent on her phone? LIVE Studio has a "Select speaker" setting for other creators' sound that could feed a second virtual device, but no return path exists yet.
- Does the finished live-link page (WebRTC receive, MediaPipe on the GPU, wall iframe) run correctly on Chromium 127 inside OBS?
- Does TikTok LIVE Studio install and run on Windows Server 2022/2025 or inside a cloud GPU virtual machine? Not found; only Windows 10/11 is documented by third parties.
- Does LIVE Studio recover the camera by itself after OBS restarts, or must the source be re-added?
- How does sound from a LIVE Studio Link source with audio enabled reach the broadcast mix? Not verified.
- Is LIVE Studio currently running with the bridge flags? Its command line was not readable from this shell.
