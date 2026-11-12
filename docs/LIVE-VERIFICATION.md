# Live verification — 12 November 2026

## Verified with two real owned accounts

The user ran one account in TikTok LIVE Studio and a second account on a phone, with microphones muted. These observations came from the authenticated native bridge, the running dashboard, and the original TikTok interfaces, separately from the synthetic test suite.

| Check | Observed result |
| --- | --- |
| Co-host connection | An invitation progressed from pending to succeeded; the second account was linked. |
| Co-host invitation from updated connector | The search adapter clicked the exact owned account's native Invite control. Studio recorded the operation, and phone acceptance established the connection. |
| Outgoing battle through running dashboard | Dashboard HTTP actions invoked mode selection and match.start; a new battle remained pending until phone acceptance, then changed to open / ONGOING. |
| Battle end and another round | The old battle cleared while Co-host remained connected. Later rounds received different battle IDs. |
| Withdrawal through updated controller | A new invitation was sent, its inviter scope was observed, and withdrawal cleared the battle while Co-host stayed linked. |
| Actual browser rendering | Headless Chromium opened the running dashboard with live data at a 390px viewport: active battle, two participants, no horizontal overflow or page errors. |
| Phone TikTok view | A user-provided screenshot showed the actual two-sided match, countdown, 0–0 score, and microphone mute state in native TikTok. The Studio side showed its virtual-camera image. |

Successful withdrawal was recorded at approximately 19:50 UTC. An earlier withdrawal attempt overlapped with phone acceptance and became an active battle; that attempt was not counted as successful cancellation. Incoming battle controls were observed, but acceptance and decline through the dashboard still have synthetic coverage only: the user manually accepted the incoming invitation before the automated action ran.

## Corrections found during the live test

1. Minimized Electron documents report hidden visibility while original controls can remain rendered. The adapter checks element visibility, enabled state, current room and session without activating the desktop window.
2. Studio serializes its candidate Map as a type/size marker. Candidate recovery now uses native cards tagged with UID and room ID, with fresh permission and button checks before dispatch.
3. Native search replaces the Friends tabs. The adapter recognizes search results and respects loading and non-clickable markers rather than dispatching another request.
4. Identical mode-selection screens recur between rounds. Previously, the duplicate-action cache could return an earlier click acknowledgement without clicking again. Revisions now change when the observed native phase or battle context changes; duplicate requests within an unchanged phase remain idempotent.
5. Studio can clear a completed battle directly instead of returning an intermediate ended object. The event feed now logs an end when the same live session returns to mode selection. Connection loss alone is not treated as a result.

Studio also reported a camera-only Co-host configuration error before successful play. Its scene had an Animaze camera, but the selected Co-host camera was null. During successful play, the native layout identified the selected camera source. No native Studio files or account permissions were modified to bypass this condition.

## RTMP result and correction

A separate bounded 15-second portrait test card with silent audio was sent to a phone-created TikTok destination. FFmpeg exited successfully with 375 output frames and approximately 758 KB written. Harmless FLV duration/filesize-header warnings had caused a false ENCODER_OR_DESTINATION_ERROR status.

RTMP output now uses no_duration_filesize, and final encoder status determines failure. A refused destination still fails and never confirms output. This transport test does not establish what a public viewer received.

## Remaining limits and runtime deployment

- The verified control path uses native LIVE Studio on the computer. It is not an independent mobile implementation of TikTok LIVE Studio.
- The separate mobile event reader still returned CONNECTION_FAILED_OR_SIGNING_REQUIRED with no battle data. The selected Studio account was inaccessible to an unauthenticated viewer because of account privacy. Native authenticated battle detection worked; public-reader failure did not mean the owner room was offline.
- Scores stayed at zero during observed matches. Real nonzero scoring, gift-triggered effects, and battle telemetry reaching the independent mobile app were not verified.
- Opponent audio/video inside the custom phone browser and effects delivered through the complete phone-to-TikTok battle path remain unverified. The supplied phone screenshot was from native TikTok.
- Updated source modules were tested directly for creator search and withdrawal. The running dashboard successfully dispatched a battle start, but has not loaded all later fixes. Automatic approval review rejected the control-server restart with "blocked by policy" and no more specific reason. The original mobile gateway likewise has not been updated. No alternate service was used to bypass those rejections.

The obsolete phone RTMP destination had been unlinked before selecting the native Studio owner account. Unlinking refuses an active RTMP broadcast and does not stop a Studio LIVE. After verification, the user was told that both test LIVEs could be ended; that instruction is not proof they have ended.

## Automated validation

- 38 root connector tests passed, including repeat-round cache invalidation, cancellation guards, native search, duplicate-action protection, session changes and safe phone unlinking.
- 21 mobile tests passed, including local RTMP/HLS decoding, FFmpeg progress and failed destinations.
- Browser regressions passed for native action fixtures, minimized and CSS-hidden controls, busy search results, dashboard layout, mobile effects composition, synthetic audio/recording, and battle telemetry rendering.

Runtime captures and account identifiers remain in ignored local files. Credentials, stream keys and personal screenshots are not included in the repository.
