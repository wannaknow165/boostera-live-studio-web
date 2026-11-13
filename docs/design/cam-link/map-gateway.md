# MAP: gateway

# Gateway map: wanna-studio-server 1.2.0 (read-only audit)

Abbreviations (all under `C:\My Web Sites\boostera-live-studio-web\server-integration\wanna-studio-server\`):
GW = `mobile-gateway.mjs`, WS = `lib\mobile-workspace.mjs`, BC = `lib\mobile-broadcast.mjs`, SS = `lib\mobile-session.mjs`. OLD = `C:\Users\shk\wanna-studio-server\`.

## 0. State checked
- Repo branch `integration/stage-and-ingest`, HEAD `b03aa14`, working tree clean. Package `wanna-fx-mobile` 1.2.0, ESM. Node on this machine: v24.16.0.
- OLD vs repo (CR-insensitive diff): `start-mobile.mjs`, `lib/mobile-session.mjs`, `lib/mobile-tools.mjs`, `lib/env.mjs`, `server.mjs`, `lib/fx-routes.mjs`, `fx/fx-engine.js`, `fx/stage-url.js` are identical. `mobile-gateway.mjs` differs in exactly three places (OLD L41-42 CORS hunk; repo L67 allow-list adds `battle.js`,`chat.js`; repo L79 session payload/version). `fx/index.html` differs only in the two `useServer` hunks.
- Observed live, not touched: port 8800 listens on `::` (`node server.mjs`); port 8801 listens on `127.0.0.1` (`node mobile-gateway.mjs --open`, so no tunnel and no public URL now); no cloudflared process running; `C:\Program Files (x86)\cloudflared\cloudflared.exe` exists.
- Not read: `.env`, `server.env`, `data/*.json`. `.env.example` was blocked by permission settings.
- No WebRTC, `iceServers`, `/api/live` or `Authorization`-header handling exists anywhere in the repo.
- Statements marked "(Node source)" come from reading Node v24.16.0's embedded lib source; they were not executed.

## 1. Request pipeline of createMobileGateway (GW L38-116)
Order of checks:
1. L39-40, global headers on every response (set with `res.setHeader`, so they merge into later `writeHead` calls, including proxied responses):
   - `res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');`
   - `res.setHeader('Permissions-Policy','camera=(self), microphone=(self), display-capture=(self)');`
2. L42: `const url=new URL(req.url,'http://gateway'),p=decodeURIComponent(url.pathname);` Gateway routes match decoded `p`; the workspace matches raw `url.pathname`. A malformed `%` sequence throws and becomes 500 `REQUEST_FAILED`.
3. L43, origin check, before any routing: `if(['POST','PUT','DELETE'].includes(req.method)&&!sameOrigin(req))return send(res,403,{error:'ORIGIN_REJECTED'});`
   - L26: `function sameOrigin(req){if(req.headers['sec-fetch-site']==='cross-site')return false;const o=req.headers.origin;if(!o)return true;try{const origin=new URL(o);return origin.host===req.headers.host||origin.origin===publicUrl;}catch{return false;}}`
   - No `Origin` header (Node fetch, curl) passes. `Origin: null` is rejected. GET requests are never origin-checked.
4. L44: `if(req.method==='OPTIONS'){res.writeHead(405);return res.end();}` Every CORS preflight fails.
5. L45: `if(await workspace.publicMedia(req,res,url))return;` Public, ticket-in-path media (see section 2).
6. L46: `/` returns 302 to `/mobile/`.
7. L47-53: local-only setup routes. L54-60: public pairing.
8. L61-73: static `/mobile/*`, public.
9. L74, auth gate: `const session=auth(req);if(!session)return send(res,401,{error:'PAIRING_REQUIRED'});`
10. L75: `if(await workspace.handle(req,res,url,session))return;`
11. L76-113: `/api/mobile/*` routes and proxies. L114: `return send(res,404,{error:'NOT_FOUND'});`
12. L115: `catch(e){if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'REQUEST_FAILED'});else res.end();}`

Today `/api/live/*` returns 401 `PAIRING_REQUIRED` for a remote caller and 404 `NOT_FOUND` for a local or paired one.

Other headers:
- Cache-Control: JSON `'Cache-Control':'no-store'` (L24); static `'Cache-Control':name==='sw.js'?'no-cache':'no-cache'` (L69, both branches the same); proxy `safe['Cache-Control']='private, max-age=0'` (L32).
- CSP, only on static `/mobile/*` files (L71): `'Content-Security-Policy':"default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"`
- Static files also get `'Service-Worker-Allowed':'/mobile/'`.
- X-Frame-Options: not found anywhere in the gateway. Framing is limited only by `frame-ancestors 'self'` on static files.
- `Access-Control-*`: not found in the repo gateway. No HSTS, COOP, COEP or CORP.

Static resolution (L61-73):
- Aliases: `let name=p==='/mobile/'?'index.html':p.slice('/mobile/'.length);` then `if(name==='pair')name='pair.html';`, `if(name==='manage'||name==='manage/')name='manage.html';`, `if(name==='viewer'||name==='viewer/')name='viewer.html';`
- `pair.html` is local-only: 403 `LOCAL_SETUP_ONLY`.
- Strict allow-list (L67): `['index.html','pair.html','app.js','app.css','manage.html','manage.js','workspace.css','render.js','battle.js','chat.js','audio.js','viewer.html','viewer.js','pair.js','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png','icon.svg']`, otherwise 404.
- `/mobile/live` and `/mobile/live.html` both return 404 today. To serve `/mobile/live` you need an alias line plus `live.html` and its script/style files in the allow-list, and the files in `public\mobile\`.
- Extension map (L10) has only `.html .js .css .json .webmanifest .png .svg`; anything else is `application/octet-stream`.
- Traversal guard is the allow-list itself (exact names, no slashes), then `path.join(mobileDir,name)` and `fs.existsSync`.
- `mobileDir=path.join(ROOT,'public','mobile')` (L21) uses `ROOT` from `lib/env.mjs`, not `workspaceRoot`.
- No method check, no ETag, query string ignored (so `/mobile/live?t=...` maps to the same file).
- Service worker (`public\mobile\sw.js` L1,4) only intercepts same-origin GETs whose path is in `SHELL`; cache name `wanna-fx-mobile-v5`.

Helpers and size limits:
- GW L24 `send(res,status,data)`: writes JSON with `no-store` and `nosniff`; returns undefined.
- GW L13 `async function body(req,max=4096)`: throws `BODY_TOO_LARGE` with status 413.
- GW L14 `jsonBody(req)`: requires `content-type` starting `application/json` (else 415 `JSON_REQUIRED`); calls `body(req)` with the default, so the cap is 4096 bytes; bad JSON gives 400 `INVALID_JSON`.
- Explicit gateway caps: frame `body(req,512*1024)` (L82), audio `body(req,1024*1024)` (L94).
- WS L21 `async function read(req,max=16384)`; WS L22 `json(req)` uses `read(req,262144)` (256 KiB) with the same 415/400 rules.
- WS explicit caps: templates and upload `64*1024*1024`, images 8 MiB, broadcast chunk `8*1024*1024`.
- WS L32 `send(...)` is the same as the gateway's but returns `true`.

## 2. Authentication
- GW L11: `export function localRequest(req,port){return['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&!req.headers['cf-connecting-ip']&&!req.headers['x-forwarded-for']&&['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host);}`
  - `port` is the option passed to `createMobileGateway`, not the real listening port.
  - Requests through cloudflared carry `Cf-Connecting-Ip` and a different Host, so they are non-local.
- GW L25: `function auth(req){return localRequest(req,port)?localSession:sessions.get(cookies(req).wm_sid);}`
- localSession (GW L23): `const localSession={id:'local-desktop',label:'המחשב',frames:0,bytes:0,audioTests:0};` One shared object for every loopback request; no cookie, no expiry. WS uses `session.id==='local-desktop'` to gate provider setup (WS L119-121).
- Sessions (SS), all in memory and lost on restart:
  - L3: `constructor({now=Date.now,ttl=12*60*60*1000}={})`.
  - `issue()` (L4): 8-digit code, TTL 180000 ms, `this.codes.clear()` so only one code is valid at a time, stored as SHA-256. Returns `{code,expiresAt}`.
  - `pair(code,label,ip)` (L6-14): attempts entry `{count:0,until:now+60000}`; `count>=8` in the window throws `TOO_MANY_ATTEMPTS`; a bad or expired code throws `INVALID_PAIRING_CODE`; `this.sessions.size>=12` throws `DEVICE_LIMIT`. The code is one-use.
  - Session object: `{id:<12 hex>,label:<=60 chars,at,expiresAt:now+ttl,frames:0,bytes:0,audioTests:0}`, stored under `sha256(token)`; token is 64 hex chars.
  - `get(token)` (L15) requires `/^[a-f0-9]{64}$/`, returns null when expired, updates `s.at`. Expiry is fixed, not sliding.
- Cookie (GW L57): `'wm_sid='+pair.token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(secure?'; Secure':'')`, where `secure=Boolean(req.headers['cf-connecting-ip']||req.headers['x-forwarded-proto']==='https')`. Logout (L76) sets `Max-Age=0`.
- Pair errors (L59): `send(res,e.message==='TOO_MANY_ATTEMPTS'?429:401,{error:e.message})`.
- Public routes: everything before L74, i.e. the generation-media ticket URL, `/`, `POST /api/mobile/pair`, and static `/mobile/*` except `pair.html`.
- Local-only: `POST /api/mobile/pairing-code`, `GET /api/mobile/public-url`, `/mobile/pair`, `PUT /api/workspace/tiktok/provider`.
- Existing ticket precedent (WS L34, L59, L76): `tickets=new Map()`; `token=crypto.randomBytes(24).toString('hex')`; `tickets.set(token,{file:...,expires:Date.now()+75*60000})`; matched by `/^\/api\/workspace\/generation-media\/([a-f0-9]{48})$/`. Raw token is the map key (not hashed), GET only, deleted only on job success.

## 3. Dispatch to the workspace, and all routes
- WS L77-78: `async function handle(req,res,url,session){const p=url.pathname;if(!p.startsWith('/api/workspace/'))return false;`
- It returns true when handled, and ends with `send(res,404,{error:'WORKSPACE_ROUTE_NOT_FOUND'})` (L144).
- `session` is the object from `auth()`. Only `session.id` is used: as the broadcast `owner`, and for the local-desktop gate.
- Error convention (WS L11): `const fail=(code,status=400)=>Object.assign(Error(code),{status});`. It is thrown, and GW L115 turns it into `{error:'CODE'}` with that status. BC throws `Object.assign(Error('CODE'),{status})`.
- `createWorkspace` returns `{handle,publicMedia,config,live,broadcasts,db,setPublicUrl,close}` (WS L148).

Gateway routes (GW):

| Line | Method | Path | Auth | Purpose |
|---|---|---|---|---|
| L45 | GET | `/api/workspace/generation-media/<48 hex>` | public ticket | template MP4 for the video provider |
| L46 | any | `/` | public | 302 to `/mobile/` |
| L47 | POST | `/api/mobile/pairing-code` | local only | `{code,expiresAt,publicUrl}` |
| L51 | GET | `/api/mobile/public-url` | local only | `{publicUrl}` |
| L54 | POST | `/api/mobile/pair` | public, rate-limited | sets `wm_sid`; `{ok,device:{id,label}}` |
| L61 | any | `/mobile/`, allow-listed files, aliases `pair`/`manage`/`viewer` | public (`pair` local) | PWA static |
| L76 | POST | `/api/mobile/logout` | session | revoke and clear cookie |
| L77 | GET | `/api/mobile/session` | session | status, `version:'1.2.0'` |
| L81 / L89 | POST / GET | `/api/mobile/frame` | session | diagnostic JPEG/PNG, 512 KiB, one per 200 ms; echo within 30 s |
| L93 / L98 | POST / GET | `/api/mobile/audio-test` | session | 1 MiB; echo within 60 s |
| L99 | GET | `/api/mobile/catalog` | session | proxy to `/api/catalog` |
| L100 | GET | `/api/battle` | session | proxy to `/api/battle` |
| L101 | GET | `/api/mobile/effects` | session | proxy to `/fx/effects/index.json` |
| L102 | GET | `/api/mobile/events` | session | proxy to `/api/stage-events` (SSE) |
| L103 | POST | `/api/mobile/screen` | session | validated, proxy POST `/api/screen` |
| L108 | POST | `/api/mobile/overlay` | session | id `/^[\w.-]{1,100}$/`, proxy POST `/api/overlay/play` |
| L112 | POST | `/api/mobile/stop` | session | proxy POST `/api/desk/stop` |
| L113 | GET | any path passing `validMediaPath(p)` (L15-19) | session | proxy same path and query, Range validated |

Workspace routes (WS, all behind the L74 session gate):

| Line | Method | Path | Purpose |
|---|---|---|---|
| L79 | GET | `/api/workspace/video-models` | model list |
| L80 | GET | `/api/workspace/config` | `config()` |
| L81 | GET | `/api/workspace/overview` | config, clients, recipes, jobs, templates, avatars, `broadcasts.list()` |
| L82 / L86 | POST / DELETE | `/api/workspace/clients` and `/clients/:id` | customers |
| L87 / L92 | POST / DELETE | `/api/workspace/templates` and `/templates/:id` | raw MP4 up to 64 MiB, forwarded upstream |
| L93 | POST | `/api/workspace/upload` | image or video upload |
| L99 / L100 | POST / DELETE | `/api/workspace/recipes` and `/recipes/:id` | overlay recipes |
| L101 | GET | `/api/workspace/commands?after=N` | short-poll command ring (last 40) |
| L102 | POST | `/api/workspace/play` | push a recipe command |
| L103 | POST | `/api/workspace/generate` | paid job, 202 |
| L109 / L110 | GET / PUT | `/api/workspace/automations` | rules, up to 200 |
| L117 | POST | `/api/workspace/test-event` | synthetic event |
| L118 | GET | `/api/workspace/tiktok` | `live.snapshot()` |
| L119 / L120 | GET / PUT | `/api/workspace/tiktok/provider` | PUT is local-desktop only |
| L125 / L126 | POST | `/api/workspace/tiktok/connect`, `/disconnect` | event connection |
| L127 | any | `/api/workspace/tiktok/invite`, `/start-battle` | 501 |
| L128 | PUT | `/api/workspace/rtmp` | `{url,key}` or `{clear:true}` |
| L134 | POST | `/api/workspace/rtmp/import` | reads the file named by `RTMP_IMPORT_FILE` |
| L135 | POST | `/api/workspace/broadcast/start` | `{mode,mime}`, 201 |
| L136-140 | POST / POST / GET | `/api/workspace/broadcast/<24 hex>/chunk`, `/stop`, `/files/<name>` | chunk needs `x-sequence`, max 8 MiB; file GET has no owner check |
| L142 / L143 | GET | `/api/workspace/costs`, `/balance` | costs |

Other server-side caller: `C:\My Web Sites\boostera-live-studio-web\src\phone-link.mjs` L40-41 hard-codes `mobileOrigin='http://127.0.0.1:8801'` and calls `GET /api/workspace/overview` and `PUT /api/workspace/rtmp`.

## 4. Long-lived responses and timeouts
- There is no long-poll and no WebSocket server in the gateway. `ws` is used only as a client in `lib/tiktools-connection.mjs`.
- The only streaming response is the proxied SSE, `GET /api/mobile/events` (GW L102) through `proxy()` (L27-37):
  - Only `content-type`, `content-length`, `content-range`, `accept-ranges` are forwarded.
  - `res.writeHead(reply.statusCode||502,safe);reply.pipe(res);res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});`
  - `upstream.setTimeout(target==='/api/stage-events'?180000:20000,()=>upstream.destroy());`
  - `upstream.on('error',()=>{if(!res.headersSent)send(res,502,{error:'EFFECTS_SERVER_UNAVAILABLE'});else res.end();});`
- The upstream SSE writer (`server.mjs` L335-336): `res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });` then `res.write(...); stageClients.add(res); req.on('close', () => stageClients.delete(res));`. It pushes only on stage change (L149) and has no heartbeat.
- Likely latent bug (Node source): after 180 s of silence `upstream.destroy()` runs, the client request emits no `error` once a response exists, and `pipe()` ends the destination only on source `end`. The phone's EventSource is left open but dead.
- Reference pattern for a long-lived response (`lib\fx-routes.mjs` L162, L168): `res.writeHead(200, {...}); res.flushHeaders();` and cleanup in `res.on('close', ...)`. `fx\serve.mjs` L25 comments: `// res, not req: req 'close' fires right after a GET is read in Node 24`.
- Polling that exists: `/api/workspace/commands?after=N`; `viewer.js` polls `/api/workspace/overview` every 4 s; `pair.js` polls `/api/mobile/public-url` every 4 s.
- Server timeouts: none are set in code. Measured Node v24.16.0 defaults: `requestTimeout=300000`, `headersTimeout=60000`, `keepAliveTimeout=5000` (plus `keepAliveTimeoutBuffer=1000`), `timeout=0`, `connectionsCheckingInterval=30000`.
- None of these bounds response time, so a 25 s long-poll is safe from the server. What can cut it: `proxy()`'s 20 s upstream timeout if it is routed that way, client `AbortSignal.timeout` values (the code base uses 1.5 to 20 s), and the 2 s hard exit on shutdown (GW L136).

## 5. Broadcasts (BC) in 1.2.0, and changes from OLD
- States: `starting`, `running`, `stopping`, then `stopped` or `failed`. L5: `const active=s=>s.state==='starting'||s.state==='running';`
- A stream is `starting` (L21) until ffmpeg progress shows more frames with `out_time_us>0` (L23), which sets `outputConfirmed`, `outputFrames`, `lastOutputAt` and state `running`.
- Exit (L32): `s.state=code===0&&!s.error?'stopped':'failed'`; non-zero exit sets `ENCODER_OR_DESTINATION_ERROR` or `ENCODER_STOPPED`. Spawn failure gives `FFMPEG_UNAVAILABLE`.
- Limits:
  - Concurrency (L15): `filter(s=>active(s)||s.state==='stopping').length>=2` gives 409 `BROADCAST_LIMIT`.
  - Timer every 10 s (L9): `active(s)&&Date.now()-s.lastChunkAt>60000` stops with `INPUT_TIMEOUT`; `active(s)&&Date.now()-(s.lastOutputAt||s.startedAt)>60000` stops with `OUTPUT_TIMEOUT`; stopped or failed streams are deleted after 1800000 ms.
  - `SESSION_LIMIT` does not exist in 1.2.0. It is only in OLD L8: `Date.now()-s.startedAt>3600000`.
  - `append` (L35-46): owner mismatch 404 `BROADCAST_NOT_FOUND`; wrong sequence 409 `SEQUENCE_MISMATCH`; identical retry of one of the last 8 chunks returns `repeated:true`; concurrent write 429 `BACKPRESSURE`; chunk empty or over 8 MiB 413.
  - `stop` (L47-51): `stdin.end()`, kill after 6 s.
  - `file()` (L52) allows only `live.m3u8`, `init.mp4`, `part-N.m4s`, `recording.mp4`.
- Modes `preview|rtmp|record`; mime must match `/^video\/(mp4|webm)(;|$)/`.
- ffmpeg args (L18-20):
  - base: `['-hide_banner','-loglevel','warning','-nostats','-progress','pipe:1','-y','-analyzeduration','1000000','-probesize','1000000','-i','pipe:0','-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-r','30','-g','60','-b:v','2500k','-c:a','aac','-b:a','128k']`
  - preview: `['-f','hls','-hls_time','2','-hls_list_size','6','-hls_flags','delete_segments+independent_segments','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename','part-%06d.m4s','live.m3u8']`
  - record: `['-movflags','+faststart','recording.mp4']`
  - rtmp: `['-f','flv','-flvflags','no_duration_filesize',destination]`
  - spawn options: `{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe']}`
- View (L11): `{id,mode,state,mime,bytes,sequence,startedAt,lastChunkAt,outputConfirmed,outputFrames,lastOutputAt,error,playback}`.
- Changes from OLD (`C:\Users\shk\wanna-studio-server\lib\mobile-broadcast.mjs`):
  - Initial state was `running`; it is now `starting`.
  - The limit counted only `running`.
  - No `-nostats -progress pipe:1`; stdout was ignored.
  - No `-flvflags no_duration_filesize`.
  - Any stderr text matching `/Error|Invalid|failed|not found|denied/i` set the error immediately and the last 2000 characters were exposed as `diagnostic`. Now only a boolean is kept and it is applied at exit.
  - No `OUTPUT_TIMEOUT`; it had the 1 h `SESSION_LIMIT`.
  - `close()` did not wait for encoders. It now awaits `s.ended` for every active or stopping stream (L53).

## 6. Constructing the gateway in tests
- GW L20: `export function createMobileGateway({port=8801,upstreamPort=8800,clientKey='',apiKey='',env={},workspaceRoot=ROOT,workspaceOptions={},sessions=new MobileSessions()}={})`
- GW L119 returns `{server,sessions,workspace,setPublicUrl(value){...},getPublicUrl:()=>publicUrl}`. It does not listen. The main block is guarded (L121), so importing is safe.
- There is no `root`, static-dir, clock or spawn option at gateway level. What can be injected:
  - `sessions`: `new MobileSessions({now,ttl})`.
  - `workspaceOptions`, spread last into `createWorkspace` (GW L22). WS L24 accepts `liveFactory` (fake TikTok connector) and `tools` (for example `{ffmpeg:'not-used',installed:false}`).
  - `Broadcasts` takes `spawnProcess` (BC L7), but `createWorkspace` does not pass it through (WS L46); the broadcast tests build `Broadcasts` directly.
  - `env` is a plain object; the gateway only forwards it to the workspace.
- Harness pattern (`test\mobile.test.mjs` L38-53, `test\workspace.test.mjs` L20-24):
  - Fake upstream on port 0; probe a free port with `net.createServer`; `createMobileGateway({port,upstreamPort:upstream.address().port,...})`; `app.server.listen(port,'127.0.0.1')`.
  - A remote phone is simulated with headers `{host:'phone.example','cf-connecting-ip':'203.0.113.5'}`; no extra headers means local-desktop.
  - Teardown: `await new Promise(r=>app.server.close(r))`.
- `workspace.test.mjs` uses a temp `workspaceRoot` and a `tools` stub. `mobile.test.mjs` uses the real `ROOT` workspace and lets `configureMediaTools` change `process.env`.
- No-socket style exists only for the studio routes (`test\phone-gate.test.mjs` L36-46: fake `req`/`res` objects passed to `handle`).
- Fake-clock precedent: `createVardyIngest({now,timers,...})` (`lib\vardy-ingest.mjs` L110) with the hand-made clock in `test\vardy-ingest.test.mjs` L15-21.
- `package.json` L8 lists test files explicitly. `phone-gate.test.mjs` is not in the list.
- Browser tests: `test\run-browser.mjs` copies the project to a temp dir, uses ports 18880 and 18881, and runs Playwright Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required` (`test\mobile-browser.py` L15).

## 7. start-mobile.mjs, env loading, stop
- `start-mobile.mjs` L6: `port=Number(process.env.MOBILE_PORT)||8801,upstreamPort=Number(env.PORT)||8800`. L7: `configureMediaTools(root)` sets `process.env.FFMPEG`, `FFPROBE`, `PATH`.
- L9-14: if `http://127.0.0.1:<upstreamPort>/health` fails (1.5 s timeout), it spawns `node server.mjs` (`stdio:'ignore',windowsHide:true`), polls 24 times at 500 ms, else prints `EFFECTS_SERVER_UNAVAILABLE` and exits 1.
- L15-18: if `GET /api/mobile/session` answers with `authenticated` and `version?.startsWith('1.')`, it prints "already running" and opens `http://127.0.0.1:<port>/mobile/` in the browser.
- L20: otherwise `spawn(process.execPath,['mobile-gateway.mjs','--open',...(process.argv.includes('--tunnel')?['--tunnel']:[])],{cwd:root,env:process.env,stdio:'inherit'})`.
- `start-mobile.cmd` runs `node start-mobile.mjs` with no arguments.
- Gateway main (GW L121-137):
  - L122 builds the app from `loadEnv()`: `clientKey:env.STUDIO_CLIENT_KEY||''`, `apiKey:env.API_TOKEN||''`.
  - L124: `app.server.listen(port,'127.0.0.1',...)`.
  - `--tunnel` (L126-131): `spawn(exe,['tunnel','--url','http://127.0.0.1:'+port,'--no-autoupdate','--protocol','http2'],{windowsHide:true})`, with `exe` the hard-coded cloudflared path on win32. Stderr is matched with `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`; the first match calls `app.setPublicUrl(match[0])`, logs `MOBILE_PUBLIC_URL ...`, and writes `runtime\mobile-url.txt`. On exit it only logs `HTTPS_TUNNEL_STOPPED`.
  - `--open` (L132): opens `/mobile/pair` in the default browser.
  - Stop (L136): `const stop=()=>{tunnel?.kill();app.server.close();app.workspace.close().finally(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();};process.on('SIGINT',stop);process.on('SIGTERM',stop);`
  - `workspace.close()` (WS L148) disconnects TikTok events, closes the Vardyverse ingest, and awaits encoders.
- `lib\env.mjs` L8-19: `process.env` wins over `server.env`, which wins over `.env`. Line regex `/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/`; one pair of quotes stripped. It returns a copy and does not change `process.env`. Default `PUBLIC_BASE_URL=http://localhost:<PORT||8800>`.
- Variable names:
  - `server.env.example`: `PORT`, `PUBLIC_BASE_URL`, `DRY_RUN`.
  - Gateway code: `MOBILE_PORT` (read from `process.env` only), `PORT`, `STUDIO_CLIENT_KEY`, `API_TOKEN`, `SIGN_API_KEY`, `EULER_API_KEY`, `TIKTOOLS_API_KEY`, `KLING_API_KEY`, `OPENROUTER_API_KEY`, `FX_REMIX_MODEL`, `FX_VIDEO_MODEL`, `RTMP_IMPORT_FILE`, `VARDY_INGEST`, `VARDY_BASE_URL`, `VARDY_SERVICE_KEY`, `VARDY_CREATOR_HANDLE`, `FFMPEG`, `FFPROBE` (the last two from `process.env`).
- `lib\mobile-tools.mjs`: picks `env.FFMPEG`, then `node_modules\ffmpeg-static\ffmpeg.exe`, then the `@ffmpeg-installer` path, then `tools\ffmpeg.exe`, else the bare name. `installed` is true only if both resolved paths exist on disk.
- `lib\mobile-rtmp-import.mjs`: `readCapturedTarget(file,now)` requires a file of at most 1 MiB, modified within 15 minutes, with `obs[0]` or `all[0]` holding an `rtmp:`/`rtmps:` server without credentials and a `stream_key` (up to 2000 chars, no CR/LF). Errors are `LOCAL_RTMP_CAPTURE_MISSING|INVALID|EXPIRED`, status 409. The key is never returned to the browser.
- `MOBILE.md` documents the URLs, pairing (3-minute codes, 12-hour sessions), the HTTPS requirement for phones and where data is stored. It does not mention `--tunnel`.

## 8. Rate limits and abuse protections
- Pairing: 8 failures per IP per 60 s (429); one live 8-digit code; 3-minute TTL; one-use; 12 sessions maximum; 12-hour session TTL.
- Origin check on POST/PUT/DELETE (403); OPTIONS 405.
- Loopback plus exact Host check for local-only routes (DNS-rebinding guard).
- Body caps as in section 1.
- Frames: magic-byte check and 200 ms limit (429 `FRAME_RATE_LIMIT`); audio mime check; buffers pruned every 15 s (L117).
- Media proxy allow-list `validMediaPath`; Range must match `/^bytes=\d*-\d*$/` (416).
- Broadcast: 2 concurrent, sequence check, `BACKPRESSURE`, input and output timeouts, owner check on append and stop.
- Workspace: 1000 clients, 200 rules, 2 concurrent jobs, `spendAccepted` required, idempotent `requestId`.
- Upstream timeouts: 20 s; 180 s for SSE and uploads; 3 s for `/health`.
- Not present: any global or per-IP request limiter, a cap on concurrent SSE connections, any origin check on GET.

## 9. The two un-ported hunks
(a) CORS, `C:\Users\shk\wanna-studio-server\mobile-gateway.mjs` L41-42:
```
    // The effects panel on :8800 (same computer) reads the phone's preview stream (overview + HLS files) from here: allow that origin only, GET only.
    {const o=req.headers.origin;if(o&&req.method==='GET'&&/^http:\/\/(localhost|127\.0\.0\.1):8800$/.test(o)){res.setHeader('Access-Control-Allow-Origin',o);res.setHeader('Vary','Origin');}}
```
- It sits right after the Permissions-Policy header and before `try{`. The equivalent place in the repo GW is between L40 and L41.
- It is GET-only with port 8800 hard-coded, and it sends no credentials header. It works because the :8800 page's request is a loopback request and gets `localSession`.

(b) `src=server`, `C:\Users\shk\wanna-studio-server\fx\index.html` L125-149 (function) and L229 (dispatch):
```
async function useServer() {
  const base = `http://${location.hostname === 'localhost' ? 'localhost' : '127.0.0.1'}:8801`;
  ... const r = await fetch(base + '/api/workspace/overview', { cache: 'no-store' }); const d = await r.json();
  const s = (d.broadcasts || []).filter(b => b.mode === 'preview' && b.state === 'running').sort((a, b) => b.startedAt - a.startedAt)[0];
  ... const { default: Hls } = await import('https://cdn.jsdelivr.net/npm/hls.js@1.6.15/+esm');
  ... video.srcObject = null; video.src = ''; video.muted = true;
  const h = window._hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 }); h.loadSource(url); h.attachMedia(video);
```
`else if (qs.get('src') === 'server') useServer(); // the phone's PWA stream via the mobile gateway (HLS)`
- It retries 100 times at 3 s.
- Equivalent places in the repo `fx\index.html`: the function goes after L124 (`$('#phone').onclick = usePhone;`); the dispatch line goes between L203 and L204.
- The `state === 'running'` filter still works with 1.2.0, where a stream is `starting` until output is confirmed.

## 10. Binding and public URL
- Gateway: `app.server.listen(port,'127.0.0.1',...)` (GW L124), IPv4 loopback only. All gateway-to-studio calls use `127.0.0.1:<upstreamPort>` (GW L30, L78; WS L33, L90). cloudflared targets `http://127.0.0.1:<port>`.
- Studio server: `server.listen(PORT, ...)` (`server.mjs` L450) has no host, so it binds all interfaces (observed `::`). It sends `Access-Control-Allow-Origin: *` and bypasses its key for local callers (`isLocal`, `server.mjs` L39-40).
- `fx\serve.mjs` L81 (dev server) binds `127.0.0.1`. All tests bind `127.0.0.1`.
- Public URL:
  - Gateway variable `publicUrl` (GW L21, `''` by default).
  - Set only by `setPublicUrl(value){const u=new URL(value);if(u.protocol!=='https:')throw new Error('HTTPS_REQUIRED');publicUrl=u.origin;workspace.setPublicUrl(publicUrl);}` (L119), which is called only from the tunnel stderr parser. There is no env variable for a fixed URL.
  - Exposed through `GET /api/mobile/public-url` and `POST /api/mobile/pairing-code` (both local-only), `runtime\mobile-url.txt`, and the console.
  - Used in `sameOrigin()`.
  - Workspace side: `publicBase` (WS L34); `setPublicUrl(value){publicBase=value?new URL(value).origin:'';kick();}` (L148); surfaced only as `publicHttps:Boolean(publicBase)` and `aiReachable` in `config()` (L47); used to build the provider ticket URL (L61).

## 11. Where new /api/live code meets this pipeline
- Preflight and cross-origin POST are blocked at GW L43-44 before routing, so CORS handling for `/api/live/*` must sit before those lines. The ACAO header belongs next to the old hunk's position (after L40).
- A bearer-ticket path must be evaluated before the L74 gate, because `auth()` knows only loopback and the `wm_sid` cookie.
- Loopback-only `program/*` routes can reuse `localRequest(req,port)`.
- SDP bodies need their own reader; the gateway's `jsonBody` stops at 4096 bytes.
- `/mobile/live` needs an alias (L62-65) and allow-list entries (L67) for the page and its external script.
- `publicUrl` is available in the closure for a `config` route.
- A new test file must be added to `package.json` L8.

## GOTCHAS
- Cross-origin calls cannot work today: `OPTIONS` returns 405 (GW L44) and any POST/PUT/DELETE whose Origin host differs from Host gets 403 `ORIGIN_REJECTED` (GW L43), both before routing. This hits the Vardyverse origin and also the program page on :8800 (`127.0.0.1:8800` to `:8801` fails the Origin-host comparison; `localhost:8800` to `127.0.0.1:8801` is cross-site). The repo gateway sets no `Access-Control-*` header.
- GET requests have no origin check, and every loopback request is auto-authenticated as `local-desktop`. A GET long-poll that consumes a pending offer could be triggered by any page open in the local browser (a no-cors GET) or any local process. Check `Sec-Fetch-Site`/Origin on `program/*`, or make the poll non-destructive.
- `localRequest()` means loopback peer, no `cf-connecting-ip` or `x-forwarded-for`, and Host exactly `127.0.0.1:<port>` or `localhost:<port>`, where `<port>` is the option given to `createMobileGateway`. Tests must pass the same port they listen on. Any local forwarder that keeps that Host (for example `adb reverse`) counts as the local desktop, so 'loopback-only' is wider than 'this computer's browser'.
- The gateway's `jsonBody()` caps bodies at 4096 bytes and demands `Content-Type: application/json` (415 otherwise). SDP offers and answers will usually exceed 4 KiB, more so with gathered ICE candidates. The workspace `json()` allows 256 KiB; the live routes need their own reader.
- (Node source, not executed) When a `for await` body read exits early, as on `BODY_TOO_LARGE`, Node sets `req.socket = null` for server requests. Do `localRequest()`/`auth()` before reading the body, as the pipeline does at L74.
- `/mobile/live` and `/mobile/live.html` both return 404 today because of the strict allow-list (GW L67) and the fixed aliases (`pair`, `manage`, `viewer`). The page's script must be an external allow-listed `.js` file: the CSP forbids inline scripts, and the type map lacks `.mjs`/`.wasm`/`.webp`/`.jpg`, which would be served as `application/octet-stream` with `nosniff`. Static files always come from `ROOT/public/mobile`, even when a test passes a temp `workspaceRoot`.
- The CSP on `/mobile/*` has `connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com`, so a gateway-served page cannot fetch the Vardyverse API. `frame-ancestors 'self'` means it cannot be iframed by Vardyverse. There is no X-Frame-Options header at all.
- The `wm_sid` cookie is `HttpOnly; SameSite=Strict; Max-Age=43200`, and sessions live in memory (12-device cap, lost on restart). It will not be sent on cross-site requests from the Vardyverse origin, so a bearer ticket is the only option there. If a ticket were turned into a normal session it would unlock every `/api/workspace/*` route, including RTMP destination and paid generation; scope tickets to `/api/live/*`.
- There is no tunnel by default. `start-mobile.cmd` passes no arguments and `--tunnel` is forwarded only if given to `start-mobile.mjs`. The launcher will not restart a gateway that is already running. The gateway now running was started with `--open` only, so it has no public URL.
- The quick-tunnel hostname is random on every start. `publicUrl` is never cleared when cloudflared exits, and there is no env variable for a fixed public URL. Cookies, camera permission and PWA install are per-origin, so they reset with each new hostname.
- `MOBILE_PORT`, `FFMPEG` and `FFPROBE` are read from `process.env` only; putting them in `server.env` has no effect. New live settings should be read from the `env` object passed into `createMobileGateway`.
- A 25 s long-poll is not cut by Node 24.16.0 defaults (requestTimeout 300 s, headersTimeout 60 s, keepAliveTimeout 5 s + 1 s, timeout 0). It is cut by `proxy()`'s 20 s upstream timeout if routed through it, by short client `AbortSignal.timeout` values, and by the 2 s hard exit on shutdown.
- Test teardown `await new Promise(r=>app.server.close(r))` waits for open connections, so a pending long-poll will hang it for up to the poll length. Give the relay a close hook that answers pending polls, or call `server.closeAllConnections()`. Inject a short poll time or fake timers, as `vardy-ingest` does with `now`/`timers`.
- Use `res.on('close')` with a `res.writableEnded` check for long-poll cleanup, as GW L32 and `lib/fx-routes.mjs` L168 do. (Node source) `req` 'close' fires as soon as the request body stream is consumed, so it is not a disconnect signal after a POST body read. `fx/serve.mjs` L25 records the same pitfall.
- (Node source, not executed) The SSE proxy `/api/mobile/events` destroys its upstream after 180 s of silence but never ends the downstream response, and `/api/stage-events` has no heartbeat. The phone's EventSource can stay open but dead. Do not copy `proxy()` for the long-poll.
- Broadcasts 1.2.0 has no `SESSION_LIMIT`; the 1 h cap exists only in the old copy. It adds `OUTPUT_TIMEOUT` (60 s), starts in state `starting`, counts starting, running and stopping toward the limit of 2, drops the `diagnostic` field, and serves broadcast files to any authenticated session (no owner check).
- The old `useServer()` hunk hard-codes ports 8801 and 8800, imports hls.js from jsdelivr at runtime, and sets `video.muted = true`, so creator audio never reaches LIVE Studio's desktop-audio capture on that path. HLS settings (2 s segments, `liveSyncDurationCount: 2`) imply several seconds of delay.
- `setPublicUrl()` calls `workspace.setPublicUrl()`, which calls `kick()`. Bringing up a public URL can start generation jobs that were already queued and accepted for spend.
- `npm test` runs only the files listed in `package.json` L8. `mobile.test.mjs` builds the gateway on the real `ROOT` workspace and lets `configureMediaTools` change `process.env`; new tests should pass a temp `workspaceRoot` and `workspaceOptions.tools`.
- The launcher checks `existing.version?.startsWith('1.')` on `/api/mobile/session`; keep that field. It also always passes `--open`, which opens a browser tab on every start.
- The studio server on :8800 binds all interfaces, sends `Access-Control-Allow-Origin: *`, and skips its key for local callers. Any page served from the :8800 origin becomes able to read the gateway once that origin is CORS-allowed.
- The cloudflared tunnel carries only HTTP and WebSocket. WebRTC media between a phone on mobile data and the Windows machine needs STUN/TURN; no ICE configuration exists in code or env today.
- If the cloud wall iframe (public origin, `allow` set to `autoplay; fullscreen` only in `fx/index.html` L102) ever needs to call the loopback gateway, expect Chrome's Local Network Access restrictions (from memory, not verified here). Keep `program/*` calls in the program page itself.
- The RTMP key is stored in plaintext in `data/mobile-workspace.json`, and the provider key in `data/live-event-provider.json`. Neither was read. Keep live tickets in memory, hashed like `MobileSessions` does, rather than in those files.

## OPEN QUESTIONS
- Who issues and who validates the bearer ticket: the gateway (a local-only issue route like `pairing-code`), or Vardyverse (a token checked with a shared secret or `VARDY_SERVICE_KEY`)? Is it related to the `t` parameter of `/stage?creator=..&t=..`?
- How does the creator's phone learn the gateway's public URL? It is a random trycloudflare host per start, exposed only to local callers and never cleared when the tunnel dies. Is a named tunnel or fixed hostname planned?
- Which exact origins go on the CORS allow-list: `http://127.0.0.1:<upstreamPort>` and `http://localhost:<upstreamPort>` for the program page, `https://vardy-verse-connect.lovable.app`, and any Lovable preview domains?
- Is `/mobile/live` meant to be opened top-level on the gateway origin (works with the current CSP once allow-listed), or embedded in or called from Vardyverse pages (needs `frame-ancestors`, `connect-src` and CORS changes)?
- Which STUN/TURN servers and credentials should `/api/live/config` return, and how are TURN secrets kept short-lived and limited to authenticated clients?
- Should the old GET-only CORS hunk be ported as is (port 8800 hard-coded) or generalised from `upstreamPort` with OPTIONS/POST support for `/api/live/program/*`? An alternative is to have the :8800 server proxy `/api/live/program/*` so the program page stays same-origin.
- Should `program/poll` be a GET that delivers each offer once, or state-based with an explicit ack, given that loopback GETs are unauthenticated and not origin-checked?
- Will the program page play the creator's audio unmuted for LIVE Studio's desktop-audio capture, and how is Chrome's autoplay policy handled on the Windows machine?
- Is the 180 s SSE idle behaviour (downstream left open after the upstream is destroyed) seen in practice? It needs a run against a disposable instance to confirm.
- `.env.example` could not be read (blocked by permission settings), so its variable names are not listed. Does it define anything the live relay should reuse?
- Is the phone PWA currently reaching the gateway through `adb reverse` (which would make it `local-desktop`) or only through a tunnel? This changes what 'loopback-only' protects.
