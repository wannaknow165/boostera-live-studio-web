// WANNA Studio Server — one server for everything the TikTok LIVE Studio needs:
//   • Gallery (/)            : one table of every effect — Front (transparent gifts), Background (full videos),
//                              Templates (supporter-video menu) and Live effects (remix on the streamer)
//   • Supporter videos       : /api/templates, /api/avatars, /api/orders (Kling 4.0) — layer "front" or "background"
//   • Live effects panel     : /fx/  (+ /remix, /remix-status, /phone.mjpeg, /save)
//   • LIVE Studio upstream   : /api/overlays, /api/set, /media/overlays/<id>.webm, /api/overlay|clip/play|stop, PUT uploads
//                              -> in the Studio set BOOSTERA_UPSTREAM_URL to this server's address.
// Zero npm dependencies (Node 20+), needs ffmpeg/ffprobe on PATH.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { loadEnv, ROOT } from './lib/env.mjs';
import { Store } from './lib/store.mjs';
import { prepareTemplate } from './lib/media.mjs';
import { runOrder } from './lib/worker.mjs';
import { unitsLeft } from './lib/kling.mjs';
import { fxRoutes } from './lib/fx-routes.mjs';
import { localStudioRequest } from './lib/studio-guards.mjs';
import { Automations, EVENTS } from './lib/automations.mjs';

const env = loadEnv();
const PORT = Number(env.PORT || 8800);
const store = new Store(path.join(ROOT, 'data'));
const MEDIA = path.join(ROOT, 'media'), FX = path.join(ROOT, 'fx'), PUBLIC = path.join(ROOT, 'public');
for (const d of ['templates', 'avatars', 'results', 'thumbs', 'inbox', 'inbox/done', 'inbox/failed']) fs.mkdirSync(path.join(MEDIA, d), { recursive: true });
const fx = fxRoutes({ FX });

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj, null, 2)); };
const readBody = req => new Promise((ok, bad) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > 300 * 1024 * 1024) { bad(new Error('body too large')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });
const newId = p => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const publicUrl = rel => `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/media/${rel}`;
const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.tflite': 'application/octet-stream' };

// ---- auth ----
// Tribute API: x-api-key = API_TOKEN.  Studio upstream: x-key / cookie bk = STUDIO_CLIENT_KEY (empty = open, local use).
const apiAuthed = req => !env.API_TOKEN || req.headers['x-api-key'] === env.API_TOKEN || cookie(req).ak === env.API_TOKEN;
// requests from this computer itself (our gallery, panels, clean layers) need no key; the key guards outside access.
// "This computer" = a loopback peer, not forwarded, that addressed us as localhost:PORT or 127.0.0.1:PORT and was not sent by a page of another site (lib/studio-guards.mjs)
const isLocal = req => localStudioRequest(req, PORT);
const studioAuthed = req => !env.STUDIO_CLIENT_KEY || isLocal(req) || new URL(req.url, 'http://x').searchParams.get('ck') === env.STUDIO_CLIENT_KEY || req.headers['x-key'] === env.STUDIO_CLIENT_KEY || cookie(req).bk === env.STUDIO_CLIENT_KEY || req.headers['x-api-key'] === env.API_TOKEN;
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]));

