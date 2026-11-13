// The stage from the cloud: ?stage=<https url> on the clean program (/clean/program -> /fx/?clean=1) puts that web page
// (the creator's wall) in an <iframe> as the LOWEST layer, and the camera is then drawn as a cut-out over it.
// Pure helpers, no DOM: used by fx/index.html and tested in test/stage-url.test.mjs.

export const STAGE_TIMEOUT_MS = 15000; // the iframe has this long to load; after that the program goes on without it

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// A stage address is accepted only as https, or as http on this computer (loopback) / on the page's own host (tests).
// Anything else (javascript:, data:, a bare word, a foreign http site) -> null = no stage.
export function parseStageUrl(raw, pageHost = '') {
  if (typeof raw !== 'string') return null;
  const s = raw.trim(); if (!s) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol === 'https:') return u.href;
  if (u.protocol === 'http:' && (LOOPBACK.has(u.hostname) || (pageHost && u.hostname === pageHost))) return u.href;
  return null;
}

// The stage for a program page, from its query string: only in clean mode (?clean=1, what /clean/program redirects to).
// An & inside the stage address is written %26 in the link (…?creator=NAME%26t=TOKEN) and comes back here as &.
export function stageUrlFor(search, pageHost = '') {
  const q = new URLSearchParams(search || '');
  return q.get('clean') ? parseStageUrl(q.get('stage'), pageHost) : null;
}

// The gate that turns the program transparent. An <iframe> fires "load" for the browser's own error page too (host down,
// no such name, TLS error), so "load" alone proves nothing: the gate opens only when the iframe has loaded AND the stage's
// host answered a probe (a no-cors HEAD, which rejects on a network failure). It closes for good on a failed probe, an
// iframe error, or when the time is up — and then the program goes on with the plain camera. onOpen / onClose: one call, ever.
// (What no page can see from the outside: a wall that refuses to be framed by X-Frame-Options / CSP frame-ancestors.)
export function stageGate({ onOpen, onClose, timeoutMs = STAGE_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let loaded = false, reachable = false, settled = false;
  const settle = (ok, why) => { if (settled) return; settled = true; clearTimer(timer); if (ok) onOpen?.(); else onClose?.(why); };
  const timer = setTimer(() => settle(false, 'timeout'), timeoutMs);
  const maybe = () => { if (loaded && reachable) settle(true); };
  return { loaded() { loaded = true; maybe(); }, reachable() { reachable = true; maybe(); }, failed(why) { settle(false, why || 'error'); }, get settled() { return settled; } };
}

// The program link for the Studio with a stage in it (what public/links.html shows): the stage address is encoded so
// its own ?, & and # survive inside our query.
export function programUrlWithStage(stage, { src = 'phone', streamer = '' } = {}) {
  const q = new URLSearchParams({ src }); if (streamer) q.set('streamer', streamer);
  return `/clean/program?${q}&stage=${encodeURIComponent(stage)}`;
}
