# Standalone broadcast audit — 12 November 2026

The mobile browser app can compose camera, audio and effects and publish through its local Node/FFmpeg server without running TikTok LIVE Studio. **It does not currently create a TikTok LIVE room, obtain an ingest key, invite a co-host or start a TikTok battle. A public TikTok broadcast has not been verified.**

## Verified behavior

- Real local RTMP receiver: H.264 video and AAC audio, over seven seconds of decoded media, with no LIVE Studio dependency.
- Refused RTMP destination: failed status, no output confirmation, no access-bearing destination in the status response.
- Real FFmpeg HLS output and playback in a second browser page while camera composition continues.
- Automated Chromium browser flows with synthetic camera and microphone: responsive layout, canvas frames, audio upload/echo, downloadable recording, microphone mute, tracking-engine initialization, quick effect commands, customer avatar upload, saved overlay composition, manager and viewer, and stop/cleanup.
- Browser tests use disposable workspaces, separate ports, no provider credentials and a generated blue battle-video fixture. They do not certify the private media library, facial tracking accuracy on a real person, physical phone behavior, or TikTok event delivery.
- Root connector tests: 19 passed. Mobile/workspace/event/generation/broadcast tests: 17 passed. Mocked phone-gate tests: 5 passed. Provider and account operations in unit tests are mocked.

## Fixes

The encoder now starts in `starting`. Accepted input bytes do not mark a broadcast as active output. `running` and `outputConfirmed` require FFmpeg progress with encoded frames and advancing output time. This verifies encoder output; only checking the destination/player can verify downstream reception or public visibility.

The camera UI waits for output confirmation, polls status, stops on server failure and preserves the failure message. Failed startup releases its recorder/stream. Repeated clicks during startup no longer start duplicate sessions. Shutdown waits for the encoder to finish. Stalled input/output is stopped after 60 seconds; the previous unconditional one-hour cutoff was removed.

The manager explicitly reports that account-level LIVE creation is unavailable. Event reception is shown connected only when the connector actually connects. Gift totals are labeled as donors during the current connection, not current-battle leaders.

## Remaining prerequisites and limits

1. A valid active RTMP/RTMPS destination for the account, and a verified way to create/start the account's LIVE room. The local workspace had no configured destination at audit time. An existing browser login alone does not supply these to the app.
2. An authorized account-write integration for co-host invitations and battle creation. The mobile app currently returns `ACCOUNT_WRITE_CONNECTOR_REQUIRED` for those operations. The separate root Studio bridge still depends on LIVE Studio.
3. A real-session test covering public video/audio, gifts/comments, battle events, disconnect/recovery and sustained operation. No public stream was started in this audit.
4. The camera browser page and local Node server must stay running. This is not unattended headless hosting; browser background suspension and reconnection after account/network failure remain unverified.
5. Paid generation needs provider configuration and separate real-provider verification. No paid generation was requested during this audit.

## Reproduce

In `server-integration/wanna-studio-server`, install the locked npm dependencies. Unit/integration tests:

```powershell
npm.cmd test
node --experimental-test-module-mocks --test test/phone-gate.test.mjs
```

For browser flows, use Python with Playwright and its Chromium installed, then:

```powershell
node test/run-browser.mjs
```

The runner reserves ports 18880/18881, copies source into a disposable directory, generates its fixture, starts only its own servers, and saves results/screenshots under `runtime/browser-audit`. It refuses occupied ports. Set `PYTHON` to the interpreter path if needed. Do not point the individual mutating Python tests at a production workspace.