function serveFile(req, res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size, type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) { const s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : size - 1; res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Access-Control-Allow-Origin': '*' }); fs.createReadStream(file, { start: s, end: e }).pipe(res); }
  else { res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': /\.(html|json|js)$|[\\/]opponent[\\/]/.test(file) ? 'no-store' : 'public, max-age=300' }); if (req.method === 'HEAD') return res.end(); fs.createReadStream(file).pipe(res); }
}

// ---- media info + thumbnails (cached) ----
const probeCache = store.db.probe ||= {};
function probe(file) {
  return new Promise(ok => {
    const key = file + ':' + (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0); if (probeCache[key]) return ok(probeCache[key]);
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', file], (e, out) => {
      try { const j = JSON.parse(out); const v = j.streams?.find(s => s.width) || {}; probeCache[key] = { duration: Math.round(Number(j.format?.duration || 0) * 10) / 10, width: v.width, height: v.height }; } catch { probeCache[key] = {}; }
      ok(probeCache[key]);
    });
  });
}
function thumb(res, srcUrl) {
  // srcUrl: /media/... or /fx/...  -> 240px jpeg at 35% of the clip, transparent clips over a dark checker
  const rel = srcUrl.split('?')[0], root = rel.startsWith('/fx/') ? FX : MEDIA, file = path.normalize(path.join(root, decodeURIComponent(rel.replace(/^\/(fx|media)\//, ''))));
  if (!file.startsWith(root) || !fs.existsSync(file)) return json(res, 404, { error: 'no source' });
  const out = path.join(MEDIA, 'thumbs', crypto.createHash('md5').update(file + fs.statSync(file).mtimeMs).digest('hex') + '.jpg');
  const send = () => { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); fs.createReadStream(out).pipe(res); };
  if (fs.existsSync(out)) return send();
  if (/\.(jpe?g|png|webp)$/i.test(file)) return execFile('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'scale=240:-2', out], () => fs.existsSync(out) ? send() : json(res, 500, { error: 'thumb failed' }));
  probe(file).then(info => {
    const t = String(Math.max(0, (info.duration || 1) * 0.35)), alpha = /\.webm$/i.test(file);
    const args = alpha
      ? ['-v', 'error', '-y', '-ss', t, '-c:v', 'libvpx-vp9', '-i', file, '-f', 'lavfi', '-i', 'color=c=0x1c1c28:s=240x430', '-filter_complex', '[0]scale=240:-2[a];[1][a]overlay=(W-w)/2:(H-h)/2:shortest=1', '-frames:v', '1', out]
      : ['-v', 'error', '-y', '-ss', t, '-i', file, '-frames:v', '1', '-vf', 'scale=240:-2', out];
    execFile('ffmpeg', args, () => fs.existsSync(out) ? send() : json(res, 500, { error: 'thumb failed' }));
  });
}

// ---- battle effects (punches, gloves ×2/×3/×5, tomato, sniper…) from the BOOSTERA lab: media/battle/<id>.webm ----
// meta.json holds, per clip, where the chosen player's face goes (face x/y/size, faceLayer) and the seconds the hits land.
const BATTLE_NAMES = { glove_x5: 'כפפה ×5', multiplier_x3: 'כפפה ×3', multiplier_x2: 'כפפה ×2', tomato: 'עגבנייה', diaper: 'חיתול', snipe: 'סנייפר', dancer: 'רקדן', hand_mini: 'יד קטנה', baby_body: 'גוף תינוק', gnome_punch: 'אגרוף גמד', gnome_punch_short: 'אגרוף גמד קצר' };
const battleMeta = () => { try { return JSON.parse(fs.readFileSync(path.join(MEDIA, 'battle', 'meta.json'), 'utf8')); } catch { return {}; } };
// heads.json: where the battle TARGET's live head goes in each clip (under = thrown at it, over = on the clip's body) — see fx/battle-stage.js
const battleHeads = () => { try { return JSON.parse(fs.readFileSync(path.join(MEDIA, 'battle', 'heads.json'), 'utf8')); } catch { return {}; } };
const battleList = () => { const d = path.join(MEDIA, 'battle'); if (!fs.existsSync(d)) return []; const meta = battleMeta(), heads = battleHeads();
  const real = fs.readdirSync(d).filter(f => f.endsWith('.webm')).map(f => { const bid = f.replace(/\.webm$/, ''); return { id: bid, name: BATTLE_NAMES[bid] || bid, file: `battle/${f}`, meta: meta[bid] || null, head: heads[bid] || null }; });
  // heads.json entries with "file": a clip from a sub-folder played under another id (the supporter effects: one burst, different things written in it)
  const more = Object.entries(heads).filter(([bid, h]) => h && h.file && !real.some(c => c.id === bid) && fs.existsSync(path.join(d, h.file))).map(([bid, h]) => ({ id: bid, name: h.name || bid, file: `battle/${h.file}`, meta: null, head: h }));
  return [...real, ...more]; };
// a supporter's profile picture may be fetched through /api/avatar only from TikTok's own picture servers
const AVATAR_HOSTS = /(^|\.)(tiktokcdn(-[a-z]+)?\.com|tiktokv\.com|ibyteimg\.com|byteimg\.com|muscdn\.com)$/i;

// ---- the old ARIEL panel overlays (gnome boxer, "the Turk hits <user>", baby, chicken, ballet…): media/overlays/<id>.webm
// catalog media/overlays.json: id -> "name" or { he, user, boxer, kind, face, hitAt, pos, size, bottom, head, anchor, … }
const arielCatalog = () => { try { return JSON.parse(fs.readFileSync(path.join(MEDIA, 'overlays.json'), 'utf8')); } catch { return {}; } };
const arielList = () => { const d = path.join(MEDIA, 'overlays'); if (!fs.existsSync(d)) return []; const cat = arielCatalog();
  return fs.readdirSync(d).filter(f => f.endsWith('.webm')).map(f => { const oid = f.replace(/\.webm$/, ''), c = cat[oid]; const o = typeof c === 'string' ? { he: c } : (c || {}); return { id: oid, ...o, he: o.he || oid }; })
    .filter(o => o.kind !== 'clip_rejected'); };

// ---- the unified catalog (one row per playable item) ----
const fxIndex = () => { try { return JSON.parse(fs.readFileSync(path.join(FX, 'effects', 'index.json'), 'utf8').replace(/^﻿/, '')); } catch { return []; } };
const fxEffect = dir => { try { return JSON.parse(fs.readFileSync(path.join(FX, 'effects', dir, 'effect.json'), 'utf8')); } catch { return {}; } };
async function catalog() {
  const rows = [];
  for (const t of store.templates().filter(t => t.enabled !== false)) {
    const info = await probe(path.join(MEDIA, t.file));
    rows.push({ id: `tpl-${t.id}`, kind: 'template', name: t.title, layer: t.layer === 'back' ? 'background' : (t.layer || 'front'), format: 'mp4', alpha: false, url: `/media/${t.file}`, duration: info.duration, modes: t.modes, character: t.character, templateId: t.id });
  }
  for (const o of store.orders().filter(o => o.status === 'succeeded')) {
    const t = store.template(o.templateId) || {}, name = `${o.supporterName || 'תומך'} · ${t.title || o.templateId}`;
    const sup = (o.supporterName || '').replace(/\s*\(.*\)\s*$/, '').trim(), people = sup ? [{ name: sup, role: 'supporter' }] : [];
    if (o.transparent_result) {
      const info = await probe(path.join(MEDIA, o.transparent_result));
      rows.push({ id: `front-${o.id}`, kind: 'front', name, format: 'webm', alpha: true, url: `/media/${o.transparent_result}`, previewUrl: o.preview ? `/media/${o.preview}` : null, greenUrl: o.result ? `/media/${o.result}` : null, duration: info.duration, orderId: o.id, mode: o.mode, created: o.finished || o.created, studioId: `srv_ov_${o.id}`, people });
    }
    if (o.result && !o.transparent_result) {
      const info = await probe(path.join(MEDIA, o.result));
      rows.push({ id: `bg-${o.id}`, kind: 'background', name, format: 'mp4', alpha: false, url: `/media/${o.result}`, duration: info.duration, orderId: o.id, mode: o.mode, created: o.finished || o.created, studioId: `srv_clip_${o.id}`, people });
    }
  }
  for (const o of arielList()) {
    const info = await probe(path.join(MEDIA, 'overlays', `${o.id}.webm`));
    // the player/creator a clip was made for: the "user" field, or the name after "ל-" / "· " in demo clips
    const who = o.user || (o.kind === 'clip' && (/(?:ל-|· )([\w.]+)/.exec(o.he || '') || [])[1]) || null;
    rows.push({ id: `ov-${o.id}`, kind: 'overlay', name: o.he, format: 'webm', alpha: true, url: `/media/overlays/${o.id}.webm`, duration: info.duration, overlayId: o.id, user: who, boxer: o.boxer || null, character: !o.kind, hitAt: o.hitAt ?? null, studioId: `srv_ov_${o.id}`, people: who ? [{ name: who, role: 'player' }] : [] });
  }
  for (const b of battleList()) {
    const info = await probe(path.join(MEDIA, b.file));
    rows.push({ id: `battle-${b.id}`, kind: 'battle', name: b.name, format: 'webm', alpha: true, url: `/media/${b.file}`, duration: info.duration, battleId: b.id, perPlayer: Boolean(b.meta?.face), hits: b.meta?.hits?.length || 0, studioId: `srv_ov_${b.id}` });
  }
  for (const e of fxIndex()) {
    const fxj = fxEffect(e.dir), remixes = fx.remixList(e.dir).map(m => ({ ...m, url: m.url.replace(/^\/fx\//, '/media/fx/') })), ref = fs.existsSync(path.join(FX, 'effects', e.dir, 'reference.mp4')) ? `/media/fx/effects/${e.dir}/reference.mp4` : null;
    rows.push({ id: `live-${e.id}`, kind: 'live', name: e.title || e.id, summary: fxj.summary || '', posture: fxj.posture || e.posture || 'sit', category: fxj.category || 'face', url: ref || remixes[0]?.url || null, duration: fxj.duration, remixes, hasLayer: (fxj.assets || []).some(a => a.type === 'layer'), hasRemix: Boolean(fxj.remix?.prompt), dir: e.dir, people: remixes.map(m => ({ name: decodeURIComponent(m.streamer), role: 'streamer' })) });
    const room = fs.existsSync(path.join(FX, 'effects', e.dir, 'room.jpg')) ? `/media/fx/effects/${e.dir}/room.jpg` : null;
    if (room) rows.push({ id: `room-${e.id}`, kind: 'room', name: `חדר · ${e.title || e.id}`, format: 'jpg', alpha: false, url: room });
  }
  return rows;
}

// ---- LIVE Studio "now playing" state (Studio renders; we keep state + stream it on /api/stage-events) ----
const stage = { overlay: null, clip: null, updated: Date.now() };
let opponentFaceOn = true; // the head-tomato may use the current opponent's face (switch in the live panel)
// the cut-out face is on disk only while it is in use: removed when the switch goes off, 50 s after the last upload, and at start
let oppFaceTimer = null;
const dropOppFace = () => { clearTimeout(oppFaceTimer); oppFaceTimer = null; stage.opponent = null; try { fs.rmSync(path.join(MEDIA, 'opponent', 'face.png'), { force: true }); } catch {} };
dropOppFace();
const stageClients = new Set();
const pushStage = () => { stage.updated = Date.now(); const msg = `data: ${JSON.stringify(stage)}\n\n`; for (const c of stageClients) c.write(msg); };

// ---- battle automations: event -> effect ----
const automations = new Automations({
  dataDir: path.join(ROOT, 'data'),
  // turn a rule's action into something playable for this event
  resolve: async (a, ev) => {
    if (a.type === 'overlay') { const o = arielList().find(x => x.id === a.id) || battleList().find(x => x.id === a.id); return o ? { kind: 'overlay', id: a.id, name: o.he || o.name, url: `/media/overlays/${a.id}.webm` } : null; }
    if (a.type === 'special') { const b = battleList().find(x => x.id === a.id); if (b?.head?.layer === 'fan' && !ev.supporter) return null; /* a supporter effect needs to know who gave */ return b ? { kind: 'special', id: b.id, name: b.name, user: ev.user || null, url: `/media/${b.file}`, meta: b.meta, mult: a.mult } : null; }
    if (a.type === 'player_random') {
      const u = String(ev.user || '').toLowerCase(); if (!u) return null;
      const mine = arielList().filter(o => o.kind === 'clip' && ((o.user || '').toLowerCase() === u || (o.he || '').toLowerCase().includes(u)));
      if (!mine.length) return null; const o = mine[Math.floor(Math.random() * mine.length)];
      return { kind: 'overlay', id: o.id, name: o.he, user: ev.user, url: `/media/overlays/${o.id}.webm` };
    }
    if (a.type === 'clip') return { kind: 'clip', id: a.id, name: a.id };
    if (a.type === 'tomato') return { kind: 'screen', type: 'tomato', style: a.style, count: Math.max(1, Math.min(10, (a.count || 1) * (a.perGift ? Number(ev.count || 1) : 1))), name: `🍅 עגבנייה על הראש החי של המתחרה` };
    if (a.type === 'wake_up') return { kind: 'screen', type: 'wake', name: 'WAKE UP — הגמד מעיר את כולם' };
    if (a.type === 'screen_hits') return { kind: 'screen', type: 'hits', count: a.count || 1, name: `${a.count || 1} מכות על המסך` };
    if (a.type === 'double') return { kind: 'screen', type: 'double', mult: a.mult || 2, seconds: a.seconds || 30, name: `דאבל ×${a.mult || 2} (${a.seconds || 30}ש)` };
    if (a.type === 'live') { const e = fxIndex().find(x => x.id === a.id); return e ? { kind: 'live', id: e.id, name: e.title, streamer: ev.streamer || null } : null; }
    if (a.type === 'supporter_video') {
      const s = String(ev.supporter || '').trim(); if (!s) return null;
      const o = store.orders().filter(x => x.status === 'succeeded' && x.transparent_result && (x.supporterName || '').startsWith(s)).pop();
      return o ? { kind: 'overlay', id: o.id, name: o.supporterName, url: `/media/overlays/${o.id}.webm` } : null;
    }
    return null;
  },
  // put it on stage: the Studio / live panel listen on /api/stage-events
  play: (act, ev) => {
    if (act.kind === 'overlay') stage.overlay = { id: act.id, at: Date.now(), auto: ev.type };
    // (a supporter effect also carries who gave: name, profile picture, and the multiplier to write)
    if (act.kind === 'special') stage.special = { user: act.user, set: act.id, url: act.url, meta: act.meta, at: Date.now(), auto: ev.type, who: ev.supporter || null, avatar: ev.avatar || null, vars: (act.mult ?? ev.mult) != null ? { mult: String(act.mult ?? ev.mult).slice(0, 6) } : undefined };
    if (act.kind === 'clip') stage.clip = { id: act.id, at: Date.now(), auto: ev.type };
    if (act.kind === 'live') stage.live = { effect: act.id, streamer: act.streamer, at: Date.now(), auto: ev.type };
    if (act.kind === 'screen') stage.screen = { type: act.type, count: act.count, mult: act.mult, seconds: act.seconds, style: act.style, at: Date.now(), auto: ev.type };
    pushStage(); console.log('auto', ev.type, '->', act.kind, act.id);
  },
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE' }); return res.end(); }

    // ---- pages + static ----
    if (p === '/' || p === '/index.html') return serveFile(req, res, PUBLIC, 'index.html');
    if (p === '/automations') return serveFile(req, res, PUBLIC, 'automations.html');
    // ---- CLEAN outputs for the Studio (browser sources / virtual camera), each layer on its own ----
    if (p === '/clean/foreground') return serveFile(req, res, PUBLIC, 'clean-foreground.html');   // transparent: gifts, gnome, punches, WAKE UP, battle
    if (p === '/clean/background') return serveFile(req, res, PUBLIC, 'clean-background.html');   // behind the camera: background videos / rooms
    if (p === '/clean/program') { res.writeHead(302, { Location: '/fx/?clean=1' + (url.search ? '&' + url.search.slice(1) : '') }); return res.end(); } // camera + everything
    if (p === '/links') return serveFile(req, res, PUBLIC, 'links.html');
    // ---- the current battle opponent's face (cut automatically from the phone's battle screen) -> the head-tomato ----
    if (p === '/api/opponent-face') {
      if (!studioAuthed(req)) return json(res, 401, { error: 'studio key required' });
      if (req.method === 'POST') {
        const en = url.searchParams.get('enabled'), buf = await readBody(req);
        const ts = url.searchParams.get('tomatoStyle'); // how tomatoes go at the target: "live" = thrown at his live head, "head" = a tomato with his face. Kept here so every page follows it
        if (ts !== null) { stage.tomatoStyle = ts === 'head' ? 'head' : 'live'; pushStage(); return json(res, 200, { ok: true, tomatoStyle: stage.tomatoStyle }); }
        if (en !== null) { // the switch: put the opponent's face on the tomato, or not (then it is a plain tomato)
          opponentFaceOn = en !== '0'; if (!opponentFaceOn) dropOppFace();
          stage.oppOn = opponentFaceOn; pushStage(); // every open page follows the switch at once
          return json(res, 200, { ok: true, enabled: opponentFaceOn });
        }
        if (!opponentFaceOn) return json(res, 200, { ok: false, enabled: false });
        if (buf.length < 500 || buf.length > 5e6) return json(res, 400, { error: 'bad image' });
        fs.mkdirSync(path.join(MEDIA, 'opponent'), { recursive: true }); fs.writeFileSync(path.join(MEDIA, 'opponent', 'face.png'), buf);
        clearTimeout(oppFaceTimer); oppFaceTimer = setTimeout(dropOppFace, 50000); oppFaceTimer.unref?.();
        // not pushed on its own: it rides along with the next stage event (the tomato itself), so listeners aren't spammed
        stage.opponent = { url: `/media/opponent/face.png?v=${Date.now()}`, user: url.searchParams.get('user') || null, at: Date.now() };
        return json(res, 200, { ok: true, opponent: stage.opponent });
      }
      // a face older than 45 s is not used (that battle is no longer on the phone screen)
      return json(res, 200, { enabled: opponentFaceOn, tomatoStyle: stage.tomatoStyle || null, pick: stage.pick || null, opponent: stage.opponent && Date.now() - stage.opponent.at < 45000 ? stage.opponent : null });
    }
    // the operator's choice of target: { pick: { fx, fy } } = a head at that place on the phone's battle screen, { pick: null } = automatic (the one facing us)
    if (p === '/api/opponent-pick') {
      if (!studioAuthed(req)) return json(res, 401, { error: 'studio key required' });
      if (req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString() || '{}'), k = b.pick; stage.pick = k && Number.isFinite(+k.fx) && Number.isFinite(+k.fy) ? { fx: +k.fx, fy: +k.fy, at: Date.now() } : null; pushStage(); }
      return json(res, 200, { ok: true, pick: stage.pick || null });
    }
    // ---- one-click PLAY links (GET, for Studio buttons): /play/overlay/<id> · /play/battle/<id>?user= · /play/gift/<id>
    //      /play/clip/<id> · /play/screen/wake|hits|double|stop?count=&mult=&seconds= · /play/live/<effect>?streamer= · /play/stop
    // a supporter's profile picture, handed on from here so the page may read its pixels (only from TikTok's picture servers)
    if (p === '/api/avatar' && req.method === 'GET') {
      if (!studioAuthed(req)) return json(res, 401, { error: 'studio key required' });
      let u; try { u = new URL(url.searchParams.get('u') || ''); } catch { return json(res, 400, { error: 'bad address' }); }
      if (u.protocol !== 'https:' || !AVATAR_HOSTS.test(u.hostname)) return json(res, 403, { error: 'only pictures from TikTok servers' });
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(6000), redirect: 'error' }), ct = r.headers.get('content-type') || '';
        if (!r.ok || !/^image\//.test(ct)) return json(res, 502, { error: 'no picture there' });
        const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 3e6) return json(res, 413, { error: 'picture too big' });
        res.writeHead(200, { 'Content-Type': ct, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=600' }); return res.end(buf);
      } catch { return json(res, 502, { error: 'no picture there' }); }
    }
    if (req.method === 'GET' && p.startsWith('/play/')) {
      if (!studioAuthed(req)) return json(res, 401, { error: 'studio key required (x-key or ?ck=)' });
      const [, , kind, rawId] = p.split('/'), pid = decodeURIComponent(rawId || ''), q = url.searchParams;
      if (kind === 'overlay' || kind === 'gift') stage.overlay = { id: pid, at: Date.now() };
      else if (kind === 'battle') { const clip = battleList().find(x => x.id === pid); if (!clip) return json(res, 404, { error: 'unknown battle clip' }); stage.special = { user: q.get('user'), set: pid, url: `/media/${clip.file}`, meta: clip.meta, at: Date.now(), avatar: q.get('avatar') || null, vars: q.get('mult') ? { mult: q.get('mult').slice(0, 6) } : undefined }; } // &avatar= &mult= : a supporter effect (who gave, and the multiplier written in it)
      else if (kind === 'clip') stage.clip = { id: pid, at: Date.now() };
      else if (kind === 'screen') stage.screen = { type: pid || 'hits', count: +q.get('count') || undefined, mult: +q.get('mult') || undefined, seconds: +q.get('seconds') || undefined, style: q.get('style') || undefined, at: Date.now() };
      else if (kind === 'live') stage.live = { effect: pid, streamer: q.get('streamer') || null, at: Date.now() };
      else if (kind === 'stop') { stage.overlay = stage.clip = stage.special = null; stage.screen = { type: 'stop', at: Date.now() }; }
      else return json(res, 404, { error: 'kinds: overlay, gift, battle, clip, screen, live, stop' });
      pushStage(); return json(res, 200, { ok: true, played: kind, id: pid });
    }
    if (p === '/clean' || p === '/clean/') return json(res, 200, { foreground: '/clean/foreground', background: '/clean/background', program: '/clean/program?src=phone|camera&streamer=<name>', size: '1080x1920 (9:16)', events: '/api/stage-events' });
    // ---- the catalog split by layer (what goes BEHIND the camera vs IN FRONT of it) ----
    if (req.method === 'GET' && p === '/api/layers') {
      const rows = await catalog(), pick = r => ({ id: r.id, name: r.name, url: r.url, format: r.format, alpha: !!r.alpha, duration: r.duration, studioId: r.studioId || null, people: r.people || [] });
      return json(res, 200, {
        background: { videos: rows.filter(r => r.kind === 'background').map(pick), remixes: rows.filter(r => r.kind === 'live').flatMap(r => r.remixes.map(m => ({ id: `remix-${r.id.slice(5)}-${m.streamer}`, name: `${r.name} · ${decodeURIComponent(m.streamer)}`, url: m.url }))), rooms: rows.filter(r => r.kind === 'room').map(pick) },
        foreground: { gifts: rows.filter(r => r.kind === 'front').map(pick), overlays: rows.filter(r => r.kind === 'overlay').map(pick), battle: rows.filter(r => r.kind === 'battle').map(pick), screen: ['hits', 'double', 'wake'] },
        live: rows.filter(r => r.kind === 'live').map(r => ({ id: r.id.slice(5), name: r.name, posture: r.posture, remixReady: r.remixes.map(m => decodeURIComponent(m.streamer)) })),
        templates: rows.filter(r => r.kind === 'template').map(pick),
      });
    }

    // ---- automations API (rules + event intake). TikTok event readers / the Studio post events to /api/event ----
    if (p === '/api/automations' || p === '/api/automations/reset' || p === '/api/event') {
      if (!studioAuthed(req)) return json(res, 401, { error: 'studio key required (x-key)' });
      if (req.method === 'GET' && p === '/api/automations') {
        const rows = await catalog();
        return json(res, 200, { events: EVENTS, rules: automations.rules, history: automations.history,
          options: {
            special: battleList().map(b => ({ id: b.id, name: b.name })),
            overlay: arielList().filter(o => !o.kind).map(o => ({ id: o.id, name: o.he })).concat(battleList().map(b => ({ id: b.id, name: b.name }))),
            live: fxIndex().map(e => ({ id: e.id, name: e.title })),
            clip: rows.filter(r => r.kind === 'background').map(r => ({ id: r.orderId, name: r.name })),
            players: [...new Set(arielList().map(o => o.user).filter(Boolean))],
          } });
      }
      if (req.method === 'PUT' && p === '/api/automations') return json(res, 200, { ok: true, rules: automations.save(JSON.parse((await readBody(req)).toString())) });
      if (req.method === 'POST' && p === '/api/automations/reset') return json(res, 200, { ok: true, rules: automations.reset() });
      if (req.method === 'POST' && p === '/api/event') { const ev = JSON.parse((await readBody(req)).toString() || '{}'); if (!EVENTS[ev.type]) return json(res, 400, { error: 'unknown event type', types: Object.keys(EVENTS) }); return json(res, 200, { ok: true, fired: await automations.fire(ev) }); }
    }
    if (p === '/fx' ) { res.writeHead(302, { Location: '/fx/' }); return res.end(); }
    if (fx.handle(req, res, url, studioAuthed(req))) return; // phone screen, remix, saving: this computer or the studio key
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/fx/')) return serveFile(req, res, FX, decodeURIComponent(p.slice(4)) || 'index.html');
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/public/')) return serveFile(req, res, PUBLIC, decodeURIComponent(p.slice(8)));

    // Studio asks for /media/overlays/<id>.webm — map the id to the real transparent file
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/media/overlays/')) {
      const oid = decodeURIComponent(p.slice(16)).replace(/\.webm$/, ''), o = store.order(oid);
      if (/^[\w.-]+$/.test(oid) && fs.existsSync(path.join(MEDIA, 'overlays', `${oid}.webm`))) return serveFile(req, res, MEDIA, `overlays/${oid}.webm`);
      if (o?.transparent_result) return serveFile(req, res, MEDIA, o.transparent_result);
      if (/^[\w-]+$/.test(oid) && fs.existsSync(path.join(MEDIA, 'battle', `${oid}.webm`))) return serveFile(req, res, MEDIA, `battle/${oid}.webm`);
      return json(res, 404, { error: 'unknown overlay' });
    }
    // the Studio only forwards /media/* to us, so live-effect files and thumbnails are also reachable under /media
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/media/fx/')) return serveFile(req, res, FX, decodeURIComponent(p.slice(10)));
    if (req.method === 'GET' && (p === '/thumb' || p === '/media/_thumb')) return thumb(res, (url.searchParams.get('src') || '').replace(/^\/media\/fx\//, '/fx/'));
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/media/')) return serveFile(req, res, MEDIA, decodeURIComponent(p.slice(7)));
    if (req.method === 'GET' && (p === '/health' || p === '/api/health')) return json(res, 200, { ok: true, service: 'WANNA Studio Server', port: PORT, public: env.PUBLIC_BASE_URL, dryRun: env.DRY_RUN === '1', queue: store.pending().length, templates: store.templates().length, results: store.orders().filter(o => o.status === 'succeeded').length, liveEffects: fxIndex().length });

    // ---- catalog (gallery table) ----
    if (req.method === 'GET' && p === '/api/catalog') return json(res, 200, { title: env.GALLERY_TITLE || 'גלריית WANNA', rows: await catalog() });

    // ======================= LIVE Studio upstream compatibility =======================
    if (p === '/api/overlays' || p === '/api/set' || p === '/api/special' || p === '/api/battle' || p === '/api/bg' || p === '/api/screen' || /^\/api\/(overlay|clip|desk)\//.test(p) || ['/api/upload', '/api/fx/upload', '/api/overlay/upload', '/api/players/photo', '/api/stage-events'].includes(p)) {
      if (!studioAuthed(req)) return json(res, 401, { error: 'studio key required (x-key)' });
      if (req.method === 'GET' && p === '/api/overlays') {
        // transparent front gifts -> Studio "Overlays" (it plays /media/overlays/<id>.webm)
        const list = store.orders().filter(o => o.status === 'succeeded' && o.transparent_result).map(o => ({ id: o.id, he: `${o.supporterName || 'תומך'} · ${store.template(o.templateId)?.title || ''}`.trim(), kind: 'gift', pos: 'center', size: 0.95 }))
          // battle clips: no "user" -> the Studio binds them into its glove ×2/×3/×5 variations; per-player use via /api/special
          .concat(battleList().map(b => ({ id: b.id, he: b.name, kind: 'battle', pos: 'center', size: 1 })))
          // the old ARIEL panel overlays, with all their original fields (user, face, hitAt, pos, size, bottom, head…)
          .concat(arielList());
        return json(res, 200, { list });
      }
      if (req.method === 'GET' && p === '/api/set') {
        const rows = await catalog();
        return json(res, 200, {
          clips: rows.filter(r => r.kind === 'background').map(r => ({ id: r.orderId, name: r.name, file: r.url, thumb: `/media/_thumb?src=${encodeURIComponent(r.url)}` }))
            .concat(rows.filter(r => r.kind === 'live').flatMap(r => r.remixes.map(m => ({ id: `remix-${r.id.slice(5)}-${m.streamer}`, name: `${r.name} · ${m.streamer}`, file: m.url, thumb: `/media/_thumb?src=${encodeURIComponent(m.url)}` })))),
          assets: {
            front: rows.filter(r => r.kind === 'front').map(r => ({ id: r.orderId, name: r.name, file: r.url, thumb: `/media/_thumb?src=${encodeURIComponent(r.previewUrl || r.url)}` })),
            bg: rows.filter(r => r.kind === 'room').map(r => ({ id: r.id, name: r.name, file: r.url, thumb: `/media/_thumb?src=${encodeURIComponent(r.url)}` })),
          },
        });
      }
      // battle clips with their face anchors + hit times (for the per-player compositing in the Studio / phone)
      if (req.method === 'GET' && p === '/api/battle') return json(res, 200, { clips: battleList().map(b => ({ ...b, url: `/media/${b.file}` })) });
      if (req.method === 'GET' && p === '/api/stage-events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        res.write(`data: ${JSON.stringify(stage)}\n\n`); stageClients.add(res); req.on('close', () => stageClients.delete(res)); return;
      }
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        if (p === '/api/overlay/play') { stage.overlay = { id: b.id, loop: !!b.loop, at: Date.now() }; pushStage(); return json(res, 200, { ok: true, stage }); }
        // background room behind the camera: { id } from /api/set assets.bg, or { url }, or {} to clear
        if (p === '/api/bg') { stage.bg = b.id || b.url ? { id: b.id || null, url: b.url || null, at: Date.now() } : null; pushStage(); return json(res, 200, { ok: true, stage }); }
        // screen effects in front: { type: "hits", count } | { type: "double", mult, seconds } | { type: "wake" } | { type: "stop" }
        if (p === '/api/screen') { stage.screen = { type: b.type || 'hits', count: b.count, mult: b.mult, seconds: b.seconds, style: b.style, at: Date.now() }; pushStage(); return json(res, 200, { ok: true, stage }); }
        if (p === '/api/clip/play') { stage.clip = { id: b.id, at: Date.now() }; pushStage(); return json(res, 200, { ok: true, stage }); }
        if (p === '/api/overlay/stop') { stage.overlay = null; pushStage(); return json(res, 200, { ok: true }); }
        if (p === '/api/clip/stop') { stage.clip = null; pushStage(); return json(res, 200, { ok: true }); }
        if (p === '/api/desk/stop') { stage.overlay = stage.clip = stage.special = null; pushStage(); return json(res, 200, { ok: true }); }
        // per-player battle effect: { user: "<tiktok user>", set: "<battle id>" } -> the clip + where that player's face goes + hit times
        if (p === '/api/special') { const clip = battleList().find(x => x.id === b.set) || null; stage.special = { user: b.user, set: b.set, url: clip ? `/media/${clip.file}` : null, meta: clip?.meta || null, at: Date.now(), avatar: b.avatar || null, vars: b.vars && typeof b.vars === 'object' ? b.vars : undefined }; pushStage(); return json(res, clip ? 200 : 404, { ok: !!clip, special: stage.special }); }
      }
      if (req.method === 'PUT') {
        // uploads from the Studio: videos -> template inbox (appear in the gallery), photos -> supporter avatars
        const buf = await readBody(req), ct = req.headers['content-type'] || '';
        if (p === '/api/players/photo' || ct.startsWith('image/')) {
          const aid = newId('av'), ext = { 'image/png': '.png', 'image/webp': '.webp' }[ct] || '.jpg', file = `avatars/${aid}${ext}`;
          fs.writeFileSync(path.join(MEDIA, file), buf); store.saveAvatar({ id: aid, name: url.searchParams.get('name') || url.searchParams.get('user') || '', file, created: new Date().toISOString() });
          return json(res, 201, { ok: true, id: aid, url: `/media/${file}` });
        }
        const name = (url.searchParams.get('name') || newId('upload')).replace(/[^\w-]+/g, '-');
        fs.writeFileSync(path.join(MEDIA, 'inbox', `${name}.mp4`), buf);
        return json(res, 201, { ok: true, id: name, note: 'added to the gallery inbox; it becomes a template in ~10 s' });
      }
      return json(res, 404, { error: 'no route' });
    }

    // ======================= Supporter videos (front / background) =======================
    if (p.startsWith('/api/')) {
      if (!apiAuthed(req)) return json(res, 401, { error: 'missing or wrong x-api-key' });
      const templateView = t => ({ ...t, sampleUrl: publicUrl(t.file) });
      const orderView = o => ({ ...o, layer: o.transparent ? 'front' : 'background', resultUrl: o.result ? publicUrl(o.result) : null, transparentUrl: o.transparent_result ? publicUrl(o.transparent_result) : null, previewUrl: o.preview ? publicUrl(o.preview) : null });
      if (req.method === 'GET' && p === '/api/gallery') return json(res, 200, { gallery: env.GALLERY_TITLE || 'סרטוני הוקרה לתומכים', templates: store.templates().filter(t => t.enabled !== false).map(templateView) });
      if (req.method === 'POST' && p === '/api/templates') {
        const tid = (url.searchParams.get('id') || newId('tpl')).replace(/[^a-z0-9_-]/gi, '-').toLowerCase(), raw = path.join(MEDIA, 'templates', `${tid}.upload.mp4`);
        fs.writeFileSync(raw, await readBody(req));
        const info = await prepareTemplate(raw, path.join(MEDIA, 'templates', `${tid}.mp4`), { trimStart: +url.searchParams.get('trimStart') || 0, trimEnd: +url.searchParams.get('trimEnd') || 0 }); fs.unlinkSync(raw);
        return json(res, 201, templateView(store.saveTemplate({ id: tid, title: url.searchParams.get('title') || tid, file: `templates/${tid}.mp4`, modes: (url.searchParams.get('modes') || 'replace,add').split(','), character: url.searchParams.get('character') || 'the main character', layer: url.searchParams.get('layer') || 'front', ...info, created: new Date().toISOString() })));
      }
      if (req.method === 'DELETE' && p.startsWith('/api/templates/')) { store.saveTemplate({ ...store.template(p.split('/').pop()), enabled: false }); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && p === '/api/avatars') {
        const aid = newId('av'), ext = { 'image/png': '.png', 'image/webp': '.webp' }[req.headers['content-type']] || '.jpg', file = `avatars/${aid}${ext}`;
        fs.writeFileSync(path.join(MEDIA, file), await readBody(req));
        return json(res, 201, { ...store.saveAvatar({ id: aid, name: url.searchParams.get('name') || '', file, created: new Date().toISOString() }), url: publicUrl(file) });
      }
      // { templateId, avatarId, mode: replace|add, layer: front|background, supporterName, resolution, callbackUrl }
      if (req.method === 'POST' && p === '/api/orders') {
        const b = JSON.parse((await readBody(req)).toString() || '{}'), t = store.template(b.templateId), a = store.avatar(b.avatarId);
        if (!t) return json(res, 400, { error: 'unknown templateId' });
        if (!a) return json(res, 400, { error: 'unknown avatarId' });
        const mode = b.mode === 'add' ? 'add' : 'replace';
        if (!t.modes.includes(mode)) return json(res, 400, { error: `template does not allow mode ${mode}` });
        const layer = b.layer === 'background' || b.layer === 'back' ? 'background' : b.layer === 'front' ? 'front' : (b.transparent === false ? 'background' : b.transparent === true ? 'front' : (t.layer === 'back' ? 'background' : t.layer || 'front'));
        const o = store.saveOrder({ id: newId('ord'), templateId: t.id, avatarId: a.id, mode, supporterName: b.supporterName || a.name || '', transparent: layer === 'front', resolution: b.resolution === '720p' ? '720p' : '1080p', callbackUrl: b.callbackUrl || null, status: 'queued', created: new Date().toISOString() });
        kick(); return json(res, 202, orderView(o));
      }
      if (req.method === 'GET' && p.startsWith('/api/orders/')) { const o = store.order(p.split('/').pop()); return o ? json(res, 200, orderView(o)) : json(res, 404, { error: 'not found' }); }
      if (req.method === 'GET' && p === '/api/orders') return json(res, 200, store.orders().slice(-100).reverse().map(orderView));
      if (req.method === 'GET' && p === '/api/costs') return json(res, 200, store.costs());
      if (req.method === 'GET' && p === '/api/kling/units') return json(res, 200, await unitsLeft(env));
      return json(res, 404, { error: 'no route' });
    }
    return json(res, 404, { error: 'no route' });
  } catch (e) { console.error(e); json(res, 500, { error: String(e.message || e) }); }
});

// ---- worker: up to KLING_CONCURRENCY orders at once ----
let running = 0;
function kick() {
  const max = Number(env.KLING_CONCURRENCY || 3);
  for (const o of store.pending()) {
    if (running >= max) return; if (o.status !== 'queued') continue;
    running++; store.saveOrder({ ...o, status: 'processing', started: new Date().toISOString() });
    runOrder({ order: store.order(o.id), store, env, MEDIA, publicUrl })
      .catch(e => { console.error('order', o.id, e.message); store.saveOrder({ ...store.order(o.id), status: 'failed', error: String(e.message || e), finished: new Date().toISOString() }); })
      .finally(async () => { running--; const o2 = store.order(o.id); if (o2?.callbackUrl) try { await fetch(o2.callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o2) }); } catch {} kick(); });
  }
}

// ---- inbox: drop a video into media/inbox and it becomes a template (optional sidecar <name>.json) ----
let scanning = false;
async function scanInbox() {
  if (scanning) return; scanning = true; const dir = path.join(MEDIA, 'inbox');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp4|mov)$/i.test(f)) continue;
      const src = path.join(dir, f), s1 = fs.statSync(src).size; await new Promise(r => setTimeout(r, 2000)); if (fs.statSync(src).size !== s1) continue;
      const base = f.replace(/\.(mp4|mov)$/i, ''), tid = base.replace(/[^a-z0-9_-]/gi, '-').toLowerCase(), sideFile = path.join(dir, `${base}.json`), side = fs.existsSync(sideFile) ? JSON.parse(fs.readFileSync(sideFile, 'utf8')) : {};
      try {
        const info = await prepareTemplate(src, path.join(MEDIA, 'templates', `${tid}.mp4`), { trimStart: side.trimStart || 0, trimEnd: side.trimEnd || 0 });
        store.saveTemplate({ id: tid, title: side.title || base, file: `templates/${tid}.mp4`, modes: side.modes || ['replace', 'add'], character: side.character || 'the main character', layer: side.layer || 'front', order: side.order, prompts: side.prompts, ...info, created: new Date().toISOString() });
        fs.renameSync(src, path.join(dir, 'done', f)); if (fs.existsSync(sideFile)) fs.renameSync(sideFile, path.join(dir, 'done', `${base}.json`));
        console.log('inbox: imported', tid);
      } catch (e) { console.error('inbox: failed', f, e.message); fs.renameSync(src, path.join(dir, 'failed', f)); fs.writeFileSync(path.join(dir, 'failed', `${base}.error.txt`), String(e.message)); }
    }
  } finally { scanning = false; }
}

