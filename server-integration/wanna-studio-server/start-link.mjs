// CAM LINK: opens the program window, the one Chrome --app window that TikTok LIVE Studio captures (see LINK.md).
//   node start-link.mjs [desk|air] [--sink "<part of an audio output device label>"] [--print]
//     desk     (default) picture only: no audio parameters, this computer plays nothing
//     air      audio=1: the creator's voice is played on this computer for LIVE Studio; --sink picks the output device
//     --print  show the Chrome arguments with the program key and the wall address redacted; starts and contacts nothing
// Why a launcher and not a link: Chrome applies command-line switches only when a launch creates a NEW browser process.
// A window opened from the everyday Chrome silently loses all of them (no autoplay, frozen picture when covered), so the
// program window gets its own profile folder, and this script refuses to open a second window beside a running one.
// Chrome is started with an argument array, never through a .cmd string: the encoded wall address is full of %XX.
// Settings (lib/env.mjs: process environment > server.env > .env):
//   PORT (default 8800) - MOBILE_PORT (process environment only, default 8801, exactly as the gateway reads it)
//   LINK_PROGRAM_KEY (secret) or else runtime/link-program.key, which the gateway writes when it starts
//   LINK_STAGE_URL (secret, optional): the wall behind the creator - LINK_DEV=1: the gateway asks for no program key
// Nothing secret is printed: not the key, not the wall address. The servers are never started from here (no --open).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv, ROOT } from './lib/env.mjs';
import { parseStageUrl } from './fx/stage-url.js';

export const PROFILE_FOLDER = 'WannaLinkProgram';
// ONE --disable-features switch: a second one on the same command line replaces the first.
export const DISABLED_FEATURES = 'CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns,Translate';
export const USAGE = 'usage: node start-link.mjs [desk|air] [--sink "<part of an audio output device label>"] [--print]';
const REDACTED = '<redacted>';

// On Windows process.env ignores the case of a name; a plain copy of it does not.
const envGet = (env, name) => env[name] ?? env[Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())];

export function parseArgs(argv) {
  const o = { mode: 'desk', sink: null, print: false, help: false }; let modeSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print') o.print = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--sink' || a.startsWith('--sink=')) {
      const v = a === '--sink' ? argv[++i] : a.slice('--sink='.length);
      if (!v || !v.trim() || v.startsWith('--') || v.length > 100) throw new Error('SINK_LABEL_REQUIRED: --sink needs a part of the output device label (at most 100 characters)');
      o.sink = v.trim();
    } else if ((a === 'desk' || a === 'air') && !modeSeen) { o.mode = a; modeSeen = true; }
    else throw new Error('UNKNOWN_ARGUMENT: ' + a);
  }
  return o;
}

// The program link, in the order of the specification. redact = the printable form: the same link with the two secrets
// replaced, built without them (never by search-and-replace on the real one).
export function programUrl({ port, gatewayPort, mode = 'desk', sink = null, stage = null, key = null, redact = false }) {
  const secret = v => (redact ? REDACTED : encodeURIComponent(v));
  let q = 'src=live&program=air&takeover=1&opp=0&mirror=1';
  if (mode === 'air') { q += '&audio=1'; if (sink) q += '&sink=' + encodeURIComponent(sink); }
  q += '&gw=http://127.0.0.1:' + gatewayPort;
  if (stage) q += '&stage=' + secret(stage);
  return 'http://127.0.0.1:' + port + '/clean/program?' + q + (key ? '#pk=' + secret(key) : '');
}

export function chromeArgs({ profileDir, url }) {
  return [
    '--user-data-dir=' + profileDir,
    '--app=' + url,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--hide-crash-restore-bubble', '--force-device-scale-factor=1',
    '--window-size=736,1319', '--window-position=0,0',
    '--disable-features=' + DISABLED_FEATURES,
  ];
}

export function profileDirFor(processEnv = process.env) {
  return path.join(envGet(processEnv, 'LOCALAPPDATA') || path.join(os.homedir(), 'AppData', 'Local'), PROFILE_FOLDER);
}

