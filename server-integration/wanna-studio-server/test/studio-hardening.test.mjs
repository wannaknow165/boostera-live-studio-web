// The studio server (server.mjs, :8800) serves the program page, which now receives the creator's camera. Two of its
// doors are narrowed (CAM LINK specification, section 11) and the program window gets a launcher (section 10):
//   1. "this computer needs no key" (isLocal): also the server's own Host, and never a page of another site;
//   2. POST /save: recordings and track files only, never a page, a script, effect.json or the effect list;
//   3. start-link.mjs: one program window, its own Chrome profile, nothing secret in its output.
// server.mjs listens the moment it is imported, so 1 and 2 are pure functions in lib/studio-guards.mjs; their wiring into
// server.mjs and lib/fx-routes.mjs is pinned by reading the source. The launcher runs here with a pretend gateway and a
// pretend browser. Nothing in this file starts the studio server, a browser, or touches a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localStudioRequest, localHosts, saveTarget, saveNameOk, savePathOk } from '../lib/studio-guards.mjs';
import { fxRoutes } from '../lib/fx-routes.mjs';
import { parseArgs, programUrl, chromeArgs, launch, findChrome, readProgramKey, profileInUse, DISABLED_FEATURES } from '../start-link.mjs';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = rel => fs.readFileSync(path.join(APP, rel), 'utf8');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// ---------------------------------------------------------------- 1. "this computer" ----------------------------------------------------------------
const PORT = 8800;
const request = (headers = {}, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:' + PORT, ...headers } });
const local = (headers, remoteAddress) => localStudioRequest(request(headers, remoteAddress), PORT);

test('a plain request from this computer is local: a loopback peer that addressed the server by its own name and port', () => {
  assert.equal(local(), true);
  assert.equal(local({ host: 'localhost:' + PORT }), true);
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(local({}, peer), true, peer);
  // our own pages (gallery, panels, clean layers, the program page): the browser says where the request came from
  assert.equal(local({ host: 'localhost:' + PORT, origin: 'http://localhost:' + PORT, 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(local({ 'sec-fetch-site': 'none' }), true, 'an address typed by the operator, a bookmark, a Studio button');
  assert.equal(local({ 'sec-fetch-site': 'same-site' }), true, 'another local page on the same host name');
});

test('a page of another site is not local, even in a browser on this computer', () => {
  assert.equal(local({ 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(local({ host: 'localhost:' + PORT, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }), false);
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(local({ 'sec-fetch-site': 'cross-site' }, peer), false, peer);
  // http://localhost:<other port> calling http://127.0.0.1:8800 is another site to the browser as well
  assert.equal(local({ origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' }), false);
});

test('a foreign Host is not local: another name, a rebinding name, another port, no Host at all', () => {
  // DNS rebinding: evil.example is pointed at 127.0.0.1, so the browser itself calls the request same-origin
  for (const host of ['evil.example', 'evil.example:' + PORT, '127.0.0.1.evil.example:' + PORT, 'localhost.evil.example:' + PORT])
    assert.equal(local({ host, 'sec-fetch-site': 'same-origin' }), false, 'rebinding: ' + host);
  for (const host of ['127.0.0.1:8801', 'localhost:9000', 'localhost', '127.0.0.1', '[::1]:' + PORT, '192.168.1.20:' + PORT, 'studio.lan:' + PORT, 'LOCALHOST:' + PORT, 'localhost:' + PORT + ' ', 'localhost:0' + PORT, ''])
    assert.equal(local({ host }), false, 'host: ' + JSON.stringify(host));
  assert.equal(localStudioRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, PORT), false, 'no Host header');
  assert.equal(localStudioRequest({ socket: { remoteAddress: '127.0.0.1' } }, PORT), false, 'no headers');
  assert.equal(localStudioRequest(request({ host: 'localhost:8810' }), 8810), true, 'the port is the one this server listens on, not a literal 8800');
  assert.equal(localStudioRequest(request({ host: 'localhost:8800' }), 8810), false);
});

test('a forwarded request is not local: a tunnel or a proxy on this computer also connects from loopback', () => {
  assert.equal(local({ 'cf-connecting-ip': '203.0.113.5' }), false);
  assert.equal(local({ 'x-forwarded-for': '203.0.113.5' }), false);
  assert.equal(local({ host: 'localhost:' + PORT, 'x-forwarded-for': '127.0.0.1', 'sec-fetch-site': 'same-origin' }), false);
});

test('a peer that is not loopback is never local, whatever its headers say', () => {
  for (const remoteAddress of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', '203.0.113.5', 'fe80::1', '127.0.0.2', '', undefined])
    assert.equal(localStudioRequest({ socket: { remoteAddress }, headers: { host: 'localhost:' + PORT, 'sec-fetch-site': 'same-origin' } }, PORT), false, String(remoteAddress));
  assert.equal(localStudioRequest({ headers: { host: 'localhost:' + PORT } }, PORT), false, 'no socket');
});

test('a server on port 80 is addressed without the port', () => {
  assert.deepEqual(localHosts(8800), ['127.0.0.1:8800', 'localhost:8800']);
  for (const host of ['localhost', '127.0.0.1', 'localhost:80', '127.0.0.1:80']) assert.equal(localStudioRequest(request({ host }), 80), true, host);
  assert.equal(localStudioRequest(request({ host: 'evil.example' }), 80), false);
  assert.equal(localStudioRequest(request({ host: 'localhost:8800' }), 80), false);
});

// a small server that judges every request with the rule, on a real loopback socket
async function judge() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, local: localStudioRequest(req, server.address().port), host: req.headers.host, site: req.headers['sec-fetch-site'], peer: req.socket.remoteAddress });
    req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, rows: [], clips: [], liveEffects: 0, templates: 0 }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ask = (route, headers = {}) => new Promise((ok, bad) => http.request({ host: '127.0.0.1', port, path: route, headers }, r => { r.resume(); r.on('end', ok); }).on('error', bad).end());
  return { seen, port, ask, last: () => seen[seen.length - 1], close: () => new Promise(r => server.close(r)) };
}

test('programs on this computer stay local: Node sends its real Host and no Sec-Fetch-Site (http.request and fetch)', async () => {
  const j = await judge();
  try {
    // the two ways the gateway and its workspace call the studio server (mobile-gateway.mjs proxy(), lib/mobile-workspace.mjs upstream())
    await j.ask('/api/catalog', { 'x-key': 'studio-key-test' });
    assert.deepEqual([j.last().local, j.last().host, j.last().site], [true, '127.0.0.1:' + j.port, undefined]);
    await (await fetch('http://127.0.0.1:' + j.port + '/api/overlays', { headers: { 'x-api-key': 'api-test', 'x-key': 'studio-key-test' } })).arrayBuffer();
    assert.deepEqual([j.last().local, j.last().host, j.last().site], [true, '127.0.0.1:' + j.port, undefined], 'fetch adds no Sec-Fetch-Site');
    await (await fetch('http://127.0.0.1:' + j.port + '/api/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"stop"}' })).arrayBuffer();
    assert.deepEqual([j.last().local, j.last().site], [true, undefined], 'a POST with a body too');
    await j.ask('/health', { host: 'localhost:' + j.port });
    assert.equal(j.last().local, true, 'localhost:<port>');
    assert.ok(j.seen.every(s => ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(s.peer)), 'the peer address is one of the loopback spellings');
    // and over the same real socket the three refusals
    await j.ask('/x', { host: 'evil.example:' + j.port, 'sec-fetch-site': 'same-origin' }); assert.equal(j.last().local, false, 'rebinding Host');
    await j.ask('/x', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }); assert.equal(j.last().local, false, 'cross-site page');
    await j.ask('/x', { 'x-forwarded-for': '203.0.113.5' }); assert.equal(j.last().local, false, 'forwarded');
  } finally { await j.close(); }
});

test('the gateway\'s own calls reach the studio server as local requests', async () => {
  const { createMobileGateway } = await import('../mobile-gateway.mjs');
  const studio = await judge(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanna-hardening-'));
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const app = createMobileGateway({ port, upstreamPort: studio.port, workspaceRoot: root, apiKey: 'private-api-test', clientKey: 'private-client-test', env: {}, workspaceOptions: { tools: { ffmpeg: 'not-used', installed: false } } });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  try {
    const call = route => new Promise((ok, bad) => http.get({ host: '127.0.0.1', port, path: route }, r => { r.resume(); r.on('end', () => ok(r.statusCode)); }).on('error', bad));
    assert.equal(await call('/api/mobile/catalog'), 200); // proxy(): http.request to 127.0.0.1:<upstreamPort>
    assert.equal(await call('/api/mobile/session'), 200); // fetch of /health
    for (const url of ['/api/catalog', '/health']) {
      const s = studio.seen.find(x => x.url === url); assert.ok(s, 'the gateway asked the studio server for ' + url);
      assert.deepEqual([s.local, s.host, s.site], [true, '127.0.0.1:' + studio.port, undefined], url);
    }
  } finally { await new Promise(r => app.server.close(r)); await studio.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 2. POST /save ----------------------------------------------------------------
const TRACK = 'effects/face/anubis/green/track.json'; // what fx-engine.js really writes: effects/<group>/<effect>/<track from effect.json>

test('a recording or a builder track is saved by name: .webm or .json, a flat file name', () => {
  for (const name of ['run.webm', 'werelion-beast-run.webm', 'track-raven-witch-2.json', 'a.b-c_d.json', 'x'.repeat(80) + '.webm'])
    assert.deepEqual(saveTarget(name, null), { name }, name);
  assert.deepEqual(saveTarget(null, null), { name: 'run.webm' }, 'no name: run.webm, as before');
  assert.deepEqual(saveTarget('', ''), { name: 'run.webm' });
});

test('a tracking result is saved next to its effect: effects/<folders>/<file>.json', () => {
  for (const p of [TRACK, 'effects/full/ice-dragon-095/track.json', 'effects/body/demon-veins/green/track.json', 'effects/some-effect/track.json', 'effects/a/b/c/d/t.json'])
    assert.deepEqual(saveTarget(null, p), { name: 'run.webm', path: p }, p);
  assert.deepEqual(saveTarget('take-1.webm', TRACK), { name: 'take-1.webm', path: TRACK }, 'the path wins, as before');
});

test('every existing caller keeps working: what the four call sites build for the real effects', () => {
  const effects = path.join(APP, 'fx', 'effects'), index = json(path.join(effects, 'index.json'));
  const sent = (key, value) => new URL('http://x/save?' + key + '=' + value).searchParams.get(key); // what the server reads back from the query
  assert.ok(index.length >= 20, 'the effect list was read');
  let tracks = 0;
  for (const e of index) {
    // fx/index.html record():  fetch(`/save?name=${encodeURIComponent(name || id + '-run')}.webm`, …)
    assert.deepEqual(saveTarget(sent('name', encodeURIComponent(e.id + '-run') + '.webm'), null), { name: e.id + '-run.webm' });
    // fx/builder/track.html and track-layer.html:  fetch(`/save?name=track-${fx}.json`, …)  with ?fx=<effect id>
    assert.deepEqual(saveTarget(sent('name', 'track-' + e.id + '.json'), null), { name: 'track-' + e.id + '.json' });
    // fx/fx-engine.js loadEffect(base = 'effects/' + e.dir):  fetch(`/save?path=${encodeURIComponent(base + '/' + a.track)}`, …)
    const file = path.join(effects, e.dir, 'effect.json'); assert.ok(fs.existsSync(file), 'effect.json of ' + e.dir);
    for (const a of json(file).assets || []) if (a.type === 'layer' && a.track) {
      const p = 'effects/' + e.dir + '/' + a.track; tracks++;
      assert.deepEqual(saveTarget(null, sent('path', encodeURIComponent(p))), { name: 'run.webm', path: p }, p);
    }
  }
  assert.ok(tracks >= 1, 'at least one real layer effect with a track was checked');
  // every effect folder on disk, with its track beside effect.json or in a green/ folder
  let folders = 0;
  for (const group of fs.readdirSync(effects, { withFileTypes: true }).filter(d => d.isDirectory()))
    for (const fx of fs.readdirSync(path.join(effects, group.name), { withFileTypes: true }).filter(d => d.isDirectory())) {
      folders++;
      for (const track of ['track.json', 'green/track.json']) assert.equal(savePathOk(`effects/${group.name}/${fx.name}/${track}`), true, `${group.name}/${fx.name}/${track}`);
    }
  assert.ok(folders >= index.length, 'every effect folder was checked');
});

test('nobody else calls /save: a new caller has to be checked against the allow-list first', () => {
  // the four shapes proven above; fx/serve.mjs (the old stand-alone panel server) has a route of its own and is not a caller
  const known = { 'fx/index.html': ["`/save?name=${encodeURIComponent(name || id + '-run')}.webm`"], 'fx/fx-engine.js': ["`/save?path=${encodeURIComponent(base + '/' + a.track)}`"], 'fx/builder/track.html': ['`/save?name=track-${fxId}.json`'], 'fx/builder/track-layer.html': ['`/save?name=track-${fxDir}.json`'] };
  const callers = {};
  const walk = rel => { for (const d of fs.readdirSync(path.join(APP, rel), { withFileTypes: true })) {
    const at = rel + '/' + d.name;
    if (d.isDirectory()) { if (!['fx/effects', 'fx/assets', 'fx/test'].includes(at)) walk(at); continue; }
    if (!/\.(html|js|mjs)$/.test(d.name) || at === 'fx/serve.mjs') continue;
    const n = (read(at).match(/\/save(?![\w-])/g) || []).length; if (n) callers[at] = n;
  } };
  walk('fx'); walk('public');
  assert.deepEqual(Object.keys(callers).sort(), Object.keys(known).sort(), 'the files that mention /save');
  for (const [file, shapes] of Object.entries(known)) {
    for (const shape of shapes) assert.ok(read(file).includes('fetch(' + shape), file + ' still builds ' + shape);
    assert.equal(callers[file], shapes.length, file + ' has no second /save call');
  }
});

test('a page, a script, effect.json, the effect list, a way out of the folder and odd names are refused', () => {
  const badNames = ['x.html', 'x.htm', 'x.js', 'x.mjs', 'x.svg', 'x.css', 'x.json.html', 'x.webm.exe', 'x', 'x.WEBM', 'x.Json', '.json', '.webm',
    '../x.json', '..\\x.json', '../../index.html', 'a/b.json', 'a\\b.json', 'track-face/raven-witch.json', '/x.json', 'C:\\x.json', 'x.json/', 'x.json.', 'x.json ', ' x.json', 'x y.webm', 'x.json\n', 'x%2e.json',
    'x.json:stream', 'x'.repeat(81) + '.webm', 'שם.webm', 'CON.json', 'con.webm', 'nul.webm', 'NUL.x.json', 'aux.json', 'prn.webm', 'COM1.json', 'lpt9.webm'];
  for (const name of badNames) { assert.equal(saveNameOk(name), false, 'name ' + JSON.stringify(name)); assert.equal(saveTarget(name, null), null, 'target for ' + JSON.stringify(name)); }
  for (const name of ['console-run.webm', 'aux-track.json', 'nulls.json', 'com10.json']) assert.equal(saveNameOk(name), true, name + ' only looks like a device name');
  const badPaths = ['effects/index.json', 'effects/Index.json', 'index.html', 'fx-engine.js', 'effects', 'effects/', 'effects/face', 'effects/face/', 'effects/face/anubis/',
    'effects/face/anubis/effect.json', 'effects/face/anubis/Effect.json', 'effects/face/anubis/EFFECT.json', 'effects/face/anubis/effect.JSON', 'effects/anubis/effect.json', 'effects/face/anubis/green/effect.json',
    'effects/face/anubis/x.html', 'effects/face/anubis/x.js', 'effects/face/anubis/green/layer.webm', 'effects/face/anubis/room.jpg', 'effects/face/anubis/track.json.html', 'effects/face/anubis/track',
    'effects/../index.json', 'effects/../index.html', 'effects/face/../index.json', 'effects/face/../../index.html', 'effects/face/anubis/../../../x.json', 'effects/./face/x.json', 'effects/face/./x.json', 'effects//x.json', 'effects/face//x.json',
    '../effects/face/x.json', '/effects/face/x.json', 'C:/effects/face/x.json', 'effects\\face\\anubis\\x.json', 'effects/face\\..\\..\\x.json', 'fx/effects/face/x.json', 'Effects/face/x.json', 'test/out/x.json', 'builder/x.json',
    'effects/face/anubis/remix/default.json', 'effects/face/anubis/Remix/default.json', 'effects/remix/x.json', 'effects/face/anubis./x.json', 'effects/face/x.json/y.json', 'effects/.hidden/x.json', 'effects/face/a b/x.json',
    'effects/a/b/c/d/e/t.json', 'effects/face/anubis/con.json', 'effects/nul/x.json', 'effects/face/COM1/x.json', 'effects/face/anubis/track.json?x', 'effects/face/anubis/track.json#x', 'effects/face/anubis/tr ack.json', 'effects/face/anubis/track.json/',
    'effects/face/' + 'x'.repeat(65) + '/t.json', 'effects/face/anubis/' + 'x'.repeat(81) + '.json', 'effects/' + 'a/'.repeat(3) + 'x'.repeat(80) + '/' + 'y'.repeat(80) + '/' + 'z'.repeat(80) + '.json', 'effects/face/שם/x.json'];
  for (const p of badPaths) { assert.equal(savePathOk(p), false, 'path ' + JSON.stringify(p)); assert.equal(saveTarget(null, p), null, 'target for ' + JSON.stringify(p)); }
  for (const v of [5, {}, [], true]) { assert.equal(saveNameOk(v), false); assert.equal(savePathOk(v), false); }
  assert.equal(saveTarget('x.html', TRACK), null, 'a bad name is refused even beside a good path');
  assert.equal(saveTarget('take-1.webm', 'effects/index.json'), null, 'a bad path is refused even beside a good name');
});

test('POST /save writes only allowed targets, answers 400 for the rest and 401 without the key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanna-save-')), FX = path.join(root, 'fx'); fs.mkdirSync(FX);
  const { handle } = fxRoutes({ FX });
  const post = (url, { body = '{"frames":[]}', authed = true } = {}) => new Promise(done => {
    const req = Readable.from([Buffer.from(body)]); req.method = 'POST';
    const res = { status: 200, text: '', writeHead(code) { this.status = code; }, end(b) { this.text = String(b ?? ''); done(this); } };
    assert.equal(handle(req, res, new URL('http://local' + url), authed), true, url + ' is a route');
  });
  const files = (dir = root) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(path.join(dir, d.name)) : [path.relative(root, path.join(dir, d.name)).split(path.sep).join('/')]).sort();
  try {
    assert.equal((await post('/save?name=werelion-beast-run.webm', { body: 'webm-bytes' })).status, 200);
    assert.equal((await post('/fx/save?name=track-anubis.json')).status, 200, 'the same route under /fx/');
    assert.equal((await post('/save?path=' + encodeURIComponent(TRACK), { body: '{"fps":24,"frames":[]}' })).status, 200);
    assert.equal((await post('/save')).status, 200, 'no name: run.webm');
    const written = ['fx/' + TRACK, 'fx/test/out/run.webm', 'fx/test/out/track-anubis.json', 'fx/test/out/werelion-beast-run.webm'];
    assert.deepEqual(files(), written);
    assert.equal(fs.readFileSync(path.join(FX, 'test', 'out', 'werelion-beast-run.webm'), 'utf8'), 'webm-bytes');
    assert.equal(fs.readFileSync(path.join(FX, TRACK), 'utf8'), '{"fps":24,"frames":[]}');
    const refused = ['name=x.html', 'name=evil.js', 'name=' + encodeURIComponent('../x.json'), 'name=' + encodeURIComponent('../../index.html'), 'name=' + encodeURIComponent('..\\..\\x.json'), 'name=CON.json',
      'path=' + encodeURIComponent('effects/index.json'), 'path=' + encodeURIComponent('effects/face/anubis/effect.json'), 'path=' + encodeURIComponent('effects/face/anubis/Effect.json'),
      'path=' + encodeURIComponent('effects/face/anubis/x.html'), 'path=' + encodeURIComponent('effects/../index.html'), 'path=' + encodeURIComponent('../index.html'), 'path=index.html', 'path=fx-engine.js',
      'path=' + encodeURIComponent('effects/face/../../x.json'), 'path=' + encodeURIComponent('effects\\..\\x.json'), 'path=' + encodeURIComponent('effects/face/anubis/remix/default.json'),
      'path=' + encodeURIComponent(TRACK) + '&name=x.html', 'name=ok.webm&path=' + encodeURIComponent('effects/index.json')];
    for (const query of refused) { const r = await post('/save?' + query, { body: '<script>alert(1)</script>' }); assert.equal(r.status, 400, query); }
    assert.equal((await post('/save?name=ok.webm', { authed: false })).status, 401, 'no key and not this computer');
    assert.equal((await post('/save?path=' + encodeURIComponent('effects/face/anubis/green/other.json'), { authed: false })).status, 401);
    assert.deepEqual(files(), written, 'nothing else was written, inside the folder or beside it');
    assert.equal(handle({ method: 'GET' }, {}, new URL('http://local/save?name=ok.webm'), true), false, 'GET /save is not a route');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('server.mjs and fx-routes.mjs really use the guards', () => {
  const server = read('server.mjs'), routes = read('lib/fx-routes.mjs');
  assert.ok(server.includes("import { localStudioRequest } from './lib/studio-guards.mjs';"));
  assert.ok(server.includes('const isLocal = req => localStudioRequest(req, PORT);'), 'isLocal is the guard, with the port the server listens on');
  assert.ok(server.includes('const PORT = Number(env.PORT || 8800);') && server.includes('server.listen(PORT,'));
  assert.ok(server.includes('const studioAuthed = req => !env.STUDIO_CLIENT_KEY || isLocal(req) ||'), 'the key rule still starts from isLocal');
  assert.ok(server.includes('if (fx.handle(req, res, url, studioAuthed(req))) return;'), '/save is reached through the key rule');
  assert.ok(routes.includes("import { saveTarget } from './studio-guards.mjs';"));
  assert.ok(routes.includes("const t = saveTarget(u.searchParams.get('name'), u.searchParams.get('path')), p = t?.path;"));
  assert.ok(routes.includes("if (!t) { res.writeHead(400); return res.end('bad name or path'); }"));
  assert.ok(routes.includes("if (!f.startsWith(EFFECTS + path.sep)) { res.writeHead(400); return res.end('bad path'); }"), 'the old prefix test is kept');
});

// ---------------------------------------------------------------- 3. the launcher ----------------------------------------------------------------
const KEY = 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed', WALL = 'https://wall.example/stage?creator=NAME&t=WALLTOKEN123';
const SWITCHES = ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--hide-crash-restore-bubble', '--force-device-scale-factor=1', '--window-size=736,1319', '--window-position=0,0',
  '--disable-features=CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns,Translate'];

// launch() with a pretend gateway (the answers to GET /api/link/ops, the last one repeating), a pretend browser and a pretend disk
async function run(argv, { ops = [{ body: { program: { online: false } } }, { body: { program: { online: true } } }], env = {}, processEnv = {}, keyFile = KEY, lock = null, chrome = true, spawnFails = false } = {}) {
  const calls = { fetch: [], spawn: [], out: [], err: [] }, answers = [...ops];
  const fetchImpl = async url => { calls.fetch.push(String(url)); const a = answers.length > 1 ? answers.shift() : answers[0]; if (!a) throw new Error('connect ECONNREFUSED'); return { status: a.status ?? 200, json: async () => a.body }; };
  const spawnImpl = (cmd, args, options) => { const child = new EventEmitter(); child.pid = 4242; child.unref = () => { child.unrefed = true; }; calls.spawn.push({ cmd, args, options, child }); setImmediate(() => (spawnFails ? child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })) : child.emit('spawn'))); return child; };
  const fsImpl = {
    existsSync: f => (f.endsWith('chrome.exe') ? chrome : f.endsWith('lockfile') ? Boolean(lock) : false),
    readFileSync: f => { if (f.endsWith('link-program.key') && keyFile) return keyFile + '\r\n'; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    openSync: () => { if (lock === 'busy') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return 3; }, closeSync: () => {},
  };
  const code = await launch({ argv, env: { PORT: '8810', LINK_STAGE_URL: WALL, ...env }, processEnv: { LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local', ProgramFiles: 'C:\\Program Files', MOBILE_PORT: '8811', ...processEnv },
    root: 'C:\\studio', fetchImpl, spawnImpl, fsImpl, log: l => calls.out.push(String(l)), error: l => calls.err.push(String(l)), pause: async () => {}, waitMs: 2000 });
  return { code, ...calls, text: [...calls.out, ...calls.err].join('\n') };
}
const leaks = text => text.includes(KEY) || text.includes('WALLTOKEN123') || text.includes('wall.example') || text.includes(encodeURIComponent(WALL));

test('the launcher starts one Chrome --app window: an argument array, its own profile, one --disable-features', async () => {
  const r = await run(['air', '--sink', 'CABLE Input']);
  assert.equal(r.code, 0, r.text); assert.equal(r.spawn.length, 1);
  const { cmd, args, options, child } = r.spawn[0];
  assert.ok(cmd.endsWith('chrome.exe') && cmd.includes('Google'), cmd);
  assert.ok(Array.isArray(args) && args.every(a => typeof a === 'string'));
  assert.deepEqual(options, { detached: true, stdio: 'ignore' }, 'no shell (cmd.exe would expand the %XX of the link), not hidden, outlives the launcher');
  assert.equal(child.unrefed, true);
  assert.ok(/^--user-data-dir=.*[\\/]WannaLinkProgram$/.test(args[0]), args[0]);
  assert.equal(args[1], '--app=http://127.0.0.1:8810/clean/program?src=live&program=air&takeover=1&opp=0&mirror=1&audio=1&sink=CABLE%20Input&gw=http://127.0.0.1:8811&stage=' + encodeURIComponent(WALL) + '#pk=' + KEY);
  assert.deepEqual(args.slice(2), SWITCHES, 'exactly the switches of the specification');
  assert.equal(args.filter(a => a.startsWith('--disable-features')).length, 1, 'a second --disable-features would replace the first');
  assert.equal(args.some(a => a === '--open' || a.startsWith('--remote-debugging')), false);
  assert.deepEqual(new Set(r.fetch), new Set(['http://127.0.0.1:8811/api/link/ops']), 'it only asks the gateway on this computer');
  assert.equal(leaks(r.text), false, 'the key and the wall address are never printed:\n' + r.text);
  assert.ok(r.text.includes('stage=<redacted>#pk=<redacted>') && r.text.includes('program  online'));
  // the page reads the wall back whole (the rule of fx/stage-url.js) and the key from the fragment
  const link = new URL(args[1].slice('--app='.length));
  assert.equal(link.searchParams.get('stage'), WALL); assert.equal(link.hash, '#pk=' + KEY); assert.equal(link.searchParams.get('gw'), 'http://127.0.0.1:8811');
});

test('desk is picture only, air plays her voice; the ports and the key come from where the gateway reads them', async () => {
  const desk = await run(['--sink', 'CABLE Input']);
  assert.equal(desk.code, 0); assert.ok(!desk.spawn[0].args[1].includes('audio') && !desk.spawn[0].args[1].includes('sink'), 'desk is the default and has no audio parameters');
  assert.ok(desk.text.includes('--sink is ignored in desk mode'));
  const air = await run(['air']);
  assert.ok(air.spawn[0].args[1].includes('&mirror=1&audio=1&gw=')); assert.ok(air.text.includes('never open speakers'), 'air without a chosen device warns');
  assert.equal((await run(['air', '--sink=Line 1 (Virtual)'])).spawn[0].args[1].includes('&audio=1&sink=Line%201%20(Virtual)&gw='), true);
  // MOBILE_PORT only from the process environment (a value in server.env does not move the gateway either); PORT through lib/env.mjs
  const ports = await run([], { env: { PORT: '', MOBILE_PORT: '9999' }, processEnv: { MOBILE_PORT: '' } });
  assert.ok(ports.spawn[0].args[1].startsWith('--app=http://127.0.0.1:8800/clean/program?') && ports.spawn[0].args[1].includes('&gw=http://127.0.0.1:8801'));
  // the secret setting wins over the file; no wall setting = no stage parameter; a wall that is not https is left out
  const fromEnv = await run([], { env: { LINK_PROGRAM_KEY: 'key-from-the-secret-setting' } });
  assert.ok(fromEnv.spawn[0].args[1].endsWith('#pk=key-from-the-secret-setting') && fromEnv.text.includes('from LINK_PROGRAM_KEY') && !fromEnv.text.includes('key-from-the-secret-setting'));
  assert.equal((await run([], { env: { LINK_STAGE_URL: '' } })).spawn[0].args[1].includes('stage='), false);
  const badWall = await run([], { env: { LINK_STAGE_URL: 'http://wall.example/stage?t=WALLTOKEN123' } });
  assert.equal(badWall.spawn[0].args[1].includes('stage='), false); assert.ok(badWall.text.includes('WITHOUT a wall')); assert.equal(leaks(badWall.text), false);
  // LINK_DEV=1 (set here, or reported by the running gateway): no key is asked for, so none is needed and none is sent
  const dev = await run([], { env: { LINK_DEV: '1' }, keyFile: null });
  assert.equal(dev.code, 0); assert.equal(dev.spawn[0].args[1].includes('#pk='), false);
  const devGateway = await run([], { keyFile: null, ops: [{ body: { dev: true, program: { online: false } } }, { body: { dev: true, program: { online: true } } }] });
  assert.equal(devGateway.code, 0); assert.equal(devGateway.spawn[0].args[1].includes('#pk='), false);
});

test('the launcher refuses instead of opening a second or a useless window', async () => {
  const refused = async (options, word, argv = ['air']) => { const r = await run(argv, options); assert.equal(r.code, 1, word + '\n' + r.text); assert.equal(r.spawn.length, 0, word + ': nothing was started'); assert.ok(r.text.includes(word), word + '\n' + r.text); assert.equal(leaks(r.text), false); return r; };
  const open = await refused({ ops: [{ body: { program: { online: true, ready: true, throttled: false } } }] }, 'PROGRAM_ALREADY_OPEN');
  assert.ok(open.text.includes('program window already open'));
  await refused({ ops: [] }, 'GATEWAY_UNREACHABLE');
  await refused({ ops: [{ status: 404, body: { error: 'NOT_FOUND' } }] }, 'GATEWAY_WITHOUT_CAM_LINK'); // an older copy of the gateway on that port
  await refused({ ops: [{ status: 403, body: { error: 'LOCAL_SETUP_ONLY' } }] }, 'GATEWAY_WITHOUT_CAM_LINK');
  await refused({ ops: [{ status: 200, body: { ok: true } }] }, 'GATEWAY_WITHOUT_CAM_LINK');
  await refused({ lock: 'busy', ops: [{ body: { program: { online: false } } }] }, 'PROFILE_IN_USE'); // a Chrome with the link profile is still running, although the gateway sees no page
  await refused({ chrome: false }, 'CHROME_NOT_FOUND');
  await refused({ keyFile: null }, 'PROGRAM_KEY_MISSING'); // the gateway does not run in development mode, so the page would be refused
  assert.equal((await run(['air'], { lock: 'stale' })).code, 0, 'a lockfile left behind by a crash does not block the start');
  // a window that was closed a moment ago is still "online" for up to 3 s: the launcher waits for that instead of refusing
  const restart = await run(['air'], { ops: [{ body: { program: { online: true } } }, { body: { program: { online: true } } }, { body: { program: { online: false } } }, { body: { program: { online: true } } }] });
  assert.equal(restart.code, 0, restart.text); assert.equal(restart.spawn.length, 1); assert.ok(restart.text.includes('waiting up to 5 s'));
  const failed = await run(['air'], { spawnFails: true });
  assert.equal(failed.code, 1); assert.ok(failed.text.includes('CHROME_START_FAILED ENOENT')); assert.equal(leaks(failed.text), false);
  // started, but the page never reached the gateway: say so (the window stays open)
  const silent = await run(['air'], { ops: [{ body: { program: { online: false } } }] });
  assert.equal(silent.code, 1); assert.equal(silent.spawn.length, 1); assert.ok(silent.text.includes('PROGRAM_NOT_ONLINE')); assert.equal(leaks(silent.text), false);
  // the gateway runs from another folder: the key on disk here is not its key
  const other = await run(['air'], { ops: [{ body: { program: { online: false }, build: { root: 'D:\\another-copy' } } }, { body: { program: { online: true } } }] });
  assert.equal(other.code, 0); assert.ok(other.text.includes('runs from another folder'));
  for (const argv of [['live'], ['air', 'desk'], ['--sinc', 'x'], ['--sink'], ['--sink', '--print'], ['--sink', ' '], ['--sink', 'x'.repeat(101)]]) { const r = await run(argv); assert.equal(r.code, 2, argv.join(' ')); assert.equal(r.spawn.length + r.fetch.length, 0); }
});

test('--print shows the arguments with the key and the wall address redacted, and starts and contacts nothing', async () => {
  const r = await run(['air', '--sink', 'CABLE Input', '--print'], { ops: [] });
  assert.equal(r.code, 0); assert.equal(r.spawn.length + r.fetch.length, 0); assert.equal(leaks(r.text), false);
  assert.ok(r.out.includes('    --app=http://127.0.0.1:8810/clean/program?src=live&program=air&takeover=1&opp=0&mirror=1&audio=1&sink=CABLE%20Input&gw=http://127.0.0.1:8811&stage=<redacted>#pk=<redacted>'), r.text);
  for (const s of SWITCHES) assert.ok(r.out.includes('    ' + s), s);
  // and the real script, as the operator runs it (the test values replace whatever this computer has configured)
  const real = spawnSync(process.execPath, ['start-link.mjs', 'air', '--sink', 'CABLE Input', '--print'], { cwd: APP, env: { ...process.env, PORT: '18890', MOBILE_PORT: '1', LINK_PROGRAM_KEY: KEY, LINK_STAGE_URL: WALL }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const text = real.stdout + real.stderr;
  assert.equal(real.status, 0, text); assert.equal(leaks(text), false, 'nothing secret on the console');
  assert.ok(text.includes('--app=http://127.0.0.1:18890/clean/program?src=live&program=air&takeover=1&opp=0&mirror=1&audio=1&sink=CABLE%20Input&gw=http://127.0.0.1:1&stage=<redacted>#pk=<redacted>'), text);
  assert.equal(text.split('--disable-features=').length - 1, 1); assert.ok(text.includes('--disable-features=' + DISABLED_FEATURES) && text.includes('WannaLinkProgram') && text.includes('nothing is started'));
});

test('the launcher\'s small parts: arguments, link, Chrome location, key file, profile lock', () => {
  assert.deepEqual(parseArgs([]), { mode: 'desk', sink: null, print: false, help: false });
  assert.deepEqual(parseArgs(['air', '--sink', ' Speakers (USB) ', '--print']), { mode: 'air', sink: 'Speakers (USB)', print: true, help: false });
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(programUrl({ port: 8800, gatewayPort: 8801 }), 'http://127.0.0.1:8800/clean/program?src=live&program=air&takeover=1&opp=0&mirror=1&gw=http://127.0.0.1:8801');
  assert.equal(programUrl({ port: 8800, gatewayPort: 8801, mode: 'air', sink: 'a&b=c#d', stage: WALL, key: 'k/1+2' }), 'http://127.0.0.1:8800/clean/program?src=live&program=air&takeover=1&opp=0&mirror=1&audio=1&sink=a%26b%3Dc%23d&gw=http://127.0.0.1:8801&stage=' + encodeURIComponent(WALL) + '#pk=k%2F1%2B2');
  assert.equal(leaks(programUrl({ port: 8800, gatewayPort: 8801, stage: WALL, key: KEY, redact: true })), false);
  assert.deepEqual(chromeArgs({ profileDir: 'P', url: 'U' }), ['--user-data-dir=P', '--app=U', ...SWITCHES]);
  const only = wanted => ({ existsSync: f => f === wanted });
  const x86 = path.join('C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'), user = path.join('C:\\Users\\op\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(findChrome({ ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, only(x86)), x86);
  assert.equal(findChrome({ localappdata: 'C:\\Users\\op\\AppData\\Local' }, only(user)), user, 'a per-user install; the name of the variable in any case');
  assert.equal(findChrome({}, only('nowhere')), null);
  assert.deepEqual(readProgramKey({ LINK_PROGRAM_KEY: ' from-env ' }, 'R', { readFileSync: () => 'from-file' }), { key: 'from-env', source: 'LINK_PROGRAM_KEY' });
  assert.deepEqual(readProgramKey({}, 'R', { readFileSync: f => { assert.equal(f, path.join('R', 'runtime', 'link-program.key')); return 'from-file\n'; } }), { key: 'from-file', source: 'runtime/link-program.key' });
  assert.deepEqual(readProgramKey({}, 'R', { readFileSync: () => { throw new Error('ENOENT'); } }), { key: null, source: null });
  assert.deepEqual(readProgramKey({}, 'R', { readFileSync: () => ' \n' }), { key: null, source: null });
  const disk = (exists, open) => ({ existsSync: () => exists, openSync: open, closeSync: () => {} });
  assert.equal(profileInUse('P', disk(false, () => 3)), false, 'no lockfile: no Chrome with this profile');
  assert.equal(profileInUse('P', disk(true, () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); })), true, 'Chrome holds it open');
  assert.equal(profileInUse('P', disk(true, () => 3)), false, 'left behind: nobody holds it');
});
