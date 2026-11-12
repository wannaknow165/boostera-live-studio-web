# Public source validation

Verified on Windows with Node.js 24.16.0 on 12 November 2026, using this assembled public-source copy.

| Check | Result |
| --- | --- |
| Studio connector test suite | 19 passed |
| Mobile, workspace, TikTok event interpretation and generation tests | 15 passed |
| Mocked ADB phone-gate tests | 5 passed |
| Clean-copy application startup | Passed on separate local ports |
| Mobile camera, manager, viewer and pairing HTML | HTTP 200 |
| PWA metadata and icon | HTTP 200 |
| Local mobile session and original gallery | Passed |
| Gitleaks scan of prepared public files | No leaks found |

The test suite includes real local FFmpeg ingestion and playable HLS output. Phone processes and TikTok/provider interactions in unit tests are mocked. The startup check used an empty customer/media workspace and no provider credentials.

No real TikTok account connection, invitation delivery, live battle, paid generation, public RTMP broadcast or physical iPhone/Android test was performed during publication. Private source directories and running applications were left in place.
