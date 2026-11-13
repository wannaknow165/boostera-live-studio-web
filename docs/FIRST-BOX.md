# First local client box

The first box reuses the existing Windows installation, TikTok LIVE Studio, local media/effects server and control panel. This is a local single-client runtime, not a virtual machine or a multi-client security boundary.

## Entry points

- Box manager: http://127.0.0.1:8801/mobile/box
- Phone camera/effects/chat: http://127.0.0.1:8801/mobile/
- Full manager: http://127.0.0.1:8801/mobile/manage
- Local phone pairing setup: http://127.0.0.1:8801/mobile/pair
- Native Studio controls: http://127.0.0.1:47831/

These loopback addresses are for the computer. A phone needs a reachable HTTPS gateway with pairing, or an explicitly configured USB reverse connection. They are not public phone links.

Run `node box.mjs --start` or `START-BOX.cmd` to start missing services without replacing running instances. `node box.mjs` checks service health only. Default media source is `%USERPROFILE%\wanna-studio-server`; override with `BOX_MEDIA_ROOT`. The launcher never starts a public LIVE, changes a logged-in account, or kills existing services. An outdated phone gateway is reported rather than silently accepted.

## Integrated source

Mobile 1.2.0 includes dedicated chat, optional speech, direct/Tik.Tools transports and battle telemetry. Local cloud-stage helpers and Vardy ingest have been merged into the bundled source. The event hook runs after duplicate/streak checks; session lifecycle events are forwarded and the ingest worker closes with the workspace. Vardy remains opt-in through private env configuration.

The local deployment backs up replaced code under `wanna-studio-server/backups/box-*`. Env, keys, database, media and original local FX source are preserved. Media publishing uses CPU libx264 encoding. Studio's own hardware compatibility remains to be verified.

## Verified and outstanding

2026-11-13: 38 control tests and 41 merged mobile/stage/ingest tests passed. Live local HTTP and headless mobile-width checks verified the box landing page, version 1.2.0 and manager navigation. Effects, phone and control services are reachable.

Studio startup and phone browser opening were rejected by automatic approval review with `blocked by policy`. No native Studio connection, real phone camera permissions or public TikTok output were verified in this release. No RTMP destination is currently configured. Native battle controls remain in the local control panel; the phone's telemetry view does not create native battles independently.

The cloud foreground-set routes exist in the received Vardy ZIP; their consumer and playback acknowledgement are not yet connected to local automations. Fixed-domain HTTPS deployment and authenticated remote native-control routing remain separate outstanding integration work. Do not present this local box as a finished hosted client product.
