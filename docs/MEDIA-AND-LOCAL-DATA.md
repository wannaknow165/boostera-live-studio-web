# Media and local data

This public repository includes both application implementations. It intentionally omits user-specific state and private media. Restore those locally from an authorized installation when needed; do not commit them.

Within `server-integration/wanna-studio-server`:

| Local path | Purpose |
| --- | --- |
| `.env`, `server.env` | Provider credentials and local configuration; start from example files |
| `data/` | Customers, recipes, automation state, generation jobs and account configuration |
| `media/avatars`, `media/mobile`, `media/opponent` | Customer images, uploads and temporary opponent images |
| `media/templates`, `media/results`, `media/inbox`, `media/thumbs` | Video templates, completed jobs, imports and generated thumbnails |
| `media/battle`, `media/overlays`, `media/overlays.json` | Existing battle clip and overlay library, including placement metadata |
| `fx/incoming`, `public/tt` | Downloaded reference material and captured reference frames |
| `fx/effects/**/remix` | Customer-specific rendered effects |
| `runtime/` | Recordings, streams and temporary state |

Effect definitions and selected generic runtime assets are included. Reference videos and intermediate diagnostic images are not published. Some effects require the corresponding private reference video or original media files to be restored before their full animation or a new remix can run. A fresh installation can run the interfaces and tests with an empty customer and media library.

Keep all private state out of Git. Example configuration values are placeholders and do not grant access to any provider or account.
