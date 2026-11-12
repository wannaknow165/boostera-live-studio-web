// Live-effects routes (the streamer panel at /fx/): remix jobs, phone screen over ADB, saving recordings/tracks.
// The panel lives in ./fx (fx-engine.js, index.html, builder/, effects/).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function fxRoutes({ FX }) {
  const EFFECTS = path.join(FX, 'effects');
  const safe = s => String(s || 'default').replace(/[^\w֐-׿-]+/g, '_').slice(0, 40);
  const remixPaths = (fxDir, streamer) => {
    const dir = path.normalize(path.join(EFFECTS, fxDir || '', 'remix'));
    if (!fxDir || !dir.startsWith(EFFECTS + path.sep)) throw new Error('bad fx');
    const n = safe(streamer);
    return { dir, jpg: path.join(dir, n + '.jpg'), mp4: path.join(dir, n + '.mp4'), json: path.join(dir, n + '.json'), url: `/fx/effects/${fxDir}/remix/${encodeURIComponent(n)}.mp4` };
  };

  function remixStart(req, res, u) {
    const fxDir = u.searchParams.get('fx'), p = remixPaths(fxDir, u.searchParams.get('streamer')); fs.mkdirSync(p.dir, { recursive: true });
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      fs.writeFileSync(p.jpg, Buffer.concat(chunks));
      const tmp = p.mp4.replace(/\.mp4$/, '.part.mp4');
      fs.writeFileSync(p.json, JSON.stringify({ status: 'running', started: Date.now() }));
      const job = spawn(process.execPath, [path.join(FX, 'builder', 'remix.mjs'), path.join(EFFECTS, fxDir), p.jpg, tmp]);
      let out = ''; job.stdout.on('data', d => { out += d; }); job.stderr.on('data', d => { out += d; });
      job.on('exit', code => {
        if (code === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, p.mp4); fs.writeFileSync(p.json, JSON.stringify({ status: 'done', finished: Date.now(), cost: (out.match(/cost ([\d.]+)/) || [])[1] || null })); console.log('remix done', fxDir, path.basename(p.mp4)); }
        else { fs.writeFileSync(p.json, JSON.stringify({ status: 'failed', error: out.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) })); console.log('remix failed', fxDir, out.slice(-300)); }
      });
      res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'running' }));
    });
  }
  function remixStatus(res, u) {
    const p = remixPaths(u.searchParams.get('fx'), u.searchParams.get('streamer'));
    let s = { status: 'none' }; try { s = JSON.parse(fs.readFileSync(p.json, 'utf8')); } catch {}
    if (s.status === 'running' && Date.now() - s.started > 15 * 60000) s = { status: 'failed', error: 'timeout' };
    if (s.status !== 'done' && fs.existsSync(p.mp4)) s = { status: 'done' };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ...s, url: s.status === 'done' ? p.url + '?v=' + (s.finished || 1) : null }));
  }

  // ---- PHONE SCREEN over ADB ----
  // One shared pipeline (adb screenrecord -> ffmpeg -> JPEG frames) for everyone who asks:
  //   GET /phone.mjpeg            live MJPEG stream (the panel's "טלפון" source);  ?need=tiktok = only while TikTok is in front
  //   GET /phone.jpg              the latest frame as one picture
  //   GET /phone.jpg?need=tiktok  the same, but ONLY while TikTok is the app in front on the phone (the opponent-face
  //                               watcher asks like this, so nothing is ever captured from WhatsApp, the browser, …)
  //   GET /phone-info             which phone is used and which app is in front on it
  // screenrecord only sends a frame when the screen CHANGES and stops after 3 minutes, so the pipeline restarts in a
  // loop, and when the screen is standing still we fall back to a real screenshot (adb screencap).
  const SIZE = process.env.PHONE_SIZE || '720x1600';
  const TIKTOK = /musically|ugc\.trill|tiktok/i;
  const hub = { clients: new Set(), last: null, lastAt: 0, sentAt: 0, running: false, lastUse: 0, plainUse: 0, gen: 0, adb: null, ff: null, serial: null };

  // Which phone? ADB_SERIAL (server.env) decides. Otherwise, of the phones connected: the one with TikTok in front,
  // else the one used so far, else the first. The answer is kept for a few seconds (asking adb costs ~0.3 s).
  const adbOut = (args, ms = 6000) => new Promise(done => {
    let out = '', p; try { p = spawn('adb', args); } catch { return done(''); }
    const t = setTimeout(() => { try { p.kill(); } catch {} }, ms);
    p.stdout.on('data', d => { out += d; }); p.on('error', () => { clearTimeout(t); done(''); }); p.on('close', () => { clearTimeout(t); done(out); });
  });
  const topApp = async s => (/ResumedActivity[=:] ?ActivityRecord\{\S+ \S+ ([^/\s]+)\//.exec(await adbOut(['-s', s, 'shell', "dumpsys activity activities | grep -m 1 -E 'topResumedActivity|mResumedActivity'"])) || [])[1] || '';
  const ph = { serial: null, app: '', tiktok: false, count: 0, at: 0, busy: null };
  function phone(maxAge = 5000) {
    if (Date.now() - ph.at < maxAge) return Promise.resolve(ph);
    return ph.busy ||= (async () => {
      try {
        let list = process.env.ADB_SERIAL ? [process.env.ADB_SERIAL]
          : (await adbOut(['devices'])).split(/\r?\n/).slice(1).map(l => l.trim().split(/\s+/)).filter(a => a[1] === 'device').map(a => a[0]);
        const cable = list.filter(s => !/:|_adb-tls/.test(s)); if (cable.length) list = cable; // a phone on cable AND Wi-Fi is listed twice
        let serial = list.includes(ph.serial) ? ph.serial : list[0] || null, app = '';
        for (const s of [serial, ...list.filter(x => x !== serial)].filter(Boolean)) {
          const a = await topApp(s); if (s === serial) app = a;
          if (TIKTOK.test(a)) { serial = s; app = a; break; }
        }
        Object.assign(ph, { serial, app, tiktok: TIKTOK.test(app), count: list.length, at: Date.now() });
        if (hub.running && hub.serial && serial && hub.serial !== serial) { hub.gen++; hub.last = null; try { hub.adb?.kill(); hub.ff?.kill(); } catch {} } // another phone took over -> nothing more is taken from the old recorder; the stream restarts on the new phone
      } finally { ph.busy = null; }
      return ph;
    })();
  }

  const part = jpg => `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`;
  // "TikTok is the app in front" is believed only while the answer is fresh (it is asked every second while a TikTok-only viewer is attached)
  const tiktokNow = () => ph.tiktok && Date.now() - ph.at < 2500;
  function frame(jpg) {
    hub.last = jpg; hub.lastAt = Date.now();
    if (hub.lastAt - hub.sentAt < 28) return; hub.sentAt = hub.lastAt;                 // cap the stream at ~35 fps
    const tk = tiktokNow();
    for (const r of hub.clients) { if (r.writableLength > 3e6 || (r.needTiktok && !tk)) continue; r.write(part(jpg)); r.write(jpg); r.write('\r\n'); } // skip slow clients, and TikTok-only viewers unless TikTok was seen in front a moment ago
  }
  async function run() {
    if (!hub.running) return;
    const { serial } = await phone(15000);
    if (!hub.running) return;
    if (!serial) return void setTimeout(run, 3000);          // no phone connected (yet)
    hub.serial = serial; const gen = ++hub.gen;         // pictures of an older recorder (another phone, one that was stopped) are never accepted
    const t0 = Date.now(); let buf = Buffer.alloc(0);
    const adb = hub.adb = spawn('adb', ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--size', SIZE, '--bit-rate', '8000000', '-']);
    const ff = hub.ff = spawn('ffmpeg', ['-v', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0', '-use_wallclock_as_timestamps', '1', '-f', 'h264', '-i', '-', '-fps_mode', 'vfr', '-fpsmax', '30', '-flush_packets', '1', '-f', 'mpjpeg', '-q:v', '4', '-']);
    adb.on('error', () => {}); ff.on('error', () => {}); ff.stdin.on('error', () => {});
    adb.stdout.pipe(ff.stdin);
    ff.stdout.on('data', d => {
      if (gen !== hub.gen) return;
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {                                           // split ffmpeg's multipart output into whole JPEG frames
        const h = buf.indexOf('\r\n\r\n'); if (h < 0) break;
        const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, h).toString('latin1'));
        if (!m) { buf = buf.subarray(h + 4); continue; }
        const n = +m[1]; if (buf.length < h + 4 + n) break;
        frame(Buffer.from(buf.subarray(h + 4, h + 4 + n))); buf = buf.subarray(h + 4 + n);
      }
      if (buf.length > 3e7) buf = Buffer.alloc(0);
    });
    // screenrecord ended (3-minute limit) -> start again; ended at once (no phone) -> retry slowly
    adb.on('exit', () => { try { ff.stdin.end(); } catch {} if (hub.running && hub.adb === adb) setTimeout(run, Date.now() - t0 < 2000 ? 3000 : 300); });
  }
  function ensure() { hub.lastUse = Date.now(); if (hub.running) return; hub.running = true; run(); }
  function stop() { hub.running = false; hub.gen++; try { hub.adb?.kill(); hub.ff?.kill(); } catch {} hub.adb = hub.ff = null; hub.last = null; }
  // is the recorder running only for TikTok-only viewers (nobody plainly mirrors the phone, now or in the last 20 s)?
  const tiktokOnly = () => ![...hub.clients].some(r => !r.needTiktok) && Date.now() - hub.plainUse > 20000;
  // TikTok is not the app in front: TikTok-only viewers get nothing more. Their streams are ended (the page then forgets
  // its picture at once) and, unless somebody is plainly mirroring the phone, the recorder stops: nothing is captured.
  function leftTiktok() {
    for (const r of [...hub.clients]) if (r.needTiktok) { hub.clients.delete(r); try { r.end(); } catch {} }
    if (hub.running && tiktokOnly()) stop();
  }
  // while a TikTok-only stream is attached, ask every second which app is in front
  setInterval(() => { if ([...hub.clients].some(r => r.needTiktok)) phone(400).then(p => { if (!p.tiktok) leftTiktok(); }).catch(() => {}); }, 1000).unref();
  setInterval(() => {
    if (hub.running && !hub.clients.size && Date.now() - hub.lastUse > 20000) stop();    // nobody watching -> stop
    else if (hub.running && tiktokOnly()) phone(4000).then(p => { if (!p.tiktok) leftTiktok(); }).catch(() => {}); // running only for the opponent watcher: another app in front -> stop
    else if (hub.running && !process.env.ADB_SERIAL) phone(20000);                       // several phones: follow the one in TikTok
  }, 5000).unref();

  let capBusy = null, capAt = 0, capLast = null, capSerial = null;
  function screencap(maxAge = 1500) { // one real screenshot -> JPEG. Slow (~1 s), so one at a time and cached for 1.5 s
    if (capLast && capSerial === ph.serial && Date.now() - capAt < maxAge) return Promise.resolve(capLast);
    return capBusy ||= (async () => {
      try {
        const { serial } = await phone(15000); if (!serial) return null;
        return await new Promise(done => {
          const adb = spawn('adb', ['-s', serial, 'exec-out', 'screencap', '-p']);
          const ff = spawn('ffmpeg', ['-v', 'error', '-f', 'png_pipe', '-i', '-', '-vf', `scale=${SIZE.split('x')[0]}:-2`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', '-']);
          const out = []; adb.on('error', () => {}); ff.on('error', () => done(null)); ff.stdin.on('error', () => {});
          adb.stdout.pipe(ff.stdin); ff.stdout.on('data', d => out.push(d));
          const t = setTimeout(() => { try { adb.kill(); ff.kill(); } catch {} }, 8000);
          ff.on('close', () => { clearTimeout(t); const b = Buffer.concat(out); if (b.length > 1000) { capLast = b; capAt = Date.now(); capSerial = serial; done(b); } else done(null); });
        });
      } finally { capBusy = null; }
    })();
  }
  const fresh = ms => hub.last && Date.now() - hub.lastAt < ms;

  async function phoneStream(req, res, u) {
    const need = u.searchParams.get('need') === 'tiktok';
    if (need) { // the opponent watcher: only while TikTok is the app in front (asked again every second while it runs)
      const p = await phone(900), fail = (code, error) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); };
      if (res.destroyed || req.socket.destroyed) return;   // the viewer left while adb was being asked (it must not be kept as a viewer for ever)
      if (!p.serial) return fail(503, 'no phone (is it connected with adb?)');
      if (!p.tiktok) { leftTiktok(); return fail(409, 'TikTok is not the app in front on the phone'); }
      res.needTiktok = true;
    }
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' }); res.flushHeaders();
    ensure(); hub.clients.add(res); if (!need) hub.plainUse = Date.now();
    const hello = jpg => { if (jpg && hub.clients.has(res) && (!need || tiktokNow())) { res.write(part(jpg)); res.write(jpg); res.write('\r\n'); } };
    // show something at once: the latest frame, or (screen standing still) a screenshot
    const age = need ? 1000 : 3000;                        // (a TikTok-only viewer: only a picture taken in the last second)
    if (fresh(age)) hello(hub.last); else screencap(need ? 700 : 1500).then(j => { if (!fresh(age)) hello(j); });
    res.on('close', () => { hub.clients.delete(res); hub.lastUse = Date.now(); if (!need) hub.plainUse = Date.now(); });
  }
  async function phoneSnapshot(req, res, u) {
    const need = u.searchParams.get('need'), tk = need === 'tiktok', p = await phone(tk ? 900 : need ? 4000 : 15000);
    const fail = (code, error) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error, app: p.app || null, phones: p.count })); };
    if (!p.serial) return fail(503, 'no phone (is it connected with adb?)');
    if (tk && !p.tiktok) { leftTiktok(); return fail(409, 'TikTok is not the app in front on the phone'); } // nothing is captured
    if (!tk) hub.plainUse = Date.now();
    ensure();
    const age = tk ? 1000 : 4000;                          // a TikTok-only viewer gets only a picture taken in the last second, never an older one
    for (let i = 0; i < (tk ? 5 : 15) && !fresh(age); i++) await new Promise(r => setTimeout(r, 100));
    let jpg = fresh(age) ? hub.last : await screencap(tk ? 700 : 1500);                   // still screen -> screenshot
    if (!tk) jpg ||= hub.last;
    // ...and TikTok is asked about again AFTER the picture was taken: it is sent only if TikTok was in front before and after it
    if (tk) { if (ph.busy) await ph.busy.catch(() => {}); if (!(await phone(0)).tiktok) { leftTiktok(); return fail(409, 'TikTok is not the app in front on the phone'); } }
    if (!jpg) return fail(503, 'no picture from the phone');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length, 'Cache-Control': 'no-store', 'X-Phone-App': p.tiktok ? 'tiktok' : 'other' }); res.end(jpg);
  }
  async function phoneInfo(res) {
    const p = await phone(3000);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ connected: !!p.serial, phones: p.count, serial: p.serial, app: p.app || null, tiktok: p.tiktok, fixed: !!process.env.ADB_SERIAL }));
  }

  // POST /save?path=fx/effects/... (tracking) or ?name=x.webm (recordings -> fx/test/out)
  function save(req, res, u) {
    const p = u.searchParams.get('path');
    let f = path.join(FX, 'test', 'out', path.basename(u.searchParams.get('name') || 'run.webm'));
    if (p) { f = path.normalize(path.join(FX, p)); if (!f.startsWith(EFFECTS + path.sep)) { res.writeHead(400); return res.end('bad path'); } }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const w = fs.createWriteStream(f); req.pipe(w); w.on('finish', () => res.end(f));
  }

  // list remixes ready per effect (for the catalog)
  function remixList(fxDir) {
    const d = path.join(EFFECTS, fxDir, 'remix'); if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter(f => f.endsWith('.mp4') && !f.endsWith('.part.mp4')).map(f => ({ streamer: f.replace(/\.mp4$/, ''), url: `/fx/effects/${fxDir}/remix/${encodeURIComponent(f)}` }));
  }

  // handle(): returns true if the request was handled. These routes show the phone screen, write files and spend
  // AI credit, so they need "authed" (this computer itself, or the studio key).
  function handle(req, res, u, authed) {
    const p = u.pathname.replace(/^\/fx\//, '/');
    const route = req.method === 'POST' && p === '/remix' ? () => remixStart(req, res, u)
      : p === '/remix-status' ? () => remixStatus(res, u)
      : p === '/phone.mjpeg' ? () => phoneStream(req, res, u)
      : p === '/phone.jpg' ? () => phoneSnapshot(req, res, u)
      : p === '/phone-info' ? () => phoneInfo(res)
      : req.method === 'POST' && p === '/save' ? () => save(req, res, u) : null;
    if (!route) return false;
    if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'studio key required (x-key or ?ck=)' })); return true; }
    route(); return true;
  }
  return { handle, remixList };
}
