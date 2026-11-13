# CAM LINK end to end in headless Chromium: the capture page (/cam/) and the program page (/clean/program?src=live)
# over REAL WebRTC, with Chromium's fake camera and microphone. Started by test/run-link-browser.mjs against ITS OWN
# disposable servers (studio 18890, gateway 18891). Never point it at a server that is in use.
#   python test/link-browser.py dev      the gateway runs with LINK_DEV=1: scenarios a..h
#   python test/link-browser.py strict   the gateway runs without LINK_DEV: a paired phone and the program key
# Every scenario asserts, and leaves a screenshot in runtime/link-browser-audit/ (LINK_AUDIT_DIR).
import json, os, pathlib, sys, time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

PHASE = sys.argv[1] if len(sys.argv) > 1 else 'dev'
STUDIO = os.environ.get('LINK_TEST_STUDIO', 'http://127.0.0.1:18890').rstrip('/')
GATEWAY = os.environ.get('LINK_TEST_GATEWAY', 'http://127.0.0.1:18891').rstrip('/')
ROOT = pathlib.Path(os.environ.get('LINK_TEST_ROOT') or pathlib.Path(__file__).resolve().parents[1])
AUDIT = pathlib.Path(os.environ.get('LINK_AUDIT_DIR') or ROOT / 'runtime' / 'link-browser-audit')
AUDIT.mkdir(parents=True, exist_ok=True)
for address in (STUDIO, GATEWAY):  # the ports of the copy that is in use on this computer are never touched
    assert urlparse(address).hostname == '127.0.0.1' and urlparse(address).port not in (8800, 8801, 47831, 9222, 9225), 'refusing to test against ' + address

PROGRAM = STUDIO + '/clean/program?src=live&opp=0&program=air&takeover=1&gw=' + GATEWAY
SEEN = 'מחוברת לאולפן · רואים אותך'
SEEN_HEARD = 'מחוברת לאולפן · רואים ושומעים אותך'
AUDIO_OFF = 'הקול כבוי באולפן (מצב בדיקה)'
REPLACED = 'המצלמה עברה למכשיר אחר'
UNPAIRED = 'הטלפון לא משויך לאולפן'
PAIR_BAD = 'הקוד שגוי או שפג תוקפו. בקשי קוד חדש מהאולפן.'
MIC_MUTED = 'המיקרופון מושתק'
THROTTLED = 'מסך השידור באולפן מוסתר או ממוזער'
ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
        '--mute-audio', '--disable-audio-output',  # the fake microphone beeps: nothing may come out of this computer's speakers (the second
                                                   # flag gives the browser a pretend output that still plays the stream out, so levels are real)
        '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection']  # same-machine ICE, as the launcher's program window
# The effects engine needs a real GPU to run at speed (headless Chromium otherwise renders in software, a few frames a
# second). LINK_BROWSER_GL=software leaves the flags out: the transport is then still checked in full, the picture
# checks that need a fast program page are skipped and written down as notes.
if sys.platform == 'win32' and os.environ.get('LINK_BROWSER_GL') != 'software':
    ARGS += ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
RENDERER = "() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }"

result = {'phase': PHASE, 'passed': [], 'numbers': {}, 'notes': [], 'problems': []}
pages = {}

def mark(name, detail=''):
    result['passed'].append(name)
    print('PASS ' + name + (' :: ' + str(detail) if detail != '' else ''), flush=True)

def check(ok, name, detail=''):
    if not ok:
        raise AssertionError(name + ' :: ' + json.dumps(detail, ensure_ascii=False, default=str))

def number(name, value):
    result['numbers'][name] = value
    print('  ' + name + ' = ' + json.dumps(value, ensure_ascii=False), flush=True)

def until(fn, what, timeout=20.0, every=0.1):
    start, last = time.monotonic(), None
    while time.monotonic() - start < timeout:
        try:
            last = fn()
        except Exception as e:  # a page that is navigating cannot be asked; ask again
            last = None; error = str(e)
        if last:
            return last, round(time.monotonic() - start, 2)
        time.sleep(every)
    raise TimeoutError('never happened within %.0f s: %s' % (timeout, what))

