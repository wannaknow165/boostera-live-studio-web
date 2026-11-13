// CAM LINK v1 — operator page (spec section 9). The gateway serves /cam/ops and GET /api/link/ops to loopback only.
// Polls GET /api/link/ops every second and shows what the program window and the link are really doing.
// Two red banners: AUDIO OFF (a link is connected and the program does not play her voice) and the program window
// being throttled / hidden or smaller than 720x1280 CSS px. Everything is written with textContent.
//
// opsView() is pure and has no DOM access (tested in test/cam-client.test.mjs); the page part runs only in a browser.

export const NEED = Object.freeze({ w: 720, h: 1280 });
const POLL_MS = 1000;

const num = v => { v = Number(v); return Number.isFinite(v) ? v : 0; };
const first = (...values) => values.find(v => v !== undefined && v !== null);
const yes = v => (v === true ? 'yes' : v === false ? 'no' : '—');
const txt = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const age = (now, at) => (num(at) > 0 && num(now) >= num(at) ? ((num(now) - num(at)) / 1000).toFixed(1) + ' s ago' : '—');

// an event's detail is a small flat object in the hub ({attempt:'1a2b3c4d', ms:120}): shown as "attempt=1a2b3c4d ms=120"
const detailText = d => (d === undefined || d === null ? '' : typeof d !== 'object' ? String(d)
  : Object.entries(d).map(([k, v]) => k + '=' + (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' '));

/**
 * GET /api/link/ops -> banners, cards and events. It reads the status shape (program, link, air) plus what the hub
 * (lib/cam-link.mjs) adds for the operator: program.{pageId,state,showing,stats}, link.{phase,client,capture,audio.sink},
 * dev, build, lease and events. The program page's own numbers (vw, vh, dpr, rafHz, drawHz, pcCreated, framesDecoded,
 * freezeCount, jitterMs) are taken from program.stats (link.stats is looked at first, should they ever move there).
 */
export function opsView(data) {
  const o = data && typeof data === 'object' ? data : {};
  const program = o.program || {}, link = o.link || {}, stats = link.stats || {}, pstats = program.stats || {};
  const audio = link.audio || program.audio || {}, path = link.path || null, air = o.air || {}, build = o.build || {}, lease = o.lease || {};
  const capture = link.capture || o.capture || null, now = num(first(o.serverTime, 0));
  const pick = key => first(stats[key], pstats[key], program[key]);
  const vw = num(first(pick('vw'), program.viewport?.w)), vh = num(first(pick('vh'), program.viewport?.h)), dpr = num(first(pick('dpr'), program.viewport?.dpr));
  const online = program.online === true, connected = link.state === 'connected';

  const banners = [];
  if (connected && (audio.wanted !== true || audio.playing !== true)) {
    banners.push({
      id: 'audio', text: 'AUDIO OFF',
      detail: audio.wanted !== true
        ? 'The program window was opened without audio (desk mode): her voice is NOT going out.'
        : 'Audio is wanted but is not playing' + (audio.sink ? ' (sink: ' + txt(audio.sink, 40) + ')' : '') + '.',
    });
  }
  const small = online && vw > 0 && vh > 0 && (vw < NEED.w || vh < NEED.h);
  if (online && (program.throttled === true || small)) {
    const parts = [];
    if (program.throttled === true) parts.push('The program window is hidden, minimised or throttled: the picture is not being drawn.');
    if (small) parts.push('Viewport ' + vw + 'x' + vh + ' is smaller than ' + NEED.w + 'x' + NEED.h + ' CSS px.');
    banners.push({ id: 'window', text: program.throttled === true ? 'PROGRAM WINDOW THROTTLED' : 'PROGRAM WINDOW TOO SMALL', detail: parts.join(' ') });
  }

  const size = (w, h) => (num(w) && num(h) ? num(w) + ' x ' + num(h) : '—');
  const cards = [
    { id: 'program', title: 'Program window', tone: online ? (program.throttled === true || small ? 'bad' : 'ok') : 'off', rows: [
      ['online', yes(program.online)], ['ready', yes(program.ready)], ['throttled', yes(program.throttled)],
      ['viewport', vw && vh ? vw + ' x ' + vh + ' CSS px' : '—'], ['device pixel ratio', dpr ? String(dpr) : '—'],
      ['page id', txt(first(lease.pageId, program.pageId, '—'), 40)],
      ['last seen', program.parked === true ? 'now (its poll is open)' : age(now, first(lease.lastSeenAt, program.lastSeenAt))],
      ['showing', txt(program.showing || '—', 10) + (program.state ? ' (' + txt(program.state, 12) + ')' : '')],
      ['raf / draw Hz', pick('rafHz') === undefined && pick('drawHz') === undefined ? '—' : num(pick('rafHz')) + ' / ' + num(pick('drawHz'))],
      ['connections made', pick('pcCreated') === undefined ? '—' : String(num(pick('pcCreated')))],
    ] },
    { id: 'link', title: 'Link', tone: connected ? 'ok' : link.state === 'negotiating' ? 'busy' : link.state === 'stalled' || link.state === 'lost' ? 'bad' : 'off', rows: [
      ['state', txt(link.state || 'idle', 20)], ['since', age(now, link.since)],
      ['program echo age', link.echoAgeMs === null || link.echoAgeMs === undefined ? '—' : Math.round(num(link.echoAgeMs)) + ' ms'],
      ['last error', txt(link.lastError || '—', 40)],
      ['ICE path', path ? txt(path.local, 10) + ' -> ' + txt(path.remote, 10) + ' / ' + txt(path.protocol, 5) : '—'],
      ['phone', txt(link.client?.label || '—', 40) + (link.attempt ? ' · attempt ' + txt(link.attempt, 12) : '') + (link.adopted === true ? ' · adopted' : '')],
    ] },
    { id: 'video', title: 'Incoming video', tone: connected && num(stats.fps) >= 15 ? 'ok' : connected ? 'bad' : 'off', rows: [
      ['size', size(stats.w, stats.h)], ['fps', String(num(stats.fps))], ['bitrate', num(stats.kbps) + ' kbps'],
      ['round trip', num(stats.rttMs) + ' ms'], ['loss', num(stats.lossPct) + ' %'],
      ['frames decoded', pick('framesDecoded') === undefined ? '—' : String(num(pick('framesDecoded')))],
      ['freezes', pick('freezeCount') === undefined ? '—' : String(num(pick('freezeCount')))],
      ['jitter', pick('jitterMs') === undefined ? '—' : num(pick('jitterMs')) + ' ms'],
    ] },
    { id: 'audio', title: 'Audio', tone: !connected ? 'off' : audio.wanted === true && audio.playing === true ? 'ok' : 'bad', level: Math.min(1, Math.max(0, num(audio.level))), rows: [
      ['wanted', yes(audio.wanted)], ['playing', yes(audio.playing)], ['level', num(audio.level).toFixed(3)], ['sink', txt(audio.sink || '—', 40)],
    ] },
    { id: 'air', title: 'TikTok (air)', tone: air.live === true ? 'ok' : 'off', rows: [['event connection known', yes(air.known)], ['live', yes(air.live)]] },
    { id: 'build', title: 'Build', tone: 'off', rows: [
      ['version', txt(first(build.version, o.version, '—'), 20)], ['root', txt(build.root || '—', 200)],
      ['started', num(build.startedAt) ? new Date(num(build.startedAt)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—'],
      ['dev mode (LINK_DEV)', yes(o.dev)],
    ] },
  ];
  if (capture) {
    const cs = capture.stats || {};
    cards.splice(4, 0, { id: 'phone', title: 'Phone (capture)', tone: capture.video === 'live' && capture.visible !== false ? 'ok' : 'bad', rows: [
      ['video', txt(capture.video || '—', 10)], ['audio', txt(capture.audio || '—', 10)], ['page visible', yes(capture.visible)],
      ['sending', size(cs.w, cs.h) + ' @ ' + num(cs.fps) + ' fps, ' + num(cs.kbps) + ' kbps'],
      ['codec / encoder', txt(cs.codec || '—', 40) + ' / ' + txt(cs.encoder || '—', 40)], ['limited by', txt(cs.limit || '—', 40)],
    ] });
  }
  const events = (Array.isArray(o.events) ? o.events : []).slice(-50).reverse().map(e => ({ at: num(e?.at), type: txt(e?.type, 40), detail: txt(detailText(e?.detail), 240) }));
  return { banners, cards, events };
}

// ---------------------------------------------------------------------------------------------------------------

function mountOps(g = globalThis) {
  const doc = g.document, $ = id => doc.getElementById(id);
  const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  let busy = false, lastGood = 0;

  function render(view) {
    const banners = $('banners');
    banners.replaceChildren(...view.banners.map(b => { const box = el('div', 'banner'); box.dataset.banner = b.id; box.append(el('strong', '', b.text), el('span', '', b.detail)); return box; }));
    $('cards').replaceChildren(...view.cards.map(card => {
      const box = el('section', 'card'); box.dataset.card = card.id; box.dataset.tone = card.tone;
      box.append(el('h2', '', card.title));
      if (card.level !== undefined) { const meter = el('meter'); meter.min = 0; meter.max = 1; meter.value = card.level; box.append(meter); }
      const list = el('dl');
      for (const [name, value] of card.rows) list.append(el('dt', '', name), el('dd', '', value));
      box.append(list);
      return box;
    }));
    const rows = view.events.map(e => {
      const tr = el('tr');
      tr.append(el('td', 'at', e.at ? new Date(e.at).toLocaleTimeString('en-GB') : '—'), el('td', 'type', e.type), el('td', '', e.detail));
      return tr;
    });
    $('events').replaceChildren(...rows);
    $('no-events').hidden = rows.length > 0;
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const res = await g.fetch('/api/link/ops', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (res.status === 403) { $('conn').textContent = 'This page works only on the studio PC itself (loopback).'; $('conn').dataset.tone = 'bad'; return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(opsView(await res.json()));
      lastGood = Date.now();
      $('conn').textContent = 'updated ' + new Date(lastGood).toLocaleTimeString('en-GB');
      $('conn').dataset.tone = 'ok';
    } catch {
      $('conn').textContent = 'No answer from the gateway' + (lastGood ? ' (last good ' + Math.round((Date.now() - lastGood) / 1000) + ' s ago, values below are old)' : '') + '.';
      $('conn').dataset.tone = 'bad';
    } finally { busy = false; }
  }

  render(opsView(null));
  void poll();
  g.setInterval(poll, POLL_MS);
}

if (typeof document !== 'undefined' && document.getElementById('ops')) mountOps();
