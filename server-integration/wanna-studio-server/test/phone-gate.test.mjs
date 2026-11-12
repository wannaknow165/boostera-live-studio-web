// The phone picture for the opponent watcher (?need=tiktok) must be given ONLY while TikTok is the app in front.
// This test drives lib/fx-routes.mjs with a pretend phone (adb and ffmpeg are replaced), so no real phone is touched:
//   node --experimental-test-module-mocks --test test/phone-gate.test.mjs
// Every pretend picture is 2000 bytes of the letter "T" (taken while TikTok was in front) or "O" (another app).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const TIKTOK = 'com.zhiliaoapp.musically', OTHER = 'com.whatsapp';
const phone = { app: TIKTOK, devices: ['FAKE1'], spawned: [], adbDelay: 60 };
const tag = () => (phone.app === TIKTOK ? 'T' : 'O');

function proc(kind) {
  const p = new EventEmitter(); p.kind = kind; p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough(); p.stdin.resume(); p.killed = false;
  p.finish = () => { if (p.done) return; p.done = true; clearInterval(p.timer); clearTimeout(p.timer); p.stdout.end(); setImmediate(() => { p.emit('exit', 0, null); p.emit('close', 0); }); };
  p.kill = () => { p.killed = true; p.finish(); return true; };
  phone.spawned.push(p); setImmediate(() => p.timer?.unref?.()); return p; // (the pretend processes never keep the test alive)
}
function fakeSpawn(cmd, args) {
  const a = args.join(' ');
  if (cmd === 'adb' && args[0] === 'devices') { const p = proc('devices'); p.timer = setTimeout(() => { p.stdout.write('List of devices attached\n' + phone.devices.map(s => s + '\tdevice').join('\n') + '\n'); p.finish(); }, phone.adbDelay); return p; }
  if (cmd === 'adb' && a.includes('dumpsys')) { const p = proc('top'); p.timer = setTimeout(() => { p.stdout.write(`    topResumedActivity=ActivityRecord{1a2b3c u0 ${phone.app}/.MainActivity t42}\n`); p.finish(); }, phone.adbDelay); return p; }
  if (cmd === 'adb' && a.includes('screenrecord')) return proc('record');                       // its video goes into the pretend ffmpeg below
  if (cmd === 'adb' && a.includes('screencap')) { const p = proc('cap'); p.timer = setTimeout(() => p.finish(), 30); return p; }
  if (cmd === 'ffmpeg' && a.includes('mpjpeg')) { const p = proc('frames'); p.timer = setInterval(() => { const jpg = Buffer.alloc(2000, tag()); p.stdout.write(Buffer.concat([Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${jpg.length}\r\n\r\n`), jpg, Buffer.from('\r\n')])); }, 33); return p; }
  if (cmd === 'ffmpeg' && a.includes('png_pipe')) { const p = proc('shot'); p.timer = setTimeout(() => { p.stdout.write(Buffer.alloc(3000, tag())); p.finish(); }, 120); return p; }
  const p = proc('other'); setImmediate(() => p.finish()); return p;
}
mock.module('node:child_process', { namedExports: { spawn: fakeSpawn } }); // (Node 24 prints a deprecation note for this spelling; the newer one is not in Node 22)
const { fxRoutes } = await import('../lib/fx-routes.mjs');
const { handle } = fxRoutes({ FX: new URL('../fx', import.meta.url).pathname });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(20); return f(); };
function viewer(path, { gone = false } = {}) {
  const res = new EventEmitter(); Object.assign(res, { status: 0, chunks: [], ended: false, destroyed: gone, writableLength: 0, headers: null });
  res.writeHead = (c, h) => { res.status = c; res.headers = h; }; res.flushHeaders = () => {};
  res.write = b => { res.chunks.push(Buffer.from(b)); return true; };
  res.end = b => { if (b) res.chunks.push(Buffer.from(b)); res.ended = true; setImmediate(() => res.emit('close')); };
  res.pictures = () => res.chunks.filter(c => c.length >= 2000).map(c => String.fromCharCode(c[0]));
  res.leave = () => { res.destroyed = true; res.emit('close'); };
  const req = { method: 'GET', socket: { destroyed: gone } };
  assert.equal(handle(req, res, new URL('http://local' + path), true), true);
  return res;
}
const recording = () => phone.spawned.some(p => p.kind === 'record' && !p.done);

test('a TikTok-only stream runs only while TikTok is in front', async () => {
  phone.app = TIKTOK;
  const v = viewer('/fx/phone.mjpeg?need=tiktok');
  await sleep(3000);
  assert.equal(v.status, 200);
  const before = v.pictures();
  assert.ok(before.length > 50, 'pictures flow without gaps while TikTok is in front (got ' + before.length + ' in 3 s)');
  assert.ok(before.every(t => t === 'T'));

  phone.app = OTHER; const t0 = Date.now();                // the streamer opens another app in the middle of an effect
  assert.ok(await until(() => v.ended, 4000), 'the stream is ended by the server');
  const took = Date.now() - t0, leaked = v.pictures().filter(t => t === 'O').length;
  console.log(`   another app came to the front: stream closed after ${took} ms, ${leaked} pictures of it had already been sent to the local page`);
  assert.ok(took < 2200, 'closed within about two seconds (was ' + took + ' ms)');
  assert.ok(await until(() => !recording(), 1500), 'and the recorder is stopped: nothing more is captured');
  const n = v.pictures().length; await sleep(600); assert.equal(v.pictures().length, n, 'nothing is written after the end');
});

test('with another app in front a TikTok-only viewer gets nothing at all', async () => {
  phone.app = OTHER; await sleep(300);
  const s = viewer('/fx/phone.mjpeg?need=tiktok'); assert.ok(await until(() => s.ended, 2000)); assert.equal(s.status, 409); assert.equal(s.pictures().length, 0);
  const j = viewer('/fx/phone.jpg?need=tiktok'); assert.ok(await until(() => j.ended, 2000)); assert.equal(j.status, 409); assert.equal(j.pictures().length, 0);
  assert.equal(recording(), false, 'the recorder is not even started');
});

test('one picture: TikTok must be in front before AND after it is taken', async () => {
  phone.app = TIKTOK; await sleep(1000);                  // (a 'no' is remembered for 0.9 s: coming back to TikTok is believed only on a new check)
  const ok = viewer('/fx/phone.jpg?need=tiktok'); assert.ok(await until(() => ok.ended, 5000)); assert.equal(ok.status, 200); assert.deepEqual(ok.pictures(), ['T']);
  // the app changes while the picture is being fetched: the answer is "no", not a picture
  const late = viewer('/fx/phone.jpg?need=tiktok'); await sleep(20); phone.app = OTHER; // (before the second check has asked the phone)
  assert.ok(await until(() => late.ended, 5000)); assert.equal(late.status, 409, 'refused, although the first check said TikTok'); assert.equal(late.pictures().length, 0);
  assert.ok(await until(() => !recording(), 1500), 'and the recorder is stopped');
});

test('a plain viewer (the operator mirrors the phone on purpose) is not cut off, and keeps the recorder alive', async () => {
  phone.app = OTHER; await sleep(300);
  const plain = viewer('/fx/phone.mjpeg'); await sleep(1500);
  assert.equal(plain.status, 200); assert.ok(plain.pictures().length > 20); assert.equal(plain.ended, false);
  const tk = viewer('/fx/phone.mjpeg?need=tiktok'); assert.ok(await until(() => tk.ended, 2000)); assert.equal(tk.status, 409);
  assert.equal(recording(), true, 'the plain viewer still has its stream');
  plain.leave();
});

test('a viewer that left while adb was being asked is not kept', async () => {
  phone.app = TIKTOK; await sleep(2700);                   // (the last check is old now, so the next request really asks adb)
  const gone = viewer('/fx/phone.mjpeg?need=tiktok', { gone: true }); await sleep(600);
  assert.equal(gone.status, 0, 'nothing was written to it'); assert.equal(gone.pictures().length, 0);
});

test.after(() => { for (const p of phone.spawned) p.finish(); });
