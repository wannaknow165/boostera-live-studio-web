// Guards of the studio server (server.mjs, port 8800), kept as pure functions. server.mjs starts listening the moment it
// is imported, so the rules that need a unit test live here; server.mjs and lib/fx-routes.mjs only call them.
// Tests: test/studio-hardening.test.mjs.

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

// The Host header a browser or a program on this computer sends when it really addresses this server
// (a server on port 80 is addressed without the port).
export const localHosts = port => Number(port) === 80
  ? ['127.0.0.1', 'localhost', '127.0.0.1:80', 'localhost:80']
  : ['127.0.0.1:' + port, 'localhost:' + port];

// "This computer itself": such a request needs no studio key (isLocal in server.mjs). It is the gateway's rule
// (localRequest in mobile-gateway.mjs) plus the Sec-Fetch-Site test:
//   - the peer is a loopback address and nothing forwarded the request (a tunnel or a proxy adds one of the two headers);
//   - Host is this server's own loopback name and port. A DNS-rebinding page (evil.example pointed at 127.0.0.1) and a
//     forwarder on another port (adb reverse to another port, a local proxy) send a different Host;
//   - no page of another site sent it. A browser marks such a request "Sec-Fetch-Site: cross-site" and a page can neither
//     change nor remove that header. Our own pages send "same-origin", a typed address sends "none", and programs
//     (the gateway, the Studio, curl) send no such header at all.
export function localStudioRequest(req, port) {
  const h = req.headers || {};
  return LOOPBACK.includes(req.socket?.remoteAddress) && !h['cf-connecting-ip'] && !h['x-forwarded-for']
    && h['sec-fetch-site'] !== 'cross-site' && localHosts(port).includes(h.host);
}

// The studio key rule (studioAuthed in server.mjs): who may use the studio routes (/save, /remix, /api/bg, /play/…).
//   - A request that carries the studio key (?ck=, x-key or the cookie bk) or the Tribute API token (x-api-key). A key that
//     is not configured matches nothing: an unset setting and a missing header are both "undefined", and a blank setting
//     equals an empty header, which a page of any site can send.
//   - A request from this computer itself (localStudioRequest above).
//   - With no studio key configured ("empty = open": programs on this computer and devices on the network need none):
//     everything except a request that a page of another site sent. A browser marks that one itself (Sec-Fetch-Site:
//     cross-site), so the cross-site door is closed in every configuration.
const cookieOf = req => Object.fromEntries(String((req.headers || {}).cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]));
export function studioKeyGiven(req, { clientKey = '', apiToken = '' } = {}) {
  const h = req.headers || {};
  if (clientKey) {
    let ck = null; try { ck = new URL(req.url || '/', 'http://x').searchParams.get('ck'); } catch { /* an address that cannot be read carries no key */ }
    if ([ck, h['x-key'], cookieOf(req).bk].includes(clientKey)) return true;
  }
  return Boolean(apiToken) && h['x-api-key'] === apiToken;
}
export function studioRequestAllowed(req, port, { clientKey = '', apiToken = '' } = {}) {
  return studioKeyGiven(req, { clientKey, apiToken }) || localStudioRequest(req, port) || (!clientKey && (req.headers || {})['sec-fetch-site'] !== 'cross-site');
}

// POST /save (lib/fx-routes.mjs) writes a request body to disk inside ./fx, and ./fx is served as the pages and scripts
// of the origin that holds the program page. So only two kinds of target exist:
//   ?name=<file>.webm | <file>.json       a recording or a builder track, kept flat in fx/test/out
//   ?path=effects/<folders>/<file>.json   a tracking result next to its effect: fx-engine.js writes
//                                         effects/<group>/<effect>/green/track.json (group = body | face | full)
// Refused, whatever else is true:
//   - any other extension (.html and .js would be served as a page or a script of this origin);
//   - effect.json (it tells the page what to run) and effects/index.json (the effect list: a path needs a folder);
//   - a remix folder (the server's own job files);
//   - a folder name with a dot: no "." or "..", and Windows reads "x." as "x";
//   - a Windows device name such as CON.json or NUL.webm (that opens the device, not a file);
//   - upper-case spellings of the above: Windows file names ignore case, so Effect.json IS effect.json.
const SAVE_NAME = /^[\w.-]{1,80}\.(webm|json)$/;
const SAVE_FOLDER = /^[\w-]{1,64}$/;
const SAVE_FILE = /^[\w.-]{1,80}\.json$/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const MAX_FOLDERS = 4, MAX_PATH = 240;

export const saveNameOk = name => typeof name === 'string' && SAVE_NAME.test(name) && !DEVICE.test(name);

export function savePathOk(p) {
  if (typeof p !== 'string' || p.length > MAX_PATH) return false;
  const parts = p.split('/'), file = parts.pop(), folders = parts.slice(1);
  if (parts[0] !== 'effects' || folders.length < 1 || folders.length > MAX_FOLDERS) return false;
  if (!folders.every(d => SAVE_FOLDER.test(d) && !DEVICE.test(d) && d.toLowerCase() !== 'remix')) return false;
  return SAVE_FILE.test(file) && !DEVICE.test(file) && file.toLowerCase() !== 'effect.json';
}

// What POST /save may write for its two query values: { name } (-> fx/test/out/<name>) or { name, path } (-> fx/<path>),
// or null = answer 400. A value that is given must be valid; without a name it is run.webm and a path wins over the
// name, as it always did.
export function saveTarget(name, p) {
  const n = name || 'run.webm';
  if (!saveNameOk(n)) return null;
  if (!p) return { name: n };
  return savePathOk(p) ? { name: n, path: p } : null;
}
