// CAM LINK end to end, in a real browser, without touching anything that runs on this computer.
//   node test/run-link-browser.mjs            both phases (below)
//   node test/run-link-browser.mjs --dev-only   phase 1 only        --strict-only   phase 2 only
// Like test/run-browser.mjs: the source is copied into a disposable folder, and THIS script starts its own studio
// server (127.0.0.1:18890) and its own gateway (127.0.0.1:18891) there, with DRY_RUN=1, blank provider keys and
// throwaway server keys. It refuses to start when either port is taken and stops its two servers at the end, also on
// failure. test/link-browser.py then drives headless Chromium (fake camera and microphone, nothing visible, muted):
//   phase 1, LINK_DEV=1: the program page and the capture page over real WebRTC (connect, stop, program reload,
//            second program page, second capture page and takeover, audio, operator page);
//   phase 2, the gateway restarted WITHOUT LINK_DEV: a paired phone and the program key, as on a real server.
// Screenshots, the result files, the two server logs and the hub's link.log land in runtime/link-browser-audit/.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const STUDIO_PORT = 18890, GATEWAY_PORT = 18891;
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const audit = path.join(project, 'runtime', 'link-browser-audit');
const phases = process.argv.includes('--strict-only') ? ['strict'] : process.argv.includes('--dev-only') ? ['dev'] : ['dev', 'strict'];
const python = process.env.PYTHON || (fs.existsSync('C:\\Python314\\python.exe') ? 'C:\\Python314\\python.exe' : 'python');

// a port is free when nothing listens on it, neither on every interface (as the studio server does) nor on loopback
function portFree(port, host) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}
const answers = port => new Promise(resolve => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); s.setTimeout(1000, () => { s.destroy(); resolve(false); }); });
for (const port of [STUDIO_PORT, GATEWAY_PORT]) {
  if (await answers(port) || !(await portFree(port, '127.0.0.1')) || !(await portFree(port, undefined))) { console.error('PORT_TAKEN ' + port + ' is in use - nothing was started'); process.exit(2); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanna-link-browser-'));
const excluded = new Set(['node_modules', 'data', 'runtime', 'media', '.env', 'server.env']);
fs.cpSync(project, root, { recursive: true, filter: src => !path.relative(project, src).split(path.sep).some(p => excluded.has(p)) });
fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
fs.rmSync(audit, { recursive: true, force: true }); fs.mkdirSync(audit, { recursive: true });

// nothing of this computer's configuration reaches the test servers: .env and server.env are not copied, and every
// setting that could point at a real service is blanked here
const base = { ...process.env, PORT: String(STUDIO_PORT), MOBILE_PORT: String(GATEWAY_PORT), PUBLIC_BASE_URL: 'http://127.0.0.1:' + STUDIO_PORT, DRY_RUN: '1',
  OPENROUTER_API_KEY: '', KLING_API_KEY: '', SIGN_API_KEY: '', TIKTOOLS_API_KEY: '', EULER_API_KEY: '', VARDY_INGEST: '', ADB_SERIAL: '',
  API_TOKEN: randomBytes(24).toString('hex'), STUDIO_CLIENT_KEY: randomBytes(24).toString('hex'),
  LINK_PROGRAM_KEY: '', LINK_STAGE_URL: '', LINK_ICE_SERVERS: '', LINK_DEV: '', PYTHONIOENCODING: 'utf-8',
  LINK_TEST_STUDIO: 'http://127.0.0.1:' + STUDIO_PORT, LINK_TEST_GATEWAY: 'http://127.0.0.1:' + GATEWAY_PORT, LINK_TEST_ROOT: root, LINK_AUDIT_DIR: audit };

const jobs = new Set();
function start(script, env, logName) {
  const out = fs.openSync(path.join(audit, logName), 'a');
  const p = spawn(process.execPath, [script], { cwd: root, env, windowsHide: true, stdio: ['ignore', out, out] });
  p.logFd = out; jobs.add(p); p.once('exit', () => { jobs.delete(p); try { fs.closeSync(out); } catch { /* closed */ } });
  return p;
}
async function stop(p) { if (!p || p.exitCode !== null || p.signalCode !== null) return; const done = new Promise(r => p.once('exit', r)); p.kill(); await done; }
async function ready(url, what) { for (let i = 0; i < 150; i++) { try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 100)); } throw new Error(what + ' did not start'); }
function run(phase, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(python, [path.join(root, 'test', 'link-browser.py'), phase], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    jobs.add(p); p.once('error', reject); p.once('exit', code => { jobs.delete(p); code === 0 ? resolve() : reject(new Error('link browser test failed in phase "' + phase + '" (exit ' + code + ')')); });
  });
}
let stopping = false;
async function cleanup() {
  if (stopping) return; stopping = true;
  for (const p of [...jobs]) await stop(p);
  try { for (const name of ['link.log']) if (fs.existsSync(path.join(root, 'runtime', name))) fs.copyFileSync(path.join(root, 'runtime', name), path.join(audit, name)); } catch { /* the log is a convenience */ }
  try { fs.unlinkSync(path.join(root, 'node_modules')); } catch { /* not linked */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup().finally(() => process.exit(130)); });

let failed = null;
try {
  start('server.mjs', base, 'studio-server.log');
  await ready('http://127.0.0.1:' + STUDIO_PORT + '/health', 'the studio server');
  for (const phase of phases) {
    const env = { ...base, LINK_DEV: phase === 'dev' ? '1' : '' };
    const gateway = start('mobile-gateway.mjs', env, 'gateway-' + phase + '.log');
    await ready('http://127.0.0.1:' + GATEWAY_PORT + '/api/link/ops', 'the gateway');
    await run(phase, env);
    await stop(gateway);
  }
  console.log('PASS cam link in a real browser (' + phases.join(' + ') + '): disposable servers on ' + STUDIO_PORT + '/' + GATEWAY_PORT + ', fake camera and microphone, no TikTok, no phone, no paid provider call.');
} catch (e) { failed = e; console.error('FAIL ' + e.message); }
finally { await cleanup(); console.log('artifacts: ' + audit); }
process.exit(failed ? 1 : 0);
