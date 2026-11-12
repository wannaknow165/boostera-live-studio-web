# BOOSTERA LIVE Studio Web

Two existing applications in one repository: a browser control panel connected to the local TikTok LIVE Studio application, and the WANNA FX Mobile camera and effects app with its Node.js server.

## Applications

| Component | Location | Local address |
| --- | --- | --- |
| BOOSTERA LIVE Web | Repository root | http://127.0.0.1:47831/ |
| WANNA effects server | `server-integration/wanna-studio-server` | http://127.0.0.1:8800/ |
| WANNA FX Mobile camera | Same server directory | http://127.0.0.1:8801/mobile/ |
| Customer and automation manager | Same server directory | http://127.0.0.1:8801/mobile/manage |
| Processed stream viewer | Same server directory | http://127.0.0.1:8801/mobile/viewer |

## Quick start on Windows

Use Node.js 22 or newer. The Studio connector requires TikTok LIVE Studio on the same Windows machine. The mobile server uses pinned Windows FFmpeg packages; other operating systems need a separately adapted media-tool installation.

### Studio browser panel

From the repository root:

```powershell
node server.mjs --open
```

Or double-click `START.cmd`. No npm dependencies are required for this panel. Open the local debugging bridge and the Co-host panel using the instructions in [Studio connection guide](docs/STUDIO.md). Do not restart Studio during a broadcast.

The panel reads real Studio state and creator lists. Confirmed outgoing Co-host invitations use the creator's native Studio button. The Match panel also exposes native battle mode selection, invitation start, acceptance, decline and withdrawal when their original controls are loaded and enabled. Native clicks are reported as awaiting Studio; only an observed battle state can establish that a battle opened. Incoming Co-host invitations, automatic matching and opening the original panels still require Studio. This panel does not include video, audio, scores or a battle timer.

The connector reads state and invokes those controls through the existing local bridge without moving the mouse, typing on the user's keyboard or activating Studio. Studio can remain behind other windows. Minimized or hidden renderer documents are deliberately not actionable; keep Studio open without minimizing it. The explicit **Focus Studio** button is the only dashboard control intended to activate its window. Public battle delivery and opponent media still require a real two-creator test; local tests do not establish these outcomes.

### Mobile camera and effects

```powershell
cd server-integration/wanna-studio-server
npm.cmd ci
Copy-Item .env.example .env
Copy-Item server.env.example server.env
node start-mobile.mjs
```

Copy example configuration only during initial setup; retain existing local configuration on subsequent updates. The launcher starts the existing effects server and opens the mobile app. The example uses dry-run generation; provider features require local credentials and intentional configuration. The application is a PWA, not an Android APK. Access from another phone requires a reachable HTTPS origin and local pairing.

The mobile app includes camera/microphone capture, tracked overlays, customers, recipes, automation rules, recording, a processed stream viewer and optional provider-backed video jobs. Public TikTok event reception uses `tiktok-live-connector`. Creating a TikTok LIVE room, account invitations and battle-start operations are unavailable in the mobile app. Local RTMP video/audio works without LIVE Studio when an active destination is supplied; encoder output does not establish public TikTok visibility or battle control. See the [standalone audit](docs/STANDALONE-AUDIT.md).

## Source and media

The full application code, current frontend, tests, builder utilities, effect definitions and selected generic runtime assets are included. Existing application directories were preserved rather than rebuilt.

Private configuration, credentials, customer records, account/session state, personal images, downloaded reference recordings and the local media library are excluded from this public repository. See [Media and local data](docs/MEDIA-AND-LOCAL-DATA.md) for what to restore locally. A fresh clone will not contain the original user's media library or completed AI videos.

## Validation

```powershell
# Studio connector tests, from the repository root
npm.cmd test

# Mobile server tests
npm.cmd --prefix server-integration/wanna-studio-server test

# Additional ADB privacy tests with mocked phone processes
cd server-integration/wanna-studio-server
node --experimental-test-module-mocks --test test/phone-gate.test.mjs
```

These tests do not prove a real TikTok broadcast, successful delivery of a Co-host invitation, real battle control, or mobile-device performance. Run `npm.cmd run test:browser` in the mobile server directory for disposable local servers and synthetic-camera browser flows; Python Playwright and Chromium are required. The runner does not touch the existing running app or customer data.

## Documentation

- [מדריך קצר בעברית](docs/README-HE.md)
- [Studio connection and limits](docs/STUDIO.md)
- [Mobile app guide](server-integration/wanna-studio-server/MOBILE.md)
- [Effects server and APIs](server-integration/wanna-studio-server/README.md)
- [Studio upstream configuration](server-integration/wanna-studio-server/STUDIO-CONNECT.md)
- [Media and local data](docs/MEDIA-AND-LOCAL-DATA.md)

Public source availability does not deploy the application or enable internet access to a local server. The existing effects server must be reviewed and protected before external exposure. TikTok LIVE Studio and all provider services are separate products.
