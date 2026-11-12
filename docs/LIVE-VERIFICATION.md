# Live verification — 12 November 2026

## Verified against the real local Studio

The user selected the already authenticated Studio account and started its LIVE manually. The native connection reported a real owner room, `health: ready`, and allowed Co-host and battle capabilities. No account cookies or stream keys are included in this repository.

The investigation found two integration bugs that synthetic happy-path fixtures had missed:

1. Minimized Electron documents report `visibilityState: hidden` while their original controls remain rendered and enabled. The adapter now uses the actual element's visibility and enabled state, with fresh session checks, without activating the window or injecting desktop input.
2. Studio's bridge serializes its candidate `Map` as a type/size marker rather than entries. The adapter now reads the original renderer's explicitly tagged candidate cards (`data-cohost-candidate`, UID and room ID). The controller requires current-session permission and rechecks the native button before any invitation. Explicit denials are still rejected.

Real observations confirmed an active room and eligible suggested creators through this background path. Four Quick Co-host requests observed during the test were cancelled; they were not treated as completed connections or battles. At 19:30 UTC, the native snapshot stopped reporting an owner room and returned to `initializing`, with no linked partner or battle. The microphone remained muted and disabled. A real two-party battle, opponent video in the phone browser, and end-to-end phone battle control remain unverified.

An unauthenticated browser viewing the selected Studio account received TikTok's private-account message and no video. The native authenticated connection was used to verify its owner room. External event-reader failure must not be interpreted as proof that the native LIVE is offline.

## RTMP result and correction

A bounded 15-second synthetic portrait card with silent audio was sent to the phone-created TikTok destination. The encoder exited successfully, reporting 375 output frames and approximately 758 KB written. Its only diagnostics were FLV duration/filesize-header warnings, which occur when a stream cannot seek backwards. These warnings had caused the generic `ENCODER_OR_DESTINATION_ERROR` status.

RTMP output now sets `no_duration_filesize`; final encoder status, rather than a substring in a harmless warning, determines failure. A refused destination still fails and never confirms output. This transport evidence does not establish what a public viewer received.

## Account selection and runtime state

The phone-created room and the selected Studio owner account differed. The obsolete phone destination and binding were explicitly unlinked before continuing with the selected Studio account. Unlinking refuses an active RTMP broadcast and does not stop a native Studio LIVE.

Code changes were tested independently of the active stream. Updating the already running control server remained pending: automatic approval review rejected its restart, without a detailed reason. Do not restart Studio or broadcast services during a live user session.

## Validation

- All 35 root connector tests passed, covering room/session changes, duplicate actions, native candidate recovery, explicit permission denial, encrypted phone handoff and safe unlinking.
- Browser regressions use the actual dashboard assets and rendered native-control fixtures, including minimized-document behavior and CSS-hidden controls.
- All 21 mobile tests passed. Mobile tests and browser flows cover actual local RTMP/HLS decoding, FFmpeg progress, failed destinations, muted/recorded synthetic audio, effects composition and battle telemetry rendering.

Local and synthetic tests are evidence for their specific code paths, not proof of a real battle or an independently hosted mobile replacement for TikTok LIVE Studio.