def watch(page, label):
    pages[label] = page
    page.on('pageerror', lambda e: result['problems'].append(label + ' pageerror: ' + str(e)))
    page.on('console', lambda m: result['problems'].append(label + ' console.error: ' + m.text[:300]) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    return page

def shot(label, name):
    try: pages[label].screenshot(path=str(AUDIT / (PHASE + '-' + name + '.png')))
    except Exception as e: result['notes'].append('no screenshot ' + name + ': ' + str(e)[:120])

RX = "() => window.linkReceiver ? { ...window.linkReceiver.state(), stats: window.linkReceiver.stats(), hash: location.hash, title: document.title, fxReady: window.fxReady === true } : null"
CAM = """() => { if (!window.camLink) return null; const s = window.camLink.snapshot(), v = id => { const e = document.getElementById(id); return !!e && !e.hidden && !e.closest('[hidden]'); };
  return { state: s.state, error: s.error, attempts: s.attempts, tracksLive: s.tracksLive, control: s.control, wakeLock: s.wakeLock, stats: s.stats, pcState: s.pcState, link: s.status && s.status.link, program: s.status && s.status.program,
    pill: v('pill') ? document.getElementById('pill-text').textContent : '', tone: document.getElementById('pill').dataset.tone, sub: v('pill-sub') ? document.getElementById('pill-sub').textContent : '',
    notice: v('notice') ? document.getElementById('notice-text').textContent : '', sending: v('sending'), startCard: v('start-card'), takeover: v('takeover'), pairLink: v('pair-link'), self: document.getElementById('self').videoWidth }; }"""
STATUS = "() => fetch('/api/link/status' + (window.camLink.snapshot().attempt ? '?attempt=' + window.camLink.snapshot().attempt : ''), { cache: 'no-store', headers: { 'X-Link-Client': window.camLink.clientId } }).then(r => r.json())"
# the engine's output canvas, reduced to 36x64: how much of it is lit, and a fingerprint to see it change
CANVAS = """() => { const c = document.querySelector('#out'); if (!c || !c.width) return { w: 0, h: 0, lit: 0, print: 0 };
  const t = document.createElement('canvas'); t.width = 36; t.height = 64; const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0, 36, 64);
  const d = x.getImageData(0, 0, 36, 64).data; let lit = 0, print = 0; for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; if (v > 60) lit++; print = (print * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 1000000007; }
  return { w: c.width, h: c.height, lit: Math.round(lit * 1000 / (36 * 64)) / 1000, print }; }"""

def phone_context(browser):
    return browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, permissions=['camera', 'microphone'], locale='he-IL')

def open_cam(ctx, label):
    page = watch(ctx.new_page(), label)
    page.goto(GATEWAY + '/cam/', wait_until='domcontentloaded')
    until(lambda: page.evaluate("() => !!window.camLink"), label + ': the capture page started')
    return page

def tap_start(page):
    until(lambda: page.evaluate(CAM)['startCard'], 'the primary button is shown', 10)
    started = time.monotonic(); page.locator('#start').click()
    return started

def wait_connected(ops, page, label, started, timeout=25.0):
    until(lambda: page.evaluate("() => window.camLink.state") == 'live', label + ': state live', timeout)
    live = round(time.monotonic() - started, 2)
    until(lambda: ops()['link']['state'] == 'connected', label + ': the hub says connected (from the program echo)', timeout)
    return live, round(time.monotonic() - started, 2)

def engine_canvas(program, expect_lit, what, timeout=15.0):
    first, _ = until(lambda: (lambda c: c if (c['lit'] > 0.5 if expect_lit else c['lit'] < 0.02) else None)(program.evaluate(CANVAS)), what, timeout, 0.25)
    return first

# every program page notes its long tasks (the main thread held for more than 0.3 s), so the test can tell when the page's warm-up is over
LONG_TASKS = "window.__lastLong = 0; window.__longest = 0; try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.duration > 300) { window.__lastLong = e.startTime + e.duration; window.__longest = Math.max(window.__longest, e.duration); } }).observe({ entryTypes: ['longtask'] }); } catch (e) {}"

def settle(program, what='the program page is past its warm-up'):
    # The page goes on loading after "ready": every effect in the background, and about 6 s later the models of the
    # profile-picture cutter. Each holds the page for seconds (longer on a busy computer). The steady-state checks start
    # once the engine is ready, all effects are loaded and the page has not been held up for 6 s.
    until(lambda: program.evaluate("() => window.fxReady === true && !!window.fx && window.fx.ready === true"), 'the effects engine is ready', 180, 0.5)
    program.evaluate("() => window.fxAllLoaded"); time.sleep(7)
    until(lambda: program.evaluate("() => performance.now() - (window.__lastLong || 0) > 6000") and (program.evaluate(RX)['stats']['rafHz'] or 0) >= 30, what, 90, 1.0)
    return round(program.evaluate("() => window.__longest || 0") / 1000, 1)

def steady(ops, page, label, timeout=30.0):
    # after the page's warm-up the phone may have re-offered once (a held-up page looks like a stale echo): wait for the link to rest
    return until(lambda: (lambda o, c: c if o['link']['state'] == 'connected' and o['program']['showing'] == 'webrtc' and c['state'] == 'live' and c['link'] and c['link']['mine'] and c['link']['state'] == 'connected' else None)(ops(), page.evaluate(CAM)), label + ': the link is at rest, connected', timeout, 0.25)[0]

