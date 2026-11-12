## Mobile 1.2.0 — chat and event reader

The camera and management pages now share a dedicated chat feed (100 messages), activity feed, viewer/like/gift/follow/share counts, and optional speech for new messages. Speech starts disabled and does not change microphone mute. HTML in comments is displayed as text. Reconnecting to another account clears previous messages.

Event transport reuses the existing BOOSTERA Tik.Tools WebSocket adapter, extended with chat, social, subscription, emote, viewer counts, and managed battle/score events. Direct tiktok-live-connector remains available. Set TIKTOOLS_API_KEY locally or use the local page's event-provider settings. Secrets stay in ignored server data and never appear in public snapshots. Provider changes require disconnection first. No automatic paid subscription or provider connection is started.

Verification: 27 mobile server tests and all camera, manager, composition/HLS and chat/battle browser flows passed with controlled inputs. The separate root panel's 38 tests also pass. This does not establish real TikTok chat reception: no configured event-provider key was available during this release.

RTMP publishing uses the existing media backend and requires a fresh destination. Native battle invitations and acceptance without LIVE Studio still require an account write connector; event reception does not supply that capability. A phone browser plus this backend is not a standalone phone-only native TikTok client.

---

# WANNA FX Mobile 1.1
The mobile app lives inside server-integration/wanna-studio-server. It reuses the original engine, effect definitions, media, customer-video templates, stage events and automation rules. TikTok LIVE Studio is not required.

## Open and install
- Start start-mobile.cmd (or the WANNA FX Mobile desktop shortcut). The launcher starts the original effects server if it is offline and then opens the mobile app.
- First setup on another machine: install-mobile.cmd installs the pinned dependencies and starts the app.
- Camera: http://127.0.0.1:8801/mobile/
- Customer and server management: http://127.0.0.1:8801/mobile/manage
- Live server output: http://127.0.0.1:8801/mobile/viewer
- Local pairing: http://127.0.0.1:8801/mobile/pair
- Phones need a reachable HTTPS origin. iPhone: Safari → Share → Add to Home Screen. Android: Chrome → Install app. This is an installable PWA, not an APK.
- Pair using the one-use code from the local pairing screen. Codes expire after three minutes and sessions after twelve hours.

## Shared capabilities
| Feature | Application | Server |
| --- | --- | --- |
| Camera and mic, front/back switching | Local camera controls | Authenticated diagnostic samples |
| Face, eyes, body, hands and waist tracking | Original MediaPipe engine, visible debug landmarks | Original AR definitions served without Studio |
| Multiple faces | Up to four heads, choose a head by tap | Shared effect catalog |
| Customer profiles and avatars | Upload, edit, select customer | Atomic persistent storage |
| Custom overlays | Screen, face or body anchors; position, rotation, scale, opacity, duration, circle crop and looping | Stored recipes and commands to open cameras |
| Personal head in battle clips | Live camera head or customer avatar | Existing battle metadata, body tracks, masks and hit timings |
| Original AR effects and media | Dynamic catalog, including new effects added to the original panel | Existing catalog is reused, not copied into fixed demo data |
| Background plate | Capture empty room or upload a file | Shared asset files |
| Recording | Device-supported codec, download/share, microphone and effect-audio mix | Optional protected stream recording |
| Continuous video | Canvas plus audio sent as ordered MediaRecorder chunks | FFmpeg ingestion and HLS output or RTMP |
| Customer AI video | Choose customer photo, original AR transformation or a video template; select an available video model | Asynchronous OpenRouter/Kling jobs, status, costs, transparent conversion and saved result recipe |
| Automation rules | Original rules plus custom customer recipes; manual event test | Gift and battle event dispatch, delays and cooldowns |
| TikTok event input | Username connection, viewers, gifts, supporters and observed battle data | tiktok-live-connector 2.5.0; gift streak deduplication |
| RTMP | Start/stop sending processed camera output | Uses a configured account stream destination; keys stay on server |
| TikTok invitations / starting a battle | Explicit unavailable state | No verified account write adapter; endpoint returns 501 |

AI video generation takes time and runs in the background. Prepared clips and deterministic tracked overlays play in real time. Creating a new AI video does not happen frame by frame at camera frame rate.
Recording and broadcasting require keeping the web app active. Mobile hardware, permissions and codec performance must be checked on physical iPhone and Android devices. The quality selector sets a target up to 1080x1920 at 60 FPS; measured performance depends on the device and effect.

## Video generation and recovery
Existing OPENROUTER_API_KEY and KLING_API_KEY remain private in the server configuration. No key is sent to the browser.
OpenRouter's live video-model catalog is queried before submission. Supported first-frame, duration, resolution and aspect ratio values are checked.
Generation is initiated only by the user pressing the creation button with the provider-usage checkbox selected. No paid production job is submitted by the tests.
An accepted provider task ID is saved. After restart, accepted tasks are polled and downloaded without creating another paid task. Jobs interrupted before a provider task ID was saved are marked interrupted rather than automatically resubmitted.
Kling edits of an existing template require a reachable HTTPS URL for the provider to fetch the template. Its temporary media ticket is limited to that file. OpenRouter first-frame transformations send the selected avatar image directly and do not require public template hosting.

## TikTok connection limits
The community connector receives public live events and may require a signing-service key (SIGN_API_KEY). A successful SDK import is not evidence of a real live connection; the application shows connected only after connect() succeeds.
No creator username has been supplied for a real connection test. No account invitation or battle-start protocol is implemented. RTMP streaming does not establish TikTok co-host or battle control.
External exposure and remote source backup remain subject to tool approval. Local code and validation do not depend on them.

## Data and access
Paired devices have access to this creator workspace. Keep pairing codes private.
Only allowlisted effect assets and APIs are exposed. The original API and client keys are supplied internally to the existing server.
Customer data and RTMP destination are stored in data/mobile-workspace.json; uploads and generated results are in media/mobile. These folders are excluded from the source update package.
Diagnostic JPEG/audio buffers expire in memory. HLS stream directories are private to paired devices and are cleaned about thirty minutes after a stream ends.
RTMP stream keys and API credentials are excluded from public responses and source snapshots.

## Validation
    npm test
    python test/mobile-browser.py
    python test/workspace-browser.py
15 Node tests verify pairing/authentication, media restrictions, client/recipe persistence, custom gift rules, gift streak deduplication, battle state, API generation payloads, no-resubmit recovery and real FFmpeg output.
Browser tests use a separate Chromium with synthetic camera and microphone. They verify the live catalog, responsive layout, recording/download, server byte acknowledgements, customer creation, overlay editor, original automation rules, continuous processed-video upload and playback in a separate server viewer.
Tests do not contact a live TikTok room, open the real camera or spend generation credits.

## Source references
- Original engine and panels: fx/, public/, server.mjs and lib/.
- TikTok event connector: https://ttlc.docs.isaackogan.com/
- Battle event interpretation: https://ttlc.docs.isaackogan.com/guides/battles/
- Video generation API: https://openrouter.ai/docs/api/api-reference/video-generation/create-videos
- Video model catalog: https://openrouter.ai/docs/api/api-reference/video-generation/list-videos-models

The update package is for this existing effects server. Original private media and secret configuration must be retained separately. The complete application source is included under server-integration/wanna-studio-server.