// ---- seed: real results made before this server existed (media/results/seed-*) ----
function seed() {
  const r = path.join(MEDIA, 'results'), have = f => fs.existsSync(path.join(r, f));
  const add = (oid, o) => { if (!store.order(oid)) store.saveOrder({ id: oid, templateId: 'lion-knight', avatarId: null, mode: 'replace', status: 'succeeded', engine: 'kling-4.0', created: '2026-11-11T17:54:00Z', finished: '2026-11-11T18:10:00Z', seeded: true, ...o }); };
  if (have('seed-lion-supporter1.mp4')) add('seed-lion-supporter1', { supporterName: 'תומך 1', result: 'results/seed-lion-supporter1.mp4', transparent: false });
  if (have('seed-lion-supporter2.mp4')) add('seed-lion-supporter2', { supporterName: 'תומך 2', result: 'results/seed-lion-supporter2.mp4', transparent: false });
  if (have('seed-lion-gift-s1.alpha.webm')) add('seed-lion-gift-s1', { supporterName: 'תומך 1 (מתנה)', result: 'results/seed-lion-gift-s1.mp4', transparent_result: 'results/seed-lion-gift-s1.alpha.webm', transparent: true });
}

for (const o of store.orders()) if (o.status === 'processing') store.saveOrder({ ...o, status: 'queued' });
seed(); setInterval(scanInbox, 10000); scanInbox();
setInterval(() => store.flush(), 60000); // persists the probe cache
server.listen(PORT, () => { console.log(`WANNA Studio Server on http://localhost:${PORT}  gallery=/  live-fx=/fx/  studio-upstream=/api/set  dryRun=${env.DRY_RUN === '1'}`); kick(); });