export function chromeCandidates(processEnv = process.env) {
  const roots = ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'LOCALAPPDATA'].map(n => envGet(processEnv, n)).filter(Boolean);
  roots.push('C:\\Program Files', 'C:\\Program Files (x86)');
  return [...new Set(roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')))];
}
export const findChrome = (processEnv = process.env, fsImpl = fs) => chromeCandidates(processEnv).find(f => fsImpl.existsSync(f)) || null;

// The program key: the secret setting, or the file the gateway wrote at its last start. Never printed, never logged.
export function readProgramKey(env, root, fsImpl = fs) {
  const fromEnv = String(env.LINK_PROGRAM_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'LINK_PROGRAM_KEY' };
  try { const k = String(fsImpl.readFileSync(path.join(root, 'runtime', 'link-program.key'), 'utf8')).trim(); if (k) return { key: k, source: 'runtime/link-program.key' }; } catch {}
  return { key: null, source: null };
}

// A Chrome that runs with this profile keeps <profile>/lockfile open for writing and removes it when it exits
// (checked against a running Chrome 154 on Windows 11: a read-write open is refused with EBUSY, a read-only one is not).
export function profileInUse(profileDir, fsImpl = fs) {
  const lock = path.join(profileDir, 'lockfile');
  if (!fsImpl.existsSync(lock)) return false;
  try { fsImpl.closeSync(fsImpl.openSync(lock, 'r+')); return false; } catch (e) { return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code); }
}

async function readOps(fetchImpl, gatewayPort, ms = 3000) {
  try {
    const r = await fetchImpl('http://127.0.0.1:' + gatewayPort + '/api/link/ops', { cache: 'no-store', signal: AbortSignal.timeout(ms) });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  } catch { return { status: 0, body: null }; }
}
const speaksLink = ops => ops.status === 200 && typeof ops.body?.program?.online === 'boolean';