def run_dev(browser):
    desk = browser.new_context(viewport={'width': 720, 'height': 1280}, device_scale_factor=1); desk.add_init_script(LONG_TASKS)
    api = desk.request
    ops = lambda: api.get(GATEWAY + '/api/link/ops').json()
    events = lambda: [e['type'] for e in ops()['events']]

    # ---- (a) the program page loads and the hub sees it ----
    program = watch(desk.new_page(), 'program')
    t0 = time.monotonic(); program.goto(PROGRAM, wait_until='domcontentloaded')
    _, online_after = until(lambda: ops()['program']['online'], 'a: program.online at the hub', 60)
    o = ops(); r, _ = until(lambda: (lambda r: r if r and r['lease'] == 'held' else None)(program.evaluate(RX)), 'a: the receiver knows the slot is its own (a poll parked for a second)', 5)
    check(o['lease'] and o['lease']['pageId'] == 'air' and o['dev'] is True, 'a: the lease belongs to program "air"', o['lease'])
    check(r and r['lease'] == 'held' and r['program'] == 'air' and r['gateway'] == GATEWAY and r['title'] == 'LINK PROGRAM', 'a: the receiver holds the slot', r)
    check('/fx/?clean=1&src=live' in program.url, 'a: /clean/program redirected to the fx page', program.url)
    number('a.program_online_s', online_after); shot('program', 'a-program-online')
    mark('a: the program page loads and the hub shows program.online', '%.1f s after navigation' % online_after)
    # the engine (MediaPipe from the CDN): the transport does not wait for it, the picture checks do
    engine = {'ready': False, 'fast': False}
    try:
        until(lambda: program.evaluate("() => window.fxReady === true && !!window.fx && window.fx.ready === true"), 'the effects engine is ready', 150, 0.5)
        log = program.evaluate("() => document.querySelector('#log').textContent")
        engine = {'ready': True, 'seconds': round(time.monotonic() - t0, 1), 'delegate': 'GPU' if 'body mask, GPU)' in log else 'CPU' if 'body mask, CPU)' in log else 'unknown', 'renderer': program.evaluate(RENDERER)[:90]}
        engine['longest_hold_up_s'] = settle(program); engine['settled_s'] = round(time.monotonic() - t0, 1)
    except TimeoutError as e:
        result['notes'].append('ENGINE NOT READY in this browser: ' + str(e) + ' - the picture checks were skipped, the transport checks were not')
    number('engine', engine)
    until(lambda: ops()['program']['ready'] is True, 'a: program.ready at the hub (the echo left "loading")', 15) if engine['ready'] else None

    # ---- (b) one tap on the capture page: connected, the program shows webrtc, the pill tells the truth ----
    phone_ctx = phone_context(browser)
    phone = open_cam(phone_ctx, 'phone')
    idle = phone.evaluate(CAM); check(idle['state'] == 'idle' and idle['startCard'] and not idle['notice'], 'b: the capture page is idle with its one button', idle)
    started = tap_start(phone)
    live_s, connected_s = wait_connected(ops, phone, 'b', started)
    number('b.time_to_live_on_phone_s', live_s); number('b.time_to_connected_at_hub_s', connected_s)
    first, _ = until(lambda: (lambda o: o if o['program']['showing'] == 'webrtc' and o['program']['stats']['framesDecoded'] > 0 else None)(ops()), 'b: the program reports showing webrtc', 15)
    second, _ = until(lambda: (lambda o: o if o['program']['stats']['framesDecoded'] > first['program']['stats']['framesDecoded'] + 15 else None)(ops()), 'b: framesDecoded is rising', 10)
    st, _ = until(lambda: (lambda o: o['link']['stats'] if o['link']['stats']['fps'] >= 15 else None)(ops()), 'b: the program reports at least 15 fps', 20)
    check(160 <= st['w'] <= 1280 and 120 <= st['h'] <= 1280 and st['w'] * st['h'] <= 1280 * 720 * 1.2 and st['fps'] <= 61, 'b: a sane size and frame rate', st)
    o = ops(); check(o['link']['path'] and o['link']['path']['protocol'] == 'udp' and o['link']['path']['local'] in ('host', 'prflx') and o['link']['path']['remote'] in ('host', 'prflx'), 'b: a direct udp path', o['link']['path'])
    number('b.incoming', {'w': st['w'], 'h': st['h'], 'fps': st['fps'], 'kbps': o['link']['stats']['kbps'], 'path': o['link']['path'], 'framesDecoded': second['program']['stats']['framesDecoded']})
    status = phone.evaluate(STATUS)
    check(status['link']['state'] == 'connected' and status['link']['mine'] is True and status['link']['echoAgeMs'] is not None and status['link']['echoAgeMs'] < 3000, 'b: status says connected, mine, echo under 3000 ms', status['link'])
    c, _ = until(lambda: (lambda c: c if c['sending'] and c['state'] == 'live' and c['self'] > 0 and c['stats']['w'] > 0 else None)(phone.evaluate(CAM)), 'b: live, with the fixed label and the self view', 10)
    number('b.phone', {'sending': [c['stats']['w'], c['stats']['h'], c['stats']['fps'], c['stats']['kbps']], 'codec': c['stats']['codec'], 'encoder': c['stats']['encoder'], 'path': c['stats']['path']})
    if engine['ready']:
        # a program page that draws fewer than 10 frames a second calls itself throttled, and the phone then says so
        # instead of going green: that is the truth on a browser without a real GPU, and the test follows it
        try: until(lambda: (lambda r: (r['stats']['rafHz'] or 0) >= 20 and (r['stats']['drawHz'] or 0) >= 15)(program.evaluate(RX)), 'the program page runs at speed', 12, 0.5); engine['fast'] = True
        except TimeoutError: engine['fast'] = False; result['notes'].append('PROGRAM PAGE TOO SLOW in this browser (no real GPU?): the green pill could not be checked; the "studio screen hidden" pill was checked instead')
        lit = engine_canvas(program, True, 'b: the engine canvas shows the camera (not black)')
        time.sleep(0.6); again = program.evaluate(CANVAS); rx = program.evaluate(RX)
        check(lit['w'] == 720 and lit['h'] == 1280 and again['print'] != lit['print'], 'b: the engine draws 720x1280 and the picture changes', [lit, again])
        check(rx['state'] == 'connected' and rx['showing'] == 'webrtc' and rx['engineReady'] and (rx['stats']['drawHz'] or 0) > 0, 'b: the receiver loop drives the engine', rx['stats'])
        number('b.program_loop', {'rafHz': rx['stats']['rafHz'], 'drawHz': rx['stats']['drawHz'], 'canvas_lit': lit['lit'], 'vw': rx['stats']['vw'], 'vh': rx['stats']['vh'], 'fast': engine['fast']})
        if engine['fast']:
            c, _ = until(lambda: (lambda c: c if c['pill'] == SEEN else None)(phone.evaluate(CAM)), 'b: the pill says connected, seen', 15)
            check(c['tone'] == 'ok' and c['sub'] == AUDIO_OFF, 'b: green pill with the "audio off in the studio" note', c)
            check(phone.evaluate(STATUS)['program'] == {'online': True, 'ready': True, 'throttled': False}, 'b: program online, ready and not throttled')
        else:
            c, _ = until(lambda: (lambda c: c if c['pill'] == THROTTLED else None)(phone.evaluate(CAM)), 'b: the pill says the studio screen is hidden or throttled', 15)
    shot('phone', 'b-phone-connected'); shot('program', 'b-program-connected')
    mark('b: one tap -> connected, program shows webrtc, truthful pill', 'live %.2f s, hub connected %.2f s, %sx%s @ %s fps' % (live_s, connected_s, st['w'], st['h'], st['fps']))

    # ---- (h) the operator page (this computer only) shows the link; AUDIO OFF because the program plays no sound ----
    opsPage = watch(desk.new_page(), 'ops')
    opsPage.goto(GATEWAY + '/cam/ops', wait_until='domcontentloaded')
    until(lambda: opsPage.evaluate("() => { const c = document.querySelector('[data-card=link]'); return !!c && c.dataset.tone === 'ok' && c.textContent.includes('connected'); }"), 'h: the operator page shows the link connected', 10)
    view = opsPage.evaluate("() => ({ banners: [...document.querySelectorAll('[data-banner]')].map(b => b.dataset.banner), program: document.querySelector('[data-card=program]').textContent, video: document.querySelector('[data-card=video]').textContent, events: document.querySelectorAll('#events tr').length, conn: document.querySelector('#conn').dataset.tone })")
    check('audio' in view['banners'] and 'window' not in view['banners'] and view['events'] >= 3 and view['conn'] == 'ok' and '720 x 1280' in view['program'], 'h: AUDIO OFF banner, no window banner, viewport and events shown', view)
    shot('ops', 'h-ops-connected')
    mark('h: /cam/ops is reachable on this computer and shows the link', view['banners'])

    # ---- (c) stop on the phone: slate on the program, idle at the hub ----
    phone.locator('#stop').click(); until(lambda: phone.evaluate("() => !document.getElementById('confirm').hidden"), 'c: the confirmation is shown', 5)
    stopped_at = time.monotonic(); phone.locator('#confirm-stop').click()
    until(lambda: (lambda o: o['link']['state'] == 'idle' and o['program']['showing'] == 'slate' and o['program']['state'] == 'idle')(ops()), 'c: hub idle and program on the slate', 10)
    number('c.stop_to_idle_s', round(time.monotonic() - stopped_at, 2))
    c = phone.evaluate(CAM); check(c['state'] == 'stopped' and not c['tracksLive'] and not c['sending'] and c['startCard'], 'c: camera released on the phone', c)
    check('stop' in events(), 'c: the hub logged the stop', events()[-6:])
    if engine['ready']: engine_canvas(program, False, 'c: the engine canvas is black (slate)')
    rx = program.evaluate(RX); check(rx['state'] == 'idle' and rx['showing'] == 'slate' and rx['connection'] is None, 'c: the receiver closed the connection', rx['state'])
    shot('phone', 'c-phone-stopped'); shot('program', 'c-program-slate')
    mark('c: stop on the phone -> slate on the program, idle at the hub')

    # ---- (d) reconnect, reload the program page mid-link: the phone recovers by itself ----
    started = tap_start(phone); live_s, connected_s = wait_connected(ops, phone, 'd', started)
    number('d.reconnect_s', connected_s)
    time.sleep(2.0); before = ops()['program']['stats']['pcCreated']
    reload_at = time.monotonic(); program.reload(wait_until='domcontentloaded')
    # 1. the link itself: the phone offers again by itself, the reloaded page answers before it loads its engine, media flows
    rx, _ = until(lambda: (lambda r, c: r if r and r['connection'] == 'connected' and r['stats']['framesDecoded'] > 0 and c['state'] == 'live' and c['pcState'] == 'connected' else None)(program.evaluate(RX), phone.evaluate(CAM)), 'd: the link is up again after the program reload', 20, 0.2)
    recovered = round(time.monotonic() - reload_at, 2); number('d.link_up_again_after_reload_s', recovered)
    answered = next((line['t'] for line in rx['log'] if 'answer sent' in line['m']), None); number('d.first_offer_answered_ms_after_page_start', answered)
    check(recovered <= 20 and answered is not None and answered < 7000 and rx['stats']['pcCreated'] == 1, 'd: the waiting phone was answered before the engine loaded, and the link is up within 20 s', {'recovered': recovered, 'answered_ms': answered})
    # 2. the picture: "connected" is the program's own word, said once its engine has loaded again and draws her
    #    (how long that takes is the engine's reload time on this computer, not the link's)
    until(lambda: (lambda o, r: bool(r) and r['state'] == 'connected' and r['showing'] == 'webrtc' and o['link']['state'] == 'connected' and o['link']['stats']['fps'] > 0)(ops(), program.evaluate(RX)), 'd: the program draws her again', 120, 0.25)
    drawn = round(time.monotonic() - reload_at, 2); number('d.program_draws_her_again_after_reload_s', drawn)
    check(program.evaluate(RX)['stats']['pcCreated'] == 1 and phone.evaluate(CAM)['attempts'] == 3, 'd: one new connection was enough: no further attempt while the engine loaded', [program.evaluate(RX)['stats']['pcCreated'], phone.evaluate(CAM)['attempts']])
    if engine['ready']: settle(program)
    c = steady(ops, phone, 'd')
    check(c['tracksLive'] and c['attempts'] >= 3, 'd: the same camera on a new attempt, nobody touched the phone', {'attempts': c['attempts']})
    check('program_bye' in events() and 'lost' in events(), 'd: the hub saw the page go', events()[-12:])
    if engine['fast']: until(lambda: phone.evaluate(CAM)['pill'] == SEEN, 'd: the pill is green again', 15)
    shot('phone', 'd-phone-recovered'); shot('program', 'd-program-recovered')
    mark('d: program page reloaded mid-link -> the phone recovers by itself', 'link up again %.2f s after the reload (offer answered %s ms after the new page started), program drawing her again after %.2f s' % (recovered, answered, drawn))

    # ---- (e) a second program page with another id and no takeover: PROGRAM_BUSY, the first keeps the link ----
    second = watch(desk.new_page(), 'program2')
    second.goto(STUDIO + '/clean/program?src=live&opp=0&program=second&gw=' + GATEWAY, wait_until='domcontentloaded')
    r2, _ = until(lambda: (lambda r: r if r and r['lease'] == 'busy' else None)(second.evaluate(RX)), 'e: the second program page is told PROGRAM_BUSY', 60, 0.25)
    until(lambda: any(e['type'] == 'program_busy' and e['detail'].get('program') == 'second' and e['detail'].get('holder') == 'air' for e in ops()['events']), 'e: the hub logged program_busy', 5)
    check(any('PROGRAM_BUSY' in line['m'] for line in r2['log']) and r2['state'] in ('loading', 'idle') and r2['stats']['pcCreated'] == 0, 'e: it says so once and makes no connection', r2['log'][-3:])
    time.sleep(1.2); o = ops()
    check(o['lease']['pageId'] == 'air' and o['link']['state'] == 'connected' and o['link']['echoAgeMs'] < 3000 and program.evaluate(RX)['state'] == 'connected', 'e: the first page keeps the slot and the link', [o['lease'], o['link']['state']])
    shot('program2', 'e-second-program-busy'); second.close(); pages.pop('program2', None)
    mark('e: a second program page without takeover gets PROGRAM_BUSY; the first keeps the link')

    # ---- (f) a second capture page: LINK_REPLACED; with "bring it back here" it takes the link, the first shows "replaced" ----
    phone2_ctx = phone_context(browser)
    phone2 = open_cam(phone2_ctx, 'phone2')
    tap_start(phone2)
    c2, _ = until(lambda: (lambda c: c if c['state'] == 'replaced' else None)(phone2.evaluate(CAM)), 'f: the second capture page is refused (LINK_REPLACED)', 15)
    check(c2['error'] == 'LINK_REPLACED' and c2['notice'] == REPLACED and c2['takeover'] and not c2['tracksLive'] and not c2['sending'], 'f: it stops, releases the camera and offers the takeover button', c2)
    o = ops(); check(o['link']['state'] == 'connected' and phone.evaluate(CAM)['state'] == 'live', 'f: the first phone is untouched', o['link']['state'])
    shot('phone2', 'f-second-phone-refused')
    took_at = time.monotonic(); phone2.locator('#takeover').click()
    until(lambda: phone2.evaluate("() => window.camLink.state") == 'live', 'f: the second phone is live after the takeover', 25)
    c2, _ = until(lambda: (lambda c: c if c['link'] and c['link']['mine'] and c['link']['state'] == 'connected' else None)(phone2.evaluate(CAM)), 'f: the link is the second phone\'s', 15)
    number('f.takeover_s', round(time.monotonic() - took_at, 2))
    c1, replaced_s = until(lambda: (lambda c: c if c['state'] == 'replaced' else None)(phone.evaluate(CAM)), 'f: the first phone shows "replaced"', 25)
    check(c1['notice'] == REPLACED and c1['takeover'] and not c1['tracksLive'] and not c1['sending'], 'f: the first phone released its camera and offers the button', c1)
    number('f.first_phone_replaced_after_s', round(time.monotonic() - took_at, 2))
    time.sleep(1.0); o = ops(); check(o['link']['state'] == 'connected' and phone2.evaluate(CAM)['state'] == 'live' and 'replaced' in events(), 'f: the link stays with the second phone', o['link']['state'])
    shot('phone', 'f-first-phone-replaced'); shot('phone2', 'f-second-phone-took-over')
    mark('f: second capture page -> LINK_REPLACED; takeover takes the link and the first page shows "replaced"')

    # ---- (g) audio=1 on the program page: the echo says wanted + playing, and the pill says "seen and heard" ----
    audio_at = time.monotonic(); program.goto(PROGRAM + '&audio=1', wait_until='domcontentloaded')
    a, _ = until(lambda: (lambda o: o['link']['audio'] if o['link']['state'] == 'connected' and o['link']['audio']['wanted'] is True and o['link']['audio']['playing'] is True else None)(ops()), 'g: the program echo reports audio wanted and playing', 30, 0.2)
    number('g.audio_after_program_change_s', round(time.monotonic() - audio_at, 2))
    if engine['ready']: settle(program)
    steady(ops, phone2, 'g')
    if engine['fast']:
        c2, _ = until(lambda: (lambda c: c if c['pill'] == SEEN_HEARD else None)(phone2.evaluate(CAM)), 'g: the pill says "seen and heard"', 25)
        check(c2['tone'] == 'ok' and c2['sub'] == '', 'g: green, and no "audio off" note', [c2['pill'], c2['sub']])
        # her own mute is said as her own mute, at once, and never as "the studio does not play your voice"
        phone2.locator('#mic').click()
        c2, _ = until(lambda: (lambda c: c if c['pill'] == SEEN and c['sub'] == MIC_MUTED else None)(phone2.evaluate(CAM)), 'g: muted by her: "seen", with the reason beside it', 5)
        time.sleep(6.5); c2 = phone2.evaluate(CAM)
        check(c2['pill'] == SEEN and c2['sub'] == MIC_MUTED and c2['tone'] == 'ok', 'g: still so after more than 5 s of silence', [c2['pill'], c2['sub']])
        phone2.locator('#mic').click()
        until(lambda: (lambda c: c if c['pill'] == SEEN_HEARD else None)(phone2.evaluate(CAM)), 'g: unmuted: seen and heard again', 15)
    o = ops(); check(o['link']['audio']['sink'] == 'default' and o['program']['audio']['wanted'] is True and o['link']['audio']['level'] >= 0, 'g: the default output, as no sink= was given', o['link']['audio'])
    number('g.audio', o['link']['audio'])
    until(lambda: opsPage.evaluate("() => ![...document.querySelectorAll('[data-banner]')].some(b => b.dataset.banner === 'audio') && document.querySelector('[data-card=audio]').dataset.tone === 'ok'"), 'g: the operator page drops the AUDIO OFF banner', 10)
    shot('phone2', 'g-phone-seen-and-heard'); shot('program', 'g-program-audio'); shot('ops', 'g-ops-audio-on')
    mark('g: audio=1 -> the echo reports wanted + playing and the pill says "seen and heard"', o['link']['audio'])

    # the end: stop, nothing left behind
    phone2.locator('#stop').click(); phone2.locator('#confirm-stop').click()
    until(lambda: ops()['link']['state'] == 'idle', 'the hub is idle after the last stop', 10)
    number('hub_events', events())
    for ctx in (phone_ctx, phone2_ctx, desk): ctx.close()

