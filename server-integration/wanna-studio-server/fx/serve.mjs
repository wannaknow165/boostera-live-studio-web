// Local static server for the FX panel + POST /save to store recordings in test/out.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8795);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm' };
fs.mkdirSync(path.join(ROOT, 'test', 'out'), { recursive: true });
// Phone screen over ADB -> MJPEG stream (/phone.mjpeg). screenrecord stops after 3 min, so it restarts in a loop.
import { spawn } from 'node:child_process';
const ADB_SERIAL = process.env.ADB_SERIAL || '';
function phoneStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg', 'Cache-Control': 'no-store' });
  let closed = false, adb, ff;
  const start = () => {
    if (closed) return;
    const a = [...(ADB_SERIAL ? ['-s', ADB_SERIAL] : []), 'exec-out', 'screenrecord', '--output-format=h264', '--size', '720x1600', '--bit-rate', '6000000', '-'];
    adb = spawn('adb', a); ff = spawn('ffmpeg', ['-v', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0', '-use_wallclock_as_timestamps', '1', '-f', 'h264', '-i', '-', '-f', 'mpjpeg', '-q:v', '5', '-r', '24', '-']);
    adb.stdout.pipe(ff.stdin); ff.stdout.on('data', d => { if (!closed) res.write(d); });
    adb.on('exit', () => { try { ff.stdin.end(); } catch {} setTimeout(start, 300); });
    adb.stderr.on('data', d => console.log('adb:', String(d).trim())); ff.stderr.on('data', d => console.log('ffmpeg:', String(d).trim()));
  };
  start();
  // res, not req: req 'close' fires right after a GET is read in Node 24
  res.on('close', () => { closed = true; try { adb.kill(); ff.kill(); } catch {} });
}

// REMIX jobs: POST /remix?fx=<effect dir>&streamer=<name>  (body: jpeg frame of the streamer)
//   -> generates effects/<dir>/remix/<streamer>.mp4 in the background (builder/remix.mjs)
// GET /remix-status?fx=&streamer=  -> { status: none|running|done|failed, url, started, error }
const safe = s => String(s || 'default').replace(/[^\w֐-׿-]+/g, '_').slice(0, 40);
function remixPaths(fxDir, streamer) {
  const dir = path.normalize(path.join(ROOT, 'effects', fxDir, 'remix'));
  if (!dir.startsWith(path.join(ROOT, 'effects') + path.sep)) throw new Error('bad fx');
  const n = safe(streamer); return { dir, jpg: path.join(dir, n + '.jpg'), mp4: path.join(dir, n + '.mp4'), json: path.join(dir, n + '.json'), url: `/effects/${fxDir}/remix/${encodeURIComponent(n)}.mp4` };
}
function remixStart(req, res, u) {
  const p = remixPaths(u.searchParams.get('fx'), u.searchParams.get('streamer')); fs.mkdirSync(p.dir, { recursive: true });
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    fs.writeFileSync(p.jpg, Buffer.concat(chunks));
    const tmp = p.mp4.replace(/\.mp4$/, '.part.mp4');
    fs.writeFileSync(p.json, JSON.stringify({ status: 'running', started: Date.now() }));
    const job = spawn(process.execPath, [path.join(ROOT, 'builder', 'remix.mjs'), path.join(ROOT, 'effects', u.searchParams.get('fx')), p.jpg, tmp]);
    let out = ''; job.stdout.on('data', d => { out += d; console.log('remix:', String(d).trim()); }); job.stderr.on('data', d => { out += d; console.log('remix err:', String(d).trim()); });
    job.on('exit', code => {
      if (code === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, p.mp4); const cost = (out.match(/cost ([\d.]+)/) || [])[1]; fs.writeFileSync(p.json, JSON.stringify({ status: 'done', finished: Date.now(), cost })); }
      else fs.writeFileSync(p.json, JSON.stringify({ status: 'failed', error: out.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) }));
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

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/phone.mjpeg') return phoneStream(req, res);
  try {
    if (req.method === 'POST' && u.pathname === '/remix') return remixStart(req, res, u);
    if (u.pathname === '/remix-status') return remixStatus(res, u);
  } catch (e) { res.writeHead(400); return res.end(e.message); }
  if (req.method === 'POST' && u.pathname === '/save') {
    // ?path=effects/<id>/... writes inside the effects folder (tracking results); otherwise test/out/<name>
    const p = u.searchParams.get('path');
    let f = path.join(ROOT, 'test', 'out', path.basename(u.searchParams.get('name') || 'run.webm'));
    if (p) { f = path.normalize(path.join(ROOT, p)); if (!f.startsWith(path.join(ROOT, 'effects') + path.sep)) { res.writeHead(400); return res.end('bad path'); } fs.mkdirSync(path.dirname(f), { recursive: true }); }
    const w = fs.createWriteStream(f); req.pipe(w); w.on('finish', () => { res.end(f); }); return;
  }
  const file = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const size = fs.statSync(file).size, type = MIME[path.extname(file)] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) { const s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : size - 1; res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 }); fs.createReadStream(file, { start: s, end: e }).pipe(res); }
  else { res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res); }
}).listen(PORT, '127.0.0.1', () => console.log(`WANNA Live FX on http://127.0.0.1:${PORT}`));