function startChrome(spawnImpl, chrome, args) {
  return new Promise((resolve, reject) => {
    // detached + ignored stdio: the window outlives this script. No windowsHide (that would start the window hidden).
    const child = spawnImpl(chrome, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

// Returns the exit code. Everything it touches can be replaced, so the tests run it without a gateway or a browser.
export async function launch({ argv = [], env = loadEnv(), processEnv = process.env, root = ROOT, fetchImpl = fetch, spawnImpl = spawn, fsImpl = fs,
  log = console.log, error = console.error, pause = ms => new Promise(r => setTimeout(r, ms)), waitMs = 20000 } = {}) {
  let o; try { o = parseArgs(argv); } catch (e) { error(e.message); error(USAGE); return 2; }
  if (o.help) { log(USAGE); return 0; }
  const port = Number(env.PORT) || 8800, gatewayPort = Number(processEnv.MOBILE_PORT) || 8801;
  const { key, source } = readProgramKey(env, root, fsImpl);
  const wallGiven = String(env.LINK_STAGE_URL || '').trim(), stage = parseStageUrl(wallGiven, '127.0.0.1'); // the program page's own rule
  const profileDir = profileDirFor(processEnv), chrome = findChrome(processEnv, fsImpl);
  const link = { port, gatewayPort, mode: o.mode, sink: o.sink, stage, key };
  const audio = o.mode === 'air' ? 'on, output ' + (o.sink ? 'device matching "' + o.sink + '"' : 'DEFAULT DEVICE (no --sink)') : 'off';
  const summary = dev => [
    'mode     ' + o.mode + ' (audio ' + audio + ')',
    'studio   http://127.0.0.1:' + port + '    gateway  http://127.0.0.1:' + gatewayPort,
    'wall     ' + (stage ? 'on' : wallGiven ? 'OFF: LINK_STAGE_URL is not a usable address (https, or http on this computer)' : 'off (LINK_STAGE_URL is not set)'),
    'key      ' + (key ? 'from ' + source : dev ? 'none (the gateway runs with LINK_DEV=1)' : 'MISSING'),
    'profile  ' + profileDir,
    'chrome   ' + (chrome || 'NOT FOUND'),
  ];
  if (o.print) {
    log('CAM LINK program window - print only, nothing is started or contacted'); for (const l of summary(env.LINK_DEV === '1')) log('  ' + l);
    log('  arguments (program key and wall address redacted):'); for (const a of chromeArgs({ profileDir, url: programUrl({ ...link, redact: true }) })) log('    ' + a);
    return 0;
  }
  if (o.mode === 'desk' && o.sink) error('NOTE --sink is ignored in desk mode (desk plays no audio)');
  if (wallGiven && !stage) error('WARNING LINK_STAGE_URL is set but is not a usable wall address (https, or http on this computer): starting WITHOUT a wall');
  if (o.mode === 'air' && !o.sink) error('WARNING air without --sink: her voice plays on the Windows default output. That must be headphones or a virtual device, never open speakers.');
  if (!chrome) { error('CHROME_NOT_FOUND looked in: ' + chromeCandidates(processEnv).join(' | ')); return 1; }

  // the gateway decides: is a program window already there, and does it ask for a key at all
  let ops = await readOps(fetchImpl, gatewayPort);
  if (ops.status === 0) { error('GATEWAY_UNREACHABLE nothing answers on 127.0.0.1:' + gatewayPort + ' - start the gateway first (start-mobile.cmd)'); return 1; }
  if (!speaksLink(ops)) { error('GATEWAY_WITHOUT_CAM_LINK 127.0.0.1:' + gatewayPort + ' answered /api/link/ops with HTTP ' + ops.status + ' - is another copy of the server running on that port?'); return 1; }
  // a window that was closed (or died) a moment ago: its Chrome needs a second to exit and the gateway up to 3 s to notice
  for (let i = 0; i < 10 && (ops.body.program.online || profileInUse(profileDir, fsImpl)); i++) {
    if (i === 0) log('a program window is (or just was) open - waiting up to 5 s for it to go away');
    await pause(500);
    const again = await readOps(fetchImpl, gatewayPort, 1500); if (speaksLink(again)) ops = again;
  }
  if (ops.body.program.online) { error('PROGRAM_ALREADY_OPEN program window already open (the gateway sees it online). Close that window first.'); return 1; }
  const dev = env.LINK_DEV === '1' || ops.body.dev === true;
  if (!key && !dev) { error('PROGRAM_KEY_MISSING no LINK_PROGRAM_KEY and no runtime/link-program.key in this folder (the gateway writes that file when it starts)'); return 1; }
  if (profileInUse(profileDir, fsImpl)) { error('PROFILE_IN_USE a Chrome window with the link profile is still open. Close it first: a second start would only add a window to that Chrome, and two program windows fight over the link.'); return 1; }
  const there = ops.body.build?.root;
  if (there && path.resolve(there).toLowerCase() !== path.resolve(root).toLowerCase()) error('WARNING the gateway on 127.0.0.1:' + gatewayPort + ' runs from another folder (' + there + '): a key read from this folder will not match it');

  let pid; try { pid = await startChrome(spawnImpl, chrome, chromeArgs({ profileDir, url: programUrl(link) })); } catch (e) { error('CHROME_START_FAILED ' + (e.code || e.message)); return 1; }
  log('CAM LINK program window started (chrome pid ' + pid + ')'); for (const l of summary(dev)) log('  ' + l);
  log('  link     ' + programUrl({ ...link, redact: true }));
  for (let waited = 0; waited < waitMs; waited += 500) {
    await pause(500);
    const now = await readOps(fetchImpl, gatewayPort, 1500);
    if (speaksLink(now) && now.body.program.online) { log('  program  online at the gateway - capture only this window ("LINK PROGRAM") in LIVE Studio, never minimise it'); return 0; }
  }
  error('PROGRAM_NOT_ONLINE the window is open but the gateway has not seen it for ' + Math.round(waitMs / 1000) + ' s. Look at the window and at http://127.0.0.1:' + gatewayPort + '/cam/ops (the page needs internet for its models; a wrong program key is answered 403 PROGRAM_KEY_REQUIRED).');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await launch({ argv: process.argv.slice(2) });