def run_strict(browser):
    # the gateway was started WITHOUT LINK_DEV: the phone must be paired and the program page must hold the key
    key = (ROOT / 'runtime' / 'link-program.key').read_text(encoding='utf-8').strip()
    check(len(key) == 48, 's: the gateway wrote its program key', len(key))
    desk = browser.new_context(viewport={'width': 720, 'height': 1280}, device_scale_factor=1); desk.add_init_script(LONG_TASKS)
    api = desk.request
    ops = lambda: api.get(GATEWAY + '/api/link/ops').json()
    check(ops()['dev'] is False, 's: the gateway is not in development mode')

    # a program page without the key is refused, and says why
    nokey = watch(desk.new_page(), 'nokey')
    nokey.goto(STUDIO + '/clean/program?src=live&opp=0&program=nokey&gw=' + GATEWAY, wait_until='domcontentloaded')
    r, _ = until(lambda: (lambda r: r if r and any('PROGRAM_KEY_REQUIRED' in line['m'] for line in r['log']) else None)(nokey.evaluate(RX)), 's: a program page without the key is refused', 60, 0.25)
    check(r['lease'] == 'none' and r['hasKey'] is False and ops()['lease'] is None, 's: it does not get the slot', r['lease'])
    shot('nokey', 's-program-without-key'); nokey.close(); pages.pop('nokey', None)
    mark('s: a program page without the key is refused (PROGRAM_KEY_REQUIRED) and takes no slot')

    # the keyed program page: the key leaves the address at once and travels only as a request header to the gateway
    # (a cross-origin request with that header is one Chrome sends only after the gateway's CORS preflight allowed it)
    program = watch(desk.new_page(), 'program')
    keyed = []
    program.on('request', lambda q: keyed.append(q.headers.get('x-link-program-key') == key and key not in q.url) if '/api/link/program/poll' in q.url or '/api/link/program/state' in q.url or '/api/link/program/answer' in q.url else None)
    t0 = time.monotonic(); program.goto(PROGRAM + '#pk=' + key, wait_until='domcontentloaded')
    until(lambda: ops()['program']['online'], 's: the keyed program page is online', 60)
    r, _ = until(lambda: (lambda r: r if r and r['lease'] == 'held' else None)(program.evaluate(RX)), 's: the receiver knows the slot is its own', 5)
    check(r['hasKey'] is True and r['lease'] == 'held' and r['hash'] == '' and 'pk=' not in program.url and key not in json.dumps(r), 's: key accepted, gone from the address, in nothing the page shows', program.url.split('?')[0])
    settle(program)
    mark('s: the program page with #pk= is accepted; the key is stripped from the address', '%.1f s' % (time.monotonic() - t0))

    # an unpaired phone is told so before any camera prompt
    phone_ctx = phone_context(browser)
    phone = open_cam(phone_ctx, 'phone')
    c, _ = until(lambda: (lambda c: c if c['state'] == 'unpaired' else None)(phone.evaluate(CAM)), 's: an unpaired phone is told so', 10)
    check(c['notice'] == UNPAIRED and c['pairLink'] and not c['startCard'] and not c['tracksLive'], 's: the pairing notice with its link, no camera', c)
    shot('phone', 's-phone-unpaired')
    mark('s: an unpaired phone sees the pairing notice (401), no camera prompt')

    # pairing, exactly as she does it: a code from this computer, typed into the code field of the notice itself.
    # (This phone reaches the gateway as "this computer", like a phone over adb reverse: /mobile/ would show it no pairing form.)
    check(phone.locator('#pair-code').is_visible() and phone.locator('#pair-go').is_visible(), 's: the notice has its own code field')
    phone.locator('#pair-code').fill('00000000'); phone.locator('#pair-go').click()
    said, _ = until(lambda: phone.evaluate("() => { const e = document.getElementById('pair-error'); return !e.hidden && e.textContent; }"), 's: a wrong code is said', 10)
    check(said == PAIR_BAD and phone.evaluate(CAM)['state'] == 'unpaired', 's: in her words, and the field stays', said)
    code = api.post(GATEWAY + '/api/mobile/pairing-code').json()['code']
    phone.locator('#pair-code').fill(code); phone.locator('#pair-go').click()
    c, _ = until(lambda: (lambda c: c if c['startCard'] and c['state'] == 'idle' else None)(phone.evaluate(CAM)), 's: paired from the page: the start card is back, without a reload', 10)
    check(any(k['name'] == 'wm_sid' for k in phone_ctx.cookies()) and c['notice'] == '' and not c['tracksLive'], 's: the phone is paired, and no camera was asked for', c['state'])
    started = tap_start(phone); live_s, connected_s = wait_connected(ops, phone, 's', started)
    c, _ = until(lambda: (lambda c: c if c['pill'] == SEEN else None)(phone.evaluate(CAM)), 's: the pill says connected, seen', 15)
    o = ops(); check(o['link']['client']['label'].endswith(' cam') and o['link']['stats']['fps'] >= 15 and c['tone'] == 'ok', 's: the paired phone is connected', [o['link']['client'], o['link']['stats']])
    number('s.time_to_connected_at_hub_s', connected_s)
    check(len(keyed) >= 3 and all(keyed), 's: every poll, answer and state request carried the key as a header, never in its address', [len(keyed), all(keyed)])
    shot('phone', 's-phone-connected'); shot('program', 's-program-connected')
    mark('s: paired phone + keyed program page connect over WebRTC', 'hub connected %.2f s' % connected_s)

    # reload of the keyed program page: the address no longer carries the key, the tab still knows it
    reload_at = time.monotonic(); program.reload(wait_until='domcontentloaded')
    r, _ = until(lambda: (lambda r, c: r if r and r['connection'] == 'connected' and r['stats']['framesDecoded'] > 0 and c['state'] == 'live' else None)(program.evaluate(RX), phone.evaluate(CAM)), 's: the link is up again after the keyed program page reloaded', 20, 0.2)
    up = round(time.monotonic() - reload_at, 2); number('s.link_up_again_after_reload_s', up)
    check(r['hasKey'] is True and r['hash'] == '' and 'pk=' not in program.url, 's: the reloaded page still holds the key, and the address is still clean', r['hasKey'])
    until(lambda: (lambda o: o['link']['state'] == 'connected' and o['program']['showing'] == 'webrtc' and o['link']['stats']['fps'] > 0)(ops()) and program.evaluate(RX)['state'] == 'connected', 's: the program draws her again', 120, 0.25)
    number('s.program_draws_her_again_after_reload_s', round(time.monotonic() - reload_at, 2))
    settle(program); steady(ops, phone, 's')
    mark('s: the keyed program page reloads and the link comes back by itself', 'link up %.2f s after the reload' % up)

    phone.locator('#stop').click(); phone.locator('#confirm-stop').click()
    until(lambda: ops()['link']['state'] == 'idle', 's: idle after stop', 10)
    for ctx in (phone_ctx, desk): ctx.close()
    log = (ROOT / 'runtime' / 'link.log').read_text(encoding='utf-8')
    check(key not in log and 'v=0' not in log, 's: no key and no SDP in link.log')
    mark('s: stop -> idle; link.log carries no key and no SDP')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=ARGS)
    result['browser'] = browser.version
    print('browser ' + browser.version + ' phase ' + PHASE, flush=True)
    try:
        (run_strict if PHASE == 'strict' else run_dev)(browser)
        errors = [x for x in result['problems'] if 'pageerror' in x]
        check(not errors, 'no script error on any page', errors)
    except Exception as e:
        result['error'] = str(e)[:2000]
        for label in list(pages): shot(label, 'FAILURE-' + label)
        try: result['failure'] = {'ops': pages and next(iter(pages.values())).context.request.get(GATEWAY + '/api/link/ops').json()}
        except Exception: pass
        for label, page in list(pages.items()):
            try: result.setdefault('failurePages', {})[label] = page.evaluate("() => ({ url: location.href.split('#')[0], rx: window.linkReceiver ? window.linkReceiver.state() : null, cam: window.camLink ? { state: window.camLink.state, error: window.camLink.error, snap: window.camLink.snapshot() } : null, log: (document.querySelector('#log') || {}).textContent || '' })")
            except Exception: pass
        raise
    finally:
        (AUDIT / ('link-browser-result-' + PHASE + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
        print(json.dumps({k: result[k] for k in ('phase', 'passed', 'numbers', 'notes', 'problems') if k in result}, ensure_ascii=True, default=str), flush=True)
        browser.close()
