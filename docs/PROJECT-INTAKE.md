# Client box project intake — 2026-11-13

Read-only intake. No deployments, service restarts, credential transfers or source moves performed.

## Sources received

- `C:\Users\shk\Downloads\vardy-verse-connect.zip`: 384 archive entries. TanStack Start / React application with Supabase integration. The archive contains `.env`; keep it private and do not publish the archive into a public repository.
- `C:\Users\shk\wanna-studio-server`: existing local effects/media/mobile server, package version 1.1.0. Contains newer cloud-stage and Vardy ingest work that is not yet merged with the public repository's mobile 1.2.0.
- Existing base: `wannaknow165/boostera-live-studio-web`, including Studio control modules and bundled mobile 1.2.0.

## Preliminary responsibility map

| Component | Placement | Evidence / integration |
| --- | --- | --- |
| Vardy creator dashboard, authentication, database, media library and creation | Shared services | ZIP architecture and application source |
| Cloud stage and foreground sets | Shared service; rendered per client session | `/stage`, `/api/public/stage/state`, `/api/public/sets/active`, `/api/public/sets/played` routes present in ZIP |
| Live event ingestion and durable receipts | Shared service | `/api/public/live/ingest` route and ingest rules/server modules |
| Studio and native battle/Co-host connector | Client box | Existing root `src/native-ui.mjs`, `src/battles.mjs` |
| Phone gateway, session media processing and output composition | Client box runtime, with phone-side camera renderer | Local `mobile-gateway.mjs`, `lib/mobile-broadcast.mjs`, `public/mobile`, `fx` |
| Master effects assets, creation and catalog | Shared responsibility; asset cache can live in box | Local effects server currently combines these with runtime functions; split by responsibility, preserve existing behavior |
| Vardy event forwarder | Client box adapter | Local `lib/vardy-ingest.mjs`, opt-in `VARDY_INGEST=1`, hook in `mobile-live-events.mjs` |
| Cloud wall URL integration | Client renderer / output | Local `fx/stage-url.js`, changes to `fx/index.html` and `fx/fx-engine.js` |

## Merge and verification requirements

1. Preserve local cloud integrations while merging mobile 1.2.0. Both sources modify `lib/mobile-live-events.mjs`.
2. Read actual foreground-set authorization and response contracts before implementing the consumer; routes already exist in the received archive.
3. Preserve private env, keys, databases, media and backups; exclude them from public commits and shared templates.
4. Verify one phone → composition → Studio → TikTok session before creating VM templates or a provisioning service.
5. Classification is based on source inspection, not proof that the cloud deployment or live endpoints currently work.
