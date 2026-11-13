# Existing hosted camera transport

This is the existing token gateway recovered from the running Hetzner camera service, extended to support expiring phone connection links. It reuses the deployed FastAPI/LiveKit stack and the camera page's existing `#connect=` handling. It does not start TikTok LIVE or replace the Windows Studio controller.

`server.py` runs as `server:create_app --factory` under the existing virtual environment. The private configuration path comes from `BOOSTERA_TRANSPORT_CONFIG`; production supplies it through a systemd credential. Do not copy that configuration, connection links, JWTs or provider credentials into this repository.

The optional `publisher_links` configuration list contains at most 16 objects with a SHA-256 `code_hash` and an integer `expires_at` in Unix seconds. A matching code can obtain publisher grants for the configured room until the earlier of the link expiry and global access expiry. Issued tokens retain the existing 15-minute maximum lifetime and cannot extend the link expiry. Viewer requests cannot use these links. Original publisher/viewer codes retain their behavior. Expiry stops further token issuance; an already established LiveKit connection is not forcibly disconnected when its access token expires.

Only the temporary code is put in the URL fragment. The existing browser code immediately removes the fragment from the address bar and keeps the code within that browser session. The fragment is not sent to the HTTP server. The code is submitted to the same-origin token endpoint only when the user explicitly starts publishing. The microphone remains off unless the user enables it.

Run the isolated endpoint checks using the existing transport environment:

```sh
/opt/boostera/transport/venv/bin/python -m unittest -v test_server.py
```

Tests start a temporary loopback token gateway with synthetic credentials. They verify legacy roles, temporary publisher scope, token expiry, wrong/expired codes and cross-origin rejection. They do not connect to a real room or publish media.

The deployment on 2026-11-13 backed up the existing service source and private configuration under `/root/boostera-backups/phone-link-*`, then restarted only `boostera-token`. The LiveKit, proxy and Windows VM were left running. Access links and service credentials remain outside the repository.
