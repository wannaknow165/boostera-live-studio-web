# First local client box

The first box reuses the existing Windows installation, TikTok LIVE Studio, local media/effects server and control panel. This is a local single-client runtime, not a virtual machine or a multi-client security boundary.

## Entry points

- Box manager: http://127.0.0.1:8801/mobile/box
- Phone camera/effects/chat: http://127.0.0.1:8801/mobile/
- Full manager: http://127.0.0.1:8801/mobile/manage
- Local phone pairing setup: http://127.0.0.1:8801/mobile/pair
- Native Studio controls: http://127.0.0.1:47831/
- Paired phone Studio controls: `/mobile/studio` through the same phone gateway

These loopback addresses are for the computer. A phone needs a reachable HTTPS gateway with pairing, or an explicitly configured USB reverse connection. They are not public phone links.

Run `node box.mjs --start` or `START-BOX.cmd` to start missing services without replacing running instances. `node box.mjs` checks service health only. Default media source is `%USERPROFILE%\wanna-studio-server`; override with `BOX_MEDIA_ROOT`. The launcher never starts a public LIVE, changes a logged-in account, or kills existing services. An outdated phone gateway is reported rather than silently accepted.

## Integrated source

Mobile 1.2.0 includes dedicated chat, optional speech, direct/Tik.Tools transports and battle telemetry. Local cloud-stage helpers and Vardy ingest have been merged into the bundled source. The event hook runs after duplicate/streak checks; session lifecycle events are forwarded and the ingest worker closes with the workspace. Vardy remains opt-in through private env configuration.

The local deployment backs up replaced code under `wanna-studio-server/backups/box-*`. Env, keys, database, media and original local FX source are preserved. Media publishing uses CPU libx264 encoding. Studio's own hardware compatibility remains to be verified.

## Verified and outstanding

2026-11-13: 38 control tests and 41 merged mobile/stage/ingest tests passed. Live local HTTP and headless mobile-width checks verified the box landing page, version 1.2.0 and manager navigation. Effects, phone and control services are reachable.

Studio startup and phone browser opening were rejected by automatic approval review with `blocked by policy`. No native Studio connection, real phone camera permissions or public TikTok output were verified in this release. No RTMP destination is currently configured. Native battle controls remain in the local control panel; the phone's telemetry view does not create native battles independently.

The cloud foreground-set routes exist in the received Vardy ZIP; their consumer and playback acknowledgement are not yet connected to local automations. Fixed-domain HTTPS deployment remains outstanding integration work. Do not present this local box as a finished hosted client product.

## Hosted box integration, 2026-11-13

The paired phone gateway now serves the existing native Studio panel at `/mobile/studio`. Its backend forwards only the existing allowlisted state, invitation, battle and phone-room operations to the fixed loopback controller. Controller cookies stay inside the box; desktop focus and arbitrary RPC are excluded. Pairing, revocation and same-origin checks apply to phone requests. The gateway and native controller must run inside the same Windows box. This route is implemented and tested; it has not yet been deployed and exercised in the hosted Windows VM.

The same `/mobile/box` page includes a TikTok Studio account connection card. It relays only the QR currently rendered by the installed Studio login component and, when available, its original HTTPS TikTok approval link. It distinguishes loading, scan awaiting approval, expiry, connected account and unavailable Studio. A connected account requires controller identity as well as removal of the login screen. TikTok cookies remain in Studio's own Windows user profile; the gateway does not implement a second TikTok login or store copied cookies. Expired-QR refresh is restricted to the native refresh control and blocked during LIVE. These selectors were inspected in local Studio 1.39.6 source. Native QR delivery, same-phone approval and persistence across a hosted Windows restart still need real verification.

The existing Hetzner host is reachable over authenticated SSH. `BOOSTERA-WIN` is running with its assigned NVIDIA passthrough devices. The already deployed HTTPS camera page and LiveKit/token services respond normally. This confirms infrastructure health, not a working Windows Studio integration or GPU driver.

The camera token gateway source is preserved under `server-integration/camera-transport`. Its optional temporary publisher links use the existing `#connect=` browser flow, expire independently, and preserve the original publisher/viewer codes. These links authorize a camera publisher only; they do not authorize viewing or control of Studio. Temporary-link support was deployed to the existing Linux token service after isolated endpoint tests. Received video frames, Windows GPU/driver, Studio startup, camera input inside Windows and hosted TikTok battle operation still require verification.

The actual phone subsequently joined the configured LiveKit room as `phone-camera` and published one unmuted 720 x 1280 video track, with no audio track. This is server-side publication metadata; received/decode frame proof and Windows/Studio input are still unverified. The isolated console reached the Windows `boosteradmin` password screen. No password was read, changed or submitted. No Windows application was installed or started. A live guest-agent channel could not be added because this VM has no virtio-serial controller and libvirt rejects hot-plugging that controller; both attach attempts failed without changing the VM.

Current checks: 46 controller/account tests, 42 mobile tests and three isolated camera-token HTTP tests passed. The actual account card was also exercised in an isolated browser fixture for QR presentation, awaiting approval, connected identity, disconnected state and QR refresh, including a narrow viewport. Fixtures are synthetic and are not hosted TikTok authentication evidence.

## Public camera panel deployment

The Studio connection button is now deployed directly on the existing public camera page, not just the uninstalled Windows/mobile source panel. See `server-integration/camera-panel`. A real owner invitation, secure phone cookie, session persistence through a service restart, and logout were verified through the public HTTPS address. The account-only gateway reuses the existing pairing and Studio proxy classes and runs on the Linux host behind Caddy; the full media/native Studio runtime is still pending inside Windows. Its connection status accurately reports Studio preparation. Phone sessions can optionally persist as hashes on disk and retain the existing expiry. The actual TikTok account is not hardcoded and no native authentication success has been claimed.
