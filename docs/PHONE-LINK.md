# Android room connection

This integration reuses the installed BOOSTERA Android key-creation application, its local companion backend, and the existing WANNA mobile gateway. It does not replace an APK, copy TikTok login cookies into the browser, or create a new streaming service.

## Existing services

- Android package: `com.fskhri.tiktokgeneratertmp`; verified installed version 1.1.22.
- Companion backend: `backend/server.js` in the existing BOOSTERA Studio project, listening locally on port 3101.
- The Android build uses loopback port 3102. For a USB connection, map the selected device's port 3102 to the computer's port 3101 with ADB reverse.
- Existing mobile gateway: `http://127.0.0.1:8801`.
- Browser control panel: `http://127.0.0.1:47831`.

Set `BOOSTERA_PHONE_CONNECTION_DIR` to the companion backend's `data/connection` directory if it is not located under `%USERPROFILE%/tikapi/boostera-studio`. Keep this directory private. The panel consumes its existing AES-GCM encrypted handoff using the companion's local key; neither file belongs in Git.

In the Android connection tab, create a TikTok room and wait for the companion's acknowledgement. In the updated browser panel, use the phone card to import the room. A running panel must load the updated server code for the new API routes to be available; do not restart services during an active broadcast.

The import uses the gateway's existing RTMP configuration endpoint. It rejects an active RTMP broadcast, handoffs older than 15 minutes, expired targets, tampered ciphertext, and conflicting room identifiers. Version 1.1.22 can omit the numeric room ID; the adapter recovers it from the validated TikTok share URL. Public status and receipts contain no stream key or share-link query values.

Importing prepares the destination only. Capture and broadcast controls remain separate. Existing microphone mute remains in force. Studio invitation and Match operations are blocked when its session belongs to a different room from the imported phone room; supplying a key does not initialize Studio's owner session or opponent media.

## Verification on 12 November 2026

- A real S21 Ultra running the existing app created a TikTok room. Its companion received the encrypted target, and the existing mobile gateway acknowledged the import.
- Android's `RECORD_AUDIO` app-op was `ignore`, confirming the chosen application's microphone was blocked.
- A bounded synthetic 15-second portrait test card used silent audio and no camera. The gateway accepted 17 chunks / 209182 bytes. Its final state was `stopped` with `ENCODER_OR_DESTINATION_ERROR`; this does **not** establish a successful public broadcast. The Android application subsequently returned to its create-room state after closing the test room.
- Public viewer verification and a real battle were not completed. Studio did not have an owner session attached to the phone-created room.
- The new adapter was exercised directly against the existing gateway. Loading the new routes in the running battle panel remained pending because automatic approval review rejected its restart. Automatic review also rejected opening the public viewer on the second phone; no detailed reason was provided.

Run `npm.cmd test` for the connector and handoff regressions, and `python test/battle-controls-browser.py` for the existing synthetic browser checks. These checks do not contact a live opponent and cannot establish TikTok battle delivery.
