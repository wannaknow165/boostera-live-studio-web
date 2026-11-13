import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../fx/link-core.js';
import { startLinkReceiver } from '../fx/link-receiver.js'; // importing it here is itself a test: no DOM access at load

// CAM LINK v1, the program page (?src=live).
// Part 1: the pure rules in fx/link-core.js.
// Part 2: fx/link-receiver.js itself, run against a fake window with a hand-driven clock, a scripted hub and a fake
//         RTCPeerConnection (no browser, no network, no real time). Real media is proven only by the browser run.

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=sendonly\r\na=rtpmap:96 H264/90000\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\na=sendonly\r\na=rtpmap:111 opus/48000/2\r\na=candidate:1 1 udp 2122260223 192.168.1.50 50000 typ host\r\n' + 'a=x-pad:' + 'x'.repeat(40) + '\r\n';
const withCandidates = (n, proto = i => 'udp') => SDP + Array.from({ length: n }, (_, i) => `a=candidate:${i + 2} 1 ${proto(i)} 2122260223 10.0.0.${i + 1} ${40000 + i} typ host\r\n`).join('');

// ---------------------------------------------------------------- part 1: the pure rules

test('clamp helpers: a number stays inside its range, anything that is not a number becomes the default', () => {
  assert.equal(core.clampNum(5, 0, 10), 5); assert.equal(core.clampNum(-3, 0, 10), 0); assert.equal(core.clampNum(99, 0, 10), 10);
  assert.equal(core.clampNum('7.5', 0, 10), 7.5); assert.equal(core.clampNum(' 4 ', 0, 10), 4);
  for (const bad of [null, undefined, '', '   ', 'abc', NaN, Infinity, -Infinity, {}, [], [5], true, () => 1]) assert.equal(core.clampNum(bad, 0, 10, 3), 3, `not a number: ${String(bad)}`);
  assert.equal(core.clampInt('120.6', 0, 4000, 0), 121); assert.equal(core.clampInt('9999', 0, 4000, 0), 4000); assert.equal(core.clampInt('-1', 0, 4000, 0), 0); assert.equal(core.clampInt(null, 0, 4000, 0), 0);
  assert.equal(core.clampFixed(29.97, 0, 240, 1), 30); assert.equal(core.clampFixed(0.12345, 0, 1, 3), 0.123); assert.equal(core.clampFixed(7, 0, 1, 3), 1); assert.equal(core.clampFixed('x', 0, 1, 3, 0), 0);
  assert.equal(core.hz(30, 1000), 30); assert.equal(core.hz(179, 1000), 179); assert.equal(core.hz(15, 500), 30); assert.equal(core.hz(0, 1000), 0); assert.equal(core.hz(10, 0), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 60].map(core.backoffMs), [500, 1000, 1000, 1000, 1000, 1000, 1000], 'the gateway is on this computer: never more than a second between tries'); assert.equal(core.backoffMs(0), 500);
  assert.equal(core.upperSnake('STREAM_REJECTED'), 'STREAM_REJECTED');
  for (const bad of ['stream_rejected', 'A', 'HAS SPACE', '9LIVES', 'X'.repeat(41), '', null, 42, 'DROP TABLE;--']) assert.equal(core.upperSnake(bad), null, `not a code: ${String(bad)}`);
  assert.equal(core.validAttempt('0b9f6c1e-1c56-4d0a-9d3e-7a1d2b3c4d5e'), '0b9f6c1e-1c56-4d0a-9d3e-7a1d2b3c4d5e');
  for (const bad of ['', 'a b', 'x'.repeat(81), '../x', null, 7]) assert.equal(core.validAttempt(bad), null);
});

test('link options: mirror is on unless mirror=0, audio is off unless audio=1, delays are clamped', () => {
  assert.deepEqual(core.linkOptions('?clean=1&src=live'), { mirror: true, audio: false, sink: null, adelayMs: 0, jbMs: 0, takeover: false, program: '', gw: '', clean: true });
  assert.deepEqual(core.linkOptions('?src=live&mirror=0&audio=1&sink=%20CABLE%20Input%20&adelay=120&jb=80&takeover=1&program=air&gw=http://127.0.0.1:8811'),
    { mirror: false, audio: true, sink: 'CABLE Input', adelayMs: 120, jbMs: 80, takeover: true, program: 'air', gw: 'http://127.0.0.1:8811', clean: false });
  assert.deepEqual(core.linkOptions(new URLSearchParams('mirror=1&audio=true&takeover=yes')), { mirror: true, audio: false, sink: null, adelayMs: 0, jbMs: 0, takeover: false, program: '', gw: '', clean: false }, 'only the exact value 1 turns audio or takeover on');
  const wild = core.linkOptions('?adelay=99999&jb=-5&sink=' + 'x'.repeat(300));
  assert.deepEqual([wild.adelayMs, wild.jbMs, wild.sink.length], [core.MAX_ADELAY_MS, 0, 100]);
  assert.deepEqual([core.linkOptions('?adelay=abc&jb=').adelayMs, core.linkOptions('?adelay=abc&jb=').jbMs], [0, 0]);
  assert.equal(core.linkOptions(undefined).mirror, true); assert.equal(core.linkOptions('').audio, false);
});

test('the page id is 1..40 safe characters; the program key is read from the fragment and taken out of it', () => {
  assert.equal(core.pageIdFrom('air', 'ffff'), 'air'); assert.equal(core.pageIdFrom('my air!/..', 'ffff'), 'myair..'.replace(/\./g, ''));
  assert.equal(core.pageIdFrom('x'.repeat(90), 'ffff').length, 40);
  assert.equal(core.pageIdFrom('', '0123abcd'), 'p-0123abcd'); assert.equal(core.pageIdFrom(null, ''), 'p-0'); assert.equal(core.pageIdFrom('***', 'ab cd'), 'p-abcd');
  assert.deepEqual(core.readProgramKey('#pk=abc123'), { key: 'abc123', rest: '', found: true });
  assert.deepEqual(core.readProgramKey('pk=abc123'), { key: 'abc123', rest: '', found: true }, 'with or without the #');
  assert.deepEqual(core.readProgramKey('#a=1&pk=k%2Fey%2B1&b=2'), { key: 'k/ey+1', rest: '#a=1&b=2', found: true }, 'percent-encoded, among other parts');
  assert.deepEqual(core.readProgramKey('#pk=one&pk=two'), { key: 'one', rest: '', found: true }, 'every pk= part leaves the address');
  assert.deepEqual(core.readProgramKey('#section-2'), { key: '', rest: '#section-2', found: false });
  assert.deepEqual(core.readProgramKey(''), { key: '', rest: '', found: false }); assert.deepEqual(core.readProgramKey(undefined), { key: '', rest: '', found: false });
  for (const bad of ['#pk=', '#pk=%20lead', '#pk=trail%20', '#pk=line%0Abreak', '#pk=tab%09in', '#pk=' + 'k'.repeat(300), '#pk=%D7%A9']) assert.deepEqual(core.readProgramKey(bad), { key: '', rest: '', found: true }, `unusable as a header, still removed: ${bad.slice(0, 20)}`);
  assert.equal(core.readProgramKey('#pk=two%20words').key, 'two words', 'a space inside is fine'); assert.equal(core.readProgramKey('#pk=' + 'k'.repeat(256)).key.length, 256);
  assert.equal(core.readProgramKey('#pk=100%zz').key, '100%zz', 'not percent-encoded: taken as written');
});

test('the gateway is on the page\'s own host, one port up: 8800 -> 8801, 8810 -> 8811, 18880 -> 18881', () => {
  assert.equal(core.defaultGatewayBase({ protocol: 'http:', hostname: '127.0.0.1', port: '8800' }), 'http://127.0.0.1:8801');
  assert.equal(core.defaultGatewayBase({ protocol: 'http:', hostname: '127.0.0.1', port: '8810' }), 'http://127.0.0.1:8811');
  assert.equal(core.defaultGatewayBase({ protocol: 'http:', hostname: '127.0.0.1', port: '18880' }), 'http://127.0.0.1:18881');
  assert.equal(core.defaultGatewayBase({ protocol: 'http:', hostname: 'localhost', port: '8800' }), 'http://localhost:8801', 'the same host name as the page, so the call stays same-site');
  assert.equal(core.defaultGatewayBase({ protocol: 'http:', hostname: '[::1]', port: 8800 }), 'http://[::1]:8801');
  assert.equal(core.defaultGatewayBase({ protocol: 'https:', hostname: 'studio.example', port: '' }), 'https://studio.example:8801', 'no port in the page address: the gateway\'s own default');
  assert.equal(core.defaultGatewayBase({ protocol: 'http:', hostname: '127.0.0.1', port: '65535' }), 'http://127.0.0.1:8801');
  assert.equal(core.defaultGatewayBase(), 'http://127.0.0.1:8801');
});

test('an explicit gw= wins, but only an http(s) address on this computer or on the page\'s own host', () => {
  const page = { protocol: 'http:', hostname: '127.0.0.1', port: '8800' };
  assert.deepEqual(core.gatewayBase('http://127.0.0.1:8811', page), { base: 'http://127.0.0.1:8811', from: 'param' });
  assert.deepEqual(core.gatewayBase('  http://localhost:18881/  ', page), { base: 'http://localhost:18881', from: 'param' }, 'spaces and a trailing slash are dropped');
  assert.deepEqual(core.gatewayBase('http://127.0.0.1:9000/gw/', page), { base: 'http://127.0.0.1:9000/gw', from: 'param' });
  assert.deepEqual(core.gatewayBase('http://studio.lan:8801', { ...page, hostname: 'studio.lan' }), { base: 'http://studio.lan:8801', from: 'param' });
  assert.deepEqual(core.gatewayBase('', page), { base: 'http://127.0.0.1:8801', from: 'default' }); assert.deepEqual(core.gatewayBase(undefined, page), { base: 'http://127.0.0.1:8801', from: 'default' });
  for (const [bad, why] of [['https://evil.example', 'foreign_host'], ['http://192.168.1.77:8801', 'foreign_host'], ['javascript:alert(1)', 'protocol'], ['ftp://127.0.0.1/x', 'protocol'], ['8801', 'not_a_url'], ['http://user:pw@127.0.0.1:8801', 'credentials']])
    assert.deepEqual(core.gatewayBase(bad, page), { base: 'http://127.0.0.1:8801', from: 'default', rejected: why }, `the key is never sent to ${bad}`);
});

test('cover-fit: the centre of the source fills 720x1280 exactly; a landscape frame is cropped, not shrunk; mirror flips it', () => {
  assert.deepEqual(core.coverFit(720, 1280), { sx: 0, sy: 0, sw: 720, sh: 1280, dw: 720, dh: 1280, mirror: false, transform: [1, 0, 0, 1, 0, 0] });
  const same = core.coverFit(1080, 1920); assert.deepEqual([same.sx, same.sy, same.sw, same.sh], [0, 0, 1080, 1920], 'the same shape, another size: all of it');
  const land = core.coverFit(1280, 720); // the phone was turned: only a 405-wide strip of the middle has the 9:16 shape
  near(land.sx, 437.5); near(land.sy, 0); near(land.sw, 405); near(land.sh, 720);
  const wide = core.coverFit(480, 640); near(wide.sx, 60); near(wide.sy, 0); near(wide.sw, 360); near(wide.sh, 640); // 3:4: the sides go
  const tall = core.coverFit(360, 1280); near(tall.sx, 0); near(tall.sy, 320); near(tall.sw, 360); near(tall.sh, 640); // narrower than 9:16: top and bottom go
  for (const [w, h] of [[1280, 720], [480, 640], [360, 1280], [1920, 1080], [641, 359]]) {
    const f = core.coverFit(w, h); near(f.sw / f.sh, 720 / 1280, 1e-9); assert.ok(f.sx >= 0 && f.sy >= 0 && f.sx + f.sw <= w + 1e-9 && f.sy + f.sh <= h + 1e-9, 'the crop lies inside the source');
    const c = core.mapPoint(f, w / 2, h / 2); near(c.x, 360); near(c.y, 640);
  }
  const plain = core.coverFit(1280, 720, 720, 1280, false), flip = core.coverFit(1280, 720, 720, 1280, true);
  assert.deepEqual(flip.transform, [-1, 0, 0, 1, 720, 0]); assert.equal(flip.mirror, true); assert.deepEqual([flip.sx, flip.sy, flip.sw, flip.sh], [plain.sx, plain.sy, plain.sw, plain.sh], 'the same crop, drawn flipped');
  const L = { x: plain.sx, y: 0 }, R = { x: plain.sx + plain.sw, y: 720 };
  assert.deepEqual([core.mapPoint(plain, L.x, L.y), core.mapPoint(plain, R.x, R.y)].map(p => [Math.round(p.x), Math.round(p.y)]), [[0, 0], [720, 1280]]);
  assert.deepEqual([core.mapPoint(flip, L.x, L.y), core.mapPoint(flip, R.x, R.y)].map(p => [Math.round(p.x), Math.round(p.y)]), [[720, 0], [0, 1280]], 'her left is on the right, as in a mirror');
  const other = core.coverFit(1280, 720, 1080, 1920); near(other.sw, 405); assert.equal(other.dw, 1080);
  for (const bad of [[0, 720], [1280, 0], [NaN, 720], [Infinity, 720], [-1, 5], [undefined, undefined]]) assert.equal(core.coverFit(...bad), null, `no size, nothing to draw: ${bad}`);
});

test('freshness over time: live while the decoder\'s counter rose in the last 1.5 s, the last frame held up to 3 s, then black', () => {
  const f = core.newFreshness(), at = now => core.feedDecision({ now, riseAt: f.riseAt }).mode;
  assert.equal(at(0), 'slate', 'never a frame: nothing to hold');
  assert.equal(core.noteFrames(f, 0, 0), false, 'a counter still at zero is not a frame'); assert.equal(at(400), 'slate');
  assert.equal(core.noteFrames(f, 12, 500), true); assert.equal(at(500), 'live');
  assert.equal(core.noteFrames(f, 27, 1000), true); assert.equal(f.riseAt, 1000);
  for (const t of [1500, 2000, 2500, 3000, 3500, 4000]) assert.equal(core.noteFrames(f, 27, t), false, 'the same count again is not a rise');
  assert.deepEqual([2400, 2500, 2501, 3000, 3999, 4000, 9000].map(at), ['live', 'live', 'hold', 'hold', 'hold', 'slate', 'slate']);
  assert.equal(core.noteFrames(f, 30, 5000), true); assert.equal(at(5100), 'live', 'frames again: shown again');
  assert.equal(core.noteFrames(f, 4, 6000), true, 'a counter that went DOWN is a new stream: its frames count'); assert.equal(f.riseAt, 6000);
  for (const junk of [undefined, null, NaN, '31', -1, Infinity]) assert.equal(core.noteFrames(f, junk, 6500), false, `no reading: ${String(junk)}`);
  assert.deepEqual([f.frames, f.riseAt], [4, 6000]);
  // the phone said "camera not live / page hidden": black 3 s later, even though packets still flow
  assert.deepEqual(core.feedDecision({ now: 10000, riseAt: 9900, captureBadSince: 7500 }), { mode: 'live', why: null });
  assert.deepEqual(core.feedDecision({ now: 10000, riseAt: 9900, captureBadSince: 7000 }), { mode: 'slate', why: 'capture' });
  assert.deepEqual(core.feedDecision({ now: 10000, riseAt: 9900, captureBadSince: null }), { mode: 'live', why: null });
  assert.deepEqual(core.feedDecision({ now: 10000, riseAt: 8000 }), { mode: 'hold', why: 'gap' });
  assert.deepEqual(core.feedDecision({ now: 10000, riseAt: 7000 }), { mode: 'slate', why: 'no_frames' });
  assert.deepEqual([core.FRESH_MS, core.SLATE_MS, core.STATS_MS, core.DRAW_MIN_MS, core.NORM_W, core.NORM_H], [1500, 3000, 500, 31, 720, 1280]);
  // the rules are judged no later than one reading period (and a bit) after the last reading: a page that was held up
  // for seconds has not SEEN a silent feed, it has only not looked
  assert.equal(core.judgeAt(5000, null), 5000, 'no reading yet: the real time');
  assert.deepEqual([4000, 4400, 4750, 4751, 9000].map(now => core.judgeAt(now, 4000)), [4000, 4400, 4750, 4750, 4750]);
  assert.equal(core.feedDecision({ now: core.judgeAt(9000, 4000), riseAt: 4000 }).mode, 'live', 'held up for 5 s right after a reading with frames: still live');
  assert.equal(core.feedDecision({ now: core.judgeAt(9100, 9050), riseAt: 4000 }).mode, 'slate', 'the next reading shows no new frame: now it is known, and the slate comes at once');
});

test('the word the page reports: loading until the engine is ready, connected only with frames, stalled / lost when they stop', () => {
  const S = o => core.linkState({ engineReady: true, hasPc: true, connectedAt: 1000, firstFrameAt: 1200, mode: 'live', now: 5000, ...o });
  assert.equal(S({ engineReady: false }), 'loading'); assert.equal(S({ engineReady: false, hasPc: false }), 'loading', 'whatever the link does');
  assert.equal(S({ hasPc: false }), 'idle'); assert.equal(S({ hasPc: false, lostLinger: true }), 'lost');
  assert.equal(S({ connectedAt: null, firstFrameAt: null }), 'answering');
  assert.equal(S({ firstFrameAt: null, now: 3999 }), 'answering', 'connected, the first frame still on its way');
  assert.equal(S({ firstFrameAt: null, now: 4000 }), 'lost', 'connected for 3 s and never a frame');
  assert.equal(S({}), 'connected'); assert.equal(S({ mode: 'hold' }), 'stalled'); assert.equal(S({ mode: 'slate' }), 'lost');
  assert.equal(S({ mode: 'slate', captureAway: true }), 'stalled', 'the phone itself said its camera is away: the link is not lost');
  assert.equal(S({ mode: 'live', captureAway: true }), 'connected');
});

test('a stream bigger than 1280x720x1.2 pixels, or one that changes size more than 5 times in 10 s, is refused', () => {
  const g = core.newSizeGuard();
  assert.equal(core.noteSize(g, 0, 0, 0), 'ok', 'no size yet'); assert.equal(core.noteSize(g, 720, 1280, 100), 'ok'); assert.equal(core.noteSize(g, 1280, 720, 200), 'ok');
  assert.equal(core.noteSize(core.newSizeGuard(), 1152, 960, 0), 'ok', 'exactly at the limit'); assert.equal(core.noteSize(core.newSizeGuard(), 1280, 865, 0), 'too_large');
  assert.equal(core.noteSize(core.newSizeGuard(), 1920, 1080, 0), 'too_large'); assert.equal(core.noteSize(core.newSizeGuard(), 1080, 1920, 0), 'too_large');
  const c = core.newSizeGuard(), sizes = [[320, 180], [480, 270], [640, 360], [960, 540], [1280, 720], [960, 540]];
  assert.deepEqual(sizes.map(([w, h], i) => core.noteSize(c, w, h, i * 1000)), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'], 'the first size is not a change: 5 changes are still fine');
  assert.equal(core.noteSize(c, 960, 540, 6000), 'ok', 'the same size again is not a change');
  assert.equal(core.noteSize(c, 1280, 720, 6500), 'churn', 'the sixth change inside 10 s');
  const slow = core.newSizeGuard(); for (let i = 0; i < 40; i++) assert.equal(core.noteSize(slow, i % 2 ? 720 : 540, i % 2 ? 1280 : 960, i * 2500), 'ok', 'a change every 2.5 s is never more than 5 in 10 s');
});

test('gather-done: complete, or a host candidate and 300 ms of quiet, or 2 s — whichever comes first', () => {
  assert.deepEqual(core.gatherDecision({ complete: true, elapsedMs: 5 }), { done: true, why: 'complete', waitMs: 0 });
  assert.deepEqual(core.gatherDecision({ hostSeen: true, sinceCandidateMs: 299, elapsedMs: 500 }), { done: false, why: null, waitMs: 1 });
  assert.deepEqual(core.gatherDecision({ hostSeen: true, sinceCandidateMs: 300, elapsedMs: 500 }), { done: true, why: 'quiet', waitMs: 0 });
  assert.deepEqual(core.gatherDecision({ hostSeen: false, sinceCandidateMs: 1500, elapsedMs: 1999 }), { done: false, why: null, waitMs: 1 }, 'quiet alone is not enough without a host candidate');
  assert.deepEqual(core.gatherDecision({ hostSeen: false, sinceCandidateMs: 0, elapsedMs: 2000 }), { done: true, why: 'cap', waitMs: 0 });
  assert.deepEqual(core.gatherDecision({ hostSeen: true, sinceCandidateMs: 100, elapsedMs: 1900 }), { done: false, why: null, waitMs: 100 }, 'look again when the cap arrives, if that is sooner');
  assert.deepEqual(core.gatherDecision({ hostSeen: true, sinceCandidateMs: 100, elapsedMs: 200 }), { done: false, why: null, waitMs: 200 });
  assert.deepEqual(core.gatherDecision({}), { done: false, why: null, waitMs: 2000 }); assert.deepEqual(core.gatherDecision(), { done: false, why: null, waitMs: 2000 });
  assert.deepEqual([core.GATHER_QUIET_MS, core.GATHER_CAP_MS, core.CONNECT_MS, core.BUSY_RETRY_MS], [300, 2000, 10000, 5000]);
  assert.equal(core.isHostCandidate({ type: 'host', candidate: 'candidate:1 1 udp 2122260223 4f3a.local 50000 typ host generation 0' }), true, 'an mDNS name is still a host candidate');
  assert.equal(core.isHostCandidate({ type: 'srflx', candidate: 'candidate:2 1 udp 1686052607 203.0.113.9 50001 typ srflx raddr 0.0.0.0 rport 0' }), false);
  assert.equal(core.isHostCandidate('candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host'), true); assert.equal(core.isHostCandidate({ candidate: 'candidate:1 1 udp 1 192.168.1.20 5 typ host tcptype active' }), true);
  assert.equal(core.isHostCandidate('candidate:1 1 udp 1 192.168.1.20 5 typ hostile'), false); assert.equal(core.isHostCandidate('candidate:9 1 udp 1 198.51.100.1 5 typ relay'), false);
  for (const none of [null, undefined, '', {}]) assert.equal(core.isHostCandidate(none), false);
});

test('SDP sanity check: 200..60000 characters, starts with v=0, 1..3 m= lines, at most 40 candidates', () => {
  assert.equal(core.sdpProblem(SDP), null); assert.equal(core.sdpProblem(SDP.replace(/\r\n/g, '\n').padEnd(260, ' ')), null, 'bare line feeds are read too');
  assert.equal(core.sdpProblem(withCandidates(39)), null, '40 candidates in all'); assert.equal(core.sdpProblem(withCandidates(40)), 'too_many_candidates');
  for (const notText of [undefined, null, 42, {}, ['v=0']]) assert.equal(core.sdpProblem(notText), 'not_a_string');
  assert.equal(core.sdpProblem('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'), 'length'); assert.equal(core.sdpProblem(SDP + 'a=x:' + 'y'.repeat(60000)), 'length');
  assert.equal(core.sdpProblem(' ' + SDP), 'no_v0'); assert.equal(core.sdpProblem(SDP.replace('v=0', 'v=1')), 'no_v0');
  assert.equal(core.sdpProblem(SDP.replace(/m=/g, 'x=')), 'no_m_line'); assert.equal(core.sdpProblem(SDP + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'), null, 'three m= lines');
  assert.equal(core.sdpProblem(SDP + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nm=video 9 UDP/TLS/RTP/SAVPF 97\r\n'), 'too_many_m_lines');
  for (const sdp of [42, 'short', ' ' + SDP, withCandidates(40)]) assert.ok(!String(core.sdpProblem(sdp)).includes('192.168.'), 'the reason never quotes the SDP');
});

test('our own answer never carries more than 40 candidates: TCP ones are left out first, then the last ones', () => {
  assert.equal(core.capCandidates(SDP), SDP); const exact = withCandidates(39); assert.equal(core.capCandidates(exact), exact, 'nothing to cut: the very same text');
  const many = withCandidates(59, i => (i % 2 ? 'tcp' : 'udp')), cut = core.capCandidates(many), lines = cut.split('\r\n').filter(l => l.startsWith('a=candidate:'));
  assert.equal(lines.length, 40); assert.equal(lines.filter(l => l.split(' ')[2] === 'udp').length, 31, 'every UDP candidate is still there');
  assert.equal(core.sdpProblem(cut), null); assert.ok(cut.endsWith('\r\n') && cut.includes('m=audio') && cut.includes('a=mid:1'), 'every other line stays, in order');
  assert.deepEqual(cut.split('\r\n').filter(l => !l.startsWith('a=candidate:')), many.split('\r\n').filter(l => !l.startsWith('a=candidate:')));
  const udpOnly = core.capCandidates(withCandidates(50)).split('\r\n').filter(l => l.startsWith('a=candidate:'));
  assert.equal(udpOnly.length, 40); assert.equal(udpOnly[0], 'a=candidate:1 1 udp 2122260223 192.168.1.50 50000 typ host', 'the first ones are kept'); assert.ok(udpOnly.at(-1).includes(' 10.0.0.39 '));
  assert.equal(core.capCandidates(withCandidates(50).replace(/\r\n/g, '\n')).split('\n').filter(l => l.startsWith('a=candidate:')).length, 40, 'bare line feeds too');
  assert.equal(core.capCandidates(withCandidates(9), 3).split('\r\n').filter(l => l.startsWith('a=candidate:')).length, 3); assert.equal(core.capCandidates(undefined), undefined);
});

test('ICE servers that came with the offer are checked again before they reach the browser', () => {
  assert.deepEqual(core.cleanIceServers([{ urls: 'stun:stun.example.org:3478' }, { urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349?transport=tcp'], username: 'u', credential: 'c', extra: 1 }]),
    [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349?transport=tcp'], username: 'u', credential: 'c' }]);
  assert.deepEqual(core.cleanIceServers([{ urls: 'http://evil.example/' }, { urls: 'stun:UPPER.example' }, { urls: 'stun:a b' }, {}, null, 'stun:x', { urls: ['javascript:1', 'stun:ok.example'] }]), [{ urls: ['stun:ok.example'] }]);
  for (const none of [undefined, null, 'stun:x.example', {}, 7]) assert.deepEqual(core.cleanIceServers(none), []);
  assert.equal(core.cleanIceServers(Array.from({ length: 30 }, () => ({ urls: 'stun:s.example' }))).length, 8, 'never a long list: every server lengthens gathering');
});

test('what a poll reply means: a message, empty, busy (ask again), superseded (stop for good), denied, error', () => {
  const A = 'attempt-1';
  assert.deepEqual(core.pollOutcome(200, { seq: 7, type: 'offer', attempt: A, sdp: SDP, iceServers: [{ urls: 'stun:s.example' }], client: { label: '<b>phone</b>' } }),
    { kind: 'message', message: { seq: 7, type: 'offer', attempt: A, sdp: SDP, iceServers: [{ urls: ['stun:s.example'] }] } }, 'the free-form client label is not carried along');
  assert.deepEqual(core.pollOutcome(200, { seq: 8, type: 'stop', attempt: A, reason: 'client_stop' }).message, { seq: 8, type: 'stop', attempt: A, reason: 'client_stop' });
  assert.equal(core.pollOutcome(200, { seq: 8, type: 'stop', attempt: A, reason: '<script>' }).message.reason, 'stop');
  assert.deepEqual(core.pollOutcome(200, { seq: 9, type: 'capture', attempt: A, video: 'muted', audio: 'live', visible: true }).message, { seq: 9, type: 'capture', attempt: A, video: 'muted', audio: 'live', visible: true });
  assert.deepEqual(core.pollOutcome(200, { seq: 9, type: 'capture', attempt: A }).message, { seq: 9, type: 'capture', attempt: A, video: 'live', audio: 'live', visible: true }, 'only an explicit "muted", "ended" or visible:false takes the picture away');
  for (const m of [{ seq: 3, type: 'offer', attempt: A }, { seq: 3, type: 'offer', attempt: 'bad id', sdp: SDP }, { seq: 3, type: 'stop' }, { seq: 3, type: 'future-thing' }, { seq: 3 }])
    assert.deepEqual(core.pollOutcome(200, m), { kind: 'message', message: { seq: 3, type: 'ignored' } }, 'a message that cannot be used is still acknowledged: asking again would not repair it');
  for (const junk of [null, 'text', [], { type: 'offer' }, { seq: '4', type: 'stop', attempt: A }, { seq: -1 }, { seq: 1.5 }]) assert.deepEqual(core.pollOutcome(200, junk), { kind: 'error', code: 'BAD_MESSAGE' });
  assert.deepEqual(core.pollOutcome(204, null), { kind: 'empty' });
  assert.deepEqual(core.pollOutcome(409, { error: 'PROGRAM_BUSY' }), { kind: 'busy', code: 'PROGRAM_BUSY' }); assert.deepEqual(core.pollOutcome(409, null), { kind: 'busy', code: 'PROGRAM_BUSY' });
  assert.deepEqual(core.pollOutcome(410, { error: 'PROGRAM_SUPERSEDED' }), { kind: 'superseded', code: 'PROGRAM_SUPERSEDED' }); assert.equal(core.pollOutcome(410, null).kind, 'superseded');
  assert.deepEqual(core.pollOutcome(403, { error: 'PROGRAM_KEY_REQUIRED' }), { kind: 'denied', code: 'PROGRAM_KEY_REQUIRED' }); assert.deepEqual(core.pollOutcome(403, { error: 'PROGRAM_ORIGIN_REQUIRED' }), { kind: 'denied', code: 'PROGRAM_ORIGIN_REQUIRED' });
  assert.deepEqual(core.pollOutcome(401, { error: 'free text <b>' }), { kind: 'denied', code: 'FORBIDDEN' }, 'only an UPPER_SNAKE code is repeated');
  assert.deepEqual(core.pollOutcome(503, null), { kind: 'error', code: 'HTTP_503' }); assert.deepEqual(core.pollOutcome(0, null), { kind: 'error', code: 'UNREACHABLE' }); assert.deepEqual(core.pollOutcome(500, { error: 'REQUEST_FAILED' }), { kind: 'error', code: 'REQUEST_FAILED' });
  assert.equal(core.cameraAway({ video: 'live', visible: true }), false); assert.equal(core.cameraAway({ video: 'muted', visible: true }), true); assert.equal(core.cameraAway({ video: 'ended', visible: true }), true);
  assert.equal(core.cameraAway({ video: 'live', visible: false }), true); assert.equal(core.cameraAway(null), false);
});

test('reading getStats(): frames, size, rates between two readings, the path as candidate types only', () => {
  const report = (o = {}) => [
    { id: 'v', type: 'inbound-rtp', kind: 'video', framesDecoded: 300, frameWidth: 720, frameHeight: 1280, framesPerSecond: 30, bytesReceived: 100000, packetsReceived: 1000, packetsLost: 10, freezeCount: 2, jitter: 0.005, ...o.v },
    { id: 'a', type: 'inbound-rtp', kind: 'audio', audioLevel: 0.1, totalAudioEnergy: 0.5, totalSamplesDuration: 10, bytesReceived: 20000, ...o.a },
    { id: 't', type: 'transport', selectedCandidatePairId: 'p2' },
    { id: 'p1', type: 'candidate-pair', nominated: false, state: 'waiting', currentRoundTripTime: 9, localCandidateId: 'l', remoteCandidateId: 'x' },
    { id: 'p2', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.02, localCandidateId: 'l', remoteCandidateId: 'r' },
    { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.20', port: 50000 },
    { id: 'r', type: 'remote-candidate', candidateType: 'prflx', protocol: 'udp', address: '192.168.1.50', port: 50001, ...o.r },
    { id: 'x', type: 'remote-candidate', candidateType: 'relay', protocol: 'tcp' },
  ];
  const first = core.summarizeStats(report(), null, 1000);
  assert.deepEqual([first.hasVideo, first.hasAudio, first.framesDecoded, first.w, first.h, first.fps, first.freezeCount, first.kbps, first.lossPct, first.level], [true, true, 300, 720, 1280, 30, 2, 0, 0, 0.1]);
  near(first.jitterMs, 5); near(first.rttMs, 20); assert.deepEqual(first.path, { local: 'host', remote: 'prflx', protocol: 'udp' });
  assert.ok(!JSON.stringify(first).includes('192.168.'), 'no address leaves the reading');
  const second = core.summarizeStats(report({ v: { framesDecoded: 330, bytesReceived: 330000, packetsReceived: 1300, packetsLost: 25 }, a: { totalAudioEnergy: 0.54, totalSamplesDuration: 11, bytesReceived: 40000 } }), first.next, 2000);
  near(second.kbps, 2000); near(second.lossPct, 15 * 100 / 315); near(second.level, 0.2); assert.equal(second.fps, 30); assert.equal(second.framesDecoded, 330);
  const soon = core.summarizeStats(report({ v: { framesDecoded: 333, bytesReceived: 999999 } }), second.next, 2100);
  near(soon.kbps, 2000); assert.equal(soon.framesDecoded, 333); assert.equal(soon.next, second.next, 'a reading under 200 ms later keeps the rates and the baseline');
  const noRate = core.summarizeStats(report({ v: { framesDecoded: 345, framesPerSecond: undefined } }), second.next, 2500); near(noRate.fps, 30, 1e-9);
  assert.equal(core.summarizeStats(report({ r: { candidateType: '192.168.1.50' } }), null, 0).path, null, 'anything but a candidate type: no path');
  const twoStreams = core.summarizeStats([{ type: 'inbound-rtp', kind: 'video', framesDecoded: 0 }, { type: 'inbound-rtp', mediaType: 'video', framesDecoded: 50, frameWidth: 640, frameHeight: 360 }], null, 0);
  assert.deepEqual([twoStreams.framesDecoded, twoStreams.w, twoStreams.path, twoStreams.hasAudio], [50, 640, null, false]);
  const nothing = core.summarizeStats([], null, 0); for (const k of Object.keys(core.ZERO_STATS)) assert.deepEqual(nothing[k], core.ZERO_STATS[k], k);
  assert.equal(core.summarizeStats(null, null, 0).hasVideo, false); assert.equal(core.summarizeStats([null, 5, 'x'], null, 0).framesDecoded, 0);
});

test('sink=: the device itself is chosen over its "Default - …" alias; no match (or hidden names) means silence', () => {
  const devices = [{ kind: 'audioinput', deviceId: 'mic', label: 'Microphone (CABLE Output)' }, { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers (Realtek)' }, { kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Speakers (Realtek)' },
    { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers (Realtek)' }, { kind: 'audiooutput', deviceId: 'cab', label: 'CABLE Input (VB-Audio Virtual Cable)' }];
  assert.equal(core.pickSink(devices, 'cable').deviceId, 'cab', 'case does not matter, and a microphone is never an output');
  assert.equal(core.pickSink(devices, 'Speakers').deviceId, 'spk', 'the device stays chosen when somebody changes the Windows default later');
  assert.equal(core.pickSink(devices, 'Default').deviceId, 'default', 'only the alias matches: then the alias');
  assert.equal(core.pickSink(devices, 'headphones'), null); assert.equal(core.pickSink(devices, ''), null); assert.equal(core.pickSink(devices, '   '), null); assert.equal(core.pickSink(null, 'cable'), null);
  const hidden = [{ kind: 'audiooutput', deviceId: '', label: '' }];
  assert.equal(core.pickSink(hidden, 'cable'), null); assert.equal(core.sinksHidden(hidden), true); assert.equal(core.sinksHidden(devices), false); assert.equal(core.sinksHidden([]), false);
  assert.equal(core.sinkLabel('CABLE Input (VB-Audio Virtual Cable)'), 'CABLE Input VB-Audio Virtual Cable'); assert.equal(core.sinkLabel('no_sink'), 'no_sink'); assert.equal(core.sinkLabel('default'), 'default');
  assert.equal(core.sinkLabel('<img src=x onerror=1>' + 'y'.repeat(80)).length, 40); assert.match(core.sinkLabel('<img src=x onerror=1>'), /^[A-Za-z0-9 ._/-]+$/); assert.equal(core.sinkLabel(null), null); assert.equal(core.sinkLabel('()'), null);
});

test('the state echo carries the keys of the spec and nothing else: numbers clamped, words from fixed lists, under 2 KiB', () => {
  const body = core.stateBody({ program: 'air', inst: 'load-1', attempt: 'attempt-1', state: 'connected', showing: 'webrtc', hidden: false, lastError: null, secret: 'test-only-key', sdp: SDP,
    stats: { w: 720, h: 1280, fps: 29.97, framesDecoded: 1234, freezeCount: 1, jitterMs: 4.26, kbps: 2104.7, rttMs: 12.34, lossPct: 0.42, rafHz: 179.4, drawHz: 29.8, pcCreated: 3, vw: 736, vh: 1319, dpr: 1, extra: 'x', address: '192.168.1.50' },
    audio: { wanted: true, playing: true, level: 0.12345, sink: 'CABLE Input (VB-Audio Virtual Cable)', deviceId: 'cab' }, path: { local: 'host', remote: 'prflx', protocol: 'UDP', address: '192.168.1.50' } });
  assert.deepEqual(body, { program: 'air', inst: 'load-1', attempt: 'attempt-1', state: 'connected', showing: 'webrtc',
    stats: { w: 720, h: 1280, fps: 30, framesDecoded: 1234, freezeCount: 1, jitterMs: 4.3, kbps: 2105, rttMs: 12.3, lossPct: 0.4, rafHz: 179.4, drawHz: 29.8, pcCreated: 3, vw: 736, vh: 1319, dpr: 1 },
    hidden: false, audio: { wanted: true, playing: true, level: 0.123, sink: 'CABLE Input VB-Audio Virtual Cable' }, path: { local: 'host', remote: 'prflx', protocol: 'udp' }, lastError: null });
  const wild = core.stateBody({ program: '<air>', inst: '<x y>' + 'z'.repeat(60), attempt: 'not an id', state: 'on fire', showing: 'hls', hidden: 'yes', lastError: 'it broke :(', stats: { w: -5, h: 1e9, fps: 999, framesDecoded: 'many', kbps: NaN, lossPct: 250, dpr: 99, rafHz: -1 }, audio: { level: 7, sink: 42 }, path: { local: 'host', remote: '192.168.1.50', protocol: 'udp' } });
  assert.deepEqual([wild.program, wild.attempt, wild.state, wild.showing, wild.hidden, wild.lastError, wild.path], ['air', null, 'idle', 'slate', true, null, null]);
  assert.deepEqual([wild.stats.w, wild.stats.h, wild.stats.fps, wild.stats.framesDecoded, wild.stats.kbps, wild.stats.lossPct, wild.stats.dpr, wild.stats.rafHz, wild.stats.vw], [0, 8192, 240, 0, 0, 100, 16, 0, 0]);
  assert.deepEqual(wild.audio, { wanted: false, playing: false, level: 1, sink: '42' });
  assert.deepEqual([wild.inst, core.stateBody({}).inst], ['xy' + 'z'.repeat(38), ''], 'the per-load value: 40 safe characters at most, empty when the page has none');
  assert.equal(core.stateBody({ state: 'lost', lastError: 'STREAM_REJECTED' }).lastError, 'STREAM_REJECTED');
  assert.deepEqual([core.stateBody({}).stats.rafHz, core.stateBody({ stats: { rafHz: null, drawHz: undefined } }).stats.drawHz, core.stateBody({ stats: { rafHz: 0 } }).stats.rafHz], [null, null, 0], 'a rate that was not measured yet is null, never "0 = throttled"');
  for (const s of ['loading', 'idle', 'answering', 'connected', 'stalled', 'lost']) assert.equal(core.stateBody({ state: s }).state, s);
  const biggest = core.stateBody({ program: 'p'.repeat(40), inst: 'i'.repeat(40), attempt: 'a'.repeat(80), state: 'answering', showing: 'webrtc', hidden: true, lastError: 'E'.repeat(40), audio: { wanted: true, playing: true, level: 0.999, sink: 'S'.repeat(40) }, path: { local: 'srflx', remote: 'relay', protocol: 'tcp' },
    stats: { w: 8192, h: 8192, fps: 239.9, framesDecoded: 999999999999, freezeCount: 999999999, jitterMs: 9999.9, kbps: 99999, rttMs: 59999.9, lossPct: 99.9, rafHz: 999.9, drawHz: 999.9, pcCreated: 999999999, vw: 19999, vh: 19999, dpr: 15.99 } });
  assert.ok(JSON.stringify(biggest).length < 1024, 'well under the hub\'s 2 KiB');
  assert.ok(!JSON.stringify([body, wild]).includes('test-only-key') && !JSON.stringify([body, wild]).includes('192.168.') && !JSON.stringify(body).includes('v=0'), 'no key, no address, no SDP');
});

test('fx/index.html: the four hooks are in place — receiver before the engine, head start, "live" is not a file, opponent watcher off, text not markup', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../fx/index.html', import.meta.url), 'utf8'), at = text => { const i = html.indexOf(text); assert.ok(i >= 0, 'fx/index.html has: ' + text); return i; };
  const started = at("const linkRx = qs.get('src') === 'live' ? import('./link-receiver.js').then(m => m.startLinkReceiver({ fx, video, log, qs }))");
  const loaded = at('await loadAll();'), head = at('if (linkRx) await (await linkRx)?.headStart;'), init = at('await fx.init(); fx.start();');
  assert.ok(at('const qs = new URLSearchParams(location.search);') < started && started < loaded && loaded < head && head < init, 'the hub client starts right after the query string is read, and the engine waits for the head start');
  assert.ok(at("else if (qs.get('src') === 'live') { /* receiver already started */ }") < at("else if (qs.get('src')) useSrc(qs.get('src'));"), '"live" is never taken for a file name');
  at("if (qs.get('opp') === '1' || (qs.get('src') !== 'live' && qs.get('opp') !== '0')) fx.watchOpponent(");
  at('if (logLines.length > 200) logLines.length = 200;'); at('b.textContent = e.title || e.id;'); at("log('קיר מהענן מאחורי המצלמה: ' + new URL(stageUrl).origin)");
  assert.ok(!/window\.fxStage = \{ url:/.test(html) && !/b\.innerHTML = `\$\{e\.title/.test(html), 'the stage address is not exposed and an effect title is never markup');
  assert.ok(!html.includes("from './link-receiver.js'"), 'the receiver is loaded on demand, so no other source pays for it');
});

// ---------------------------------------------------------------- part 2: the receiver, in a fake window

const ANSWER = SDP.replace(/a=candidate:[^\r]*\r\n/g, '').replace(/sendonly/g, 'recvonly');

// A window with a hand-driven clock (timers, animation frames at 60 Hz), a DOM that records what is done to it, a hub that
// follows spec section 5, and an RTCPeerConnection whose states and counters the test sets. advance(ms) runs the clock.
function makeWorld({ url = 'http://127.0.0.1:8800/fx/?clean=1&src=live&program=air&takeover=1', devices = [], autoplay = true, storage = null } = {}) {
  let t = 0, ids = 0, current = null, nextFrameAt = 0;
  const FRAME_MS = 1000 / 60, timers = new Map(), rafs = new Map();
  const world = { rafOn: true, autoplay, devices, elements: [], pcs: [], calls: [], beacons: [], cancelled: [], listeners: {}, docListeners: {}, devListeners: [], logs: [], gatherPlan: [{ at: 10, type: 'host' }, { at: 20, type: 'srflx' }], gatherCompleteAt: null };
  const setT = (fn, ms = 0, every = 0) => { const id = ++ids; timers.set(id, { at: t + Math.max(0, ms || 0), fn, every }); return id; };
  const flush = () => new Promise(r => setImmediate(r));
  world.now = () => t;
  world.jump = ms => { t += ms; }; // the page is held up: the clock runs on, no timer and no animation frame runs until the next advance()
  world.advance = async ms => {
    const end = t + ms;
    for (;;) {
      let next = end, what = null;
      for (const [id, tm] of timers) if (tm.at <= next && (tm.at < next || !what)) { next = tm.at; what = { id, tm }; }
      if (world.rafOn && nextFrameAt <= next && (nextFrameAt < next || !what)) { next = nextFrameAt; what = 'raf'; }
      if (!what) break;
      t = Math.max(t, next);
      if (what === 'raf') { nextFrameAt += FRAME_MS; current = new Map(rafs); rafs.clear(); for (const [id, fn] of [...current]) if (current.has(id)) fn(t); current = null; }
      else { if (what.tm.every) what.tm.at += what.tm.every; else timers.delete(what.id); what.tm.fn(); }
      await flush();
    }
    t = end; if (!world.rafOn) nextFrameAt = Math.max(nextFrameAt, t); await flush();
  };
  // ---- DOM ----
  const el = tag => {
    const e = { tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, appendChild() {} };
    if (tag === 'canvas') {
      e.ops = []; e.grabs = 0; e.transform = [1, 0, 0, 1, 0, 0];
      e.ctx = { fillStyle: '', setTransform: (...a) => { e.transform = a; }, fillRect: (...a) => e.ops.push({ op: 'fill', style: e.ctx.fillStyle, a }), drawImage: (src, ...a) => { if (world.drawThrows) throw Object.assign(new Error('boom'), { name: 'InvalidStateError' }); e.ops.push({ op: 'draw', src, a, transform: e.transform }); } };
      e.getContext = (kind, o) => { e.ctxKind = kind; e.ctxOpts = o; return e.ctx; };
      e.captureStream = fps => (e.stream = { fps, getVideoTracks: () => [e.track ||= { kind: 'video', requestFrame() { e.grabs++; } }] });
    }
    if (tag === 'video' || tag === 'audio') {
      let src = null; // a new source: no frame yet and paused, as in a browser
      Object.defineProperty(e, 'srcObject', { enumerable: true, get: () => src, set(v) { src = v; e.readyState = 0; e.videoWidth = 0; e.videoHeight = 0; e.paused = true; } });
      Object.assign(e, { muted: false, paused: true, readyState: 0, videoWidth: 0, videoHeight: 0, volume: 1, sinkId: '', plays: 0,
        play() { this.plays++; if (tag === 'audio' && !this.muted && !world.autoplay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })); this.paused = false; return Promise.resolve(); },
        pause() { this.paused = true; },
        setSinkId(id) { if (world.sinkFails) return Promise.reject(Object.assign(new Error('no'), { name: 'NotFoundError' })); this.sinkId = id; return Promise.resolve(); } });
    }
    world.elements.push(e); return e;
  };
  const u = new URL(url), loc = world.loc = { protocol: u.protocol, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash };
  const doc = world.doc = { title: 'WANNA Live FX', hidden: false, body: { appendChild(e) { e.inDom = true; } }, createElement: el, addEventListener(k, f) { (world.docListeners[k] ||= []).push(f); } };
  const hist = world.hist = { state: null, replaced: [], replaceState(state, title, to) { this.replaced.push(to); const i = to.indexOf('#'); loc.hash = i < 0 ? '' : to.slice(i); } };
  const nav = { sendBeacon(to) { world.beacons.push(to); return true; }, mediaDevices: { enumerateDevices: async () => world.devices, addEventListener(k, f) { world.devListeners.push(f); } } };
  // ---- the hub (spec section 5): a queue with seq, `after` acknowledges, one parked poll, 25 s wait ----
  const hub = world.hub = { seq: 0, queue: [], parked: null, pollMs: 25000, pollReply: null, down: false, polls: [], answers: [], states: [], answerReply: { status: 200, body: { ok: true } } };
  hub.deliver = msg => { const m = { seq: ++hub.seq, ...msg }; hub.queue.push(m); if (hub.parked && m.seq > hub.parked.after) hub.parked.done(200, m); return m; };
  hub.offer = (attempt, extra = {}) => hub.deliver({ type: 'offer', attempt, sdp: SDP, iceServers: [], client: { label: 'phone' }, ...extra });
  const fetch = (to, init = {}) => new Promise((resolve, reject) => {
    const U = new URL(to), rec = { at: t, method: init.method || 'GET', origin: U.origin, path: U.pathname, query: Object.fromEntries(U.searchParams), headers: { ...(init.headers || {}) }, body: init.body ? JSON.parse(init.body) : null, credentials: init.credentials, cache: init.cache };
    world.calls.push(rec);
    let settled = false;
    const reply = (status, body) => { if (settled) return; settled = true; resolve({ status, ok: status >= 200 && status < 300, json: async () => { if (body === undefined) throw new SyntaxError('no body'); return body; } }); };
    const fail = () => { if (settled) return; settled = true; reject(new TypeError('Failed to fetch')); };
    if (init.signal) init.signal.addEventListener('abort', () => { if (settled) return; settled = true; if (hub.parked && hub.parked.rec === rec) { timers.delete(hub.parked.timer); hub.parked = null; } reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    if (hub.down) return fail();
    if (U.pathname === '/api/link/program/poll') {
      hub.polls.push(rec);
      if (hub.pollReply) return reply(hub.pollReply.status, hub.pollReply.body);
      const after = Number(rec.query.after);
      if (hub.parked) hub.parked.done(204); // the same page polling again replaces its own parked poll
      if (!hub.keepAcked) hub.queue = hub.queue.filter(m => m.seq > after);
      const next = hub.queue.find(m => m.seq > after) || (hub.ignoreAfter && hub.queue[0]);
      if (next) return reply(200, next);
      const timer = setT(() => { hub.parked = null; reply(204); }, hub.pollMs);
      hub.parked = { rec, after, timer, done(status, body) { timers.delete(timer); hub.parked = null; reply(status, body); } };
      return;
    }
    if (U.pathname === '/api/link/program/answer') { hub.answers.push(rec); const r = typeof hub.answerReply === 'function' ? hub.answerReply(rec) : hub.answerReply; return r === 'down' ? fail() : reply(r.status, r.body); }
    if (U.pathname === '/api/link/program/state') { hub.states.push(rec); return reply(200, { ok: true }); }
    reply(404, { error: 'NOT_FOUND' });
  });
  // ---- WebRTC ----
  class FakePC {
    constructor(cfg) {
      if (world.pcThrowsOnIce && cfg.iceServers && cfg.iceServers.length) throw Object.assign(new Error('bad ice'), { name: 'InvalidAccessError' });
      world.pcs.push(this); this.cfg = cfg; this.connectionState = 'new'; this.iceGatheringState = 'new'; this.localDescription = null; this.closed = false;
      this.receivers = [{ jitterBufferTarget: null }, { jitterBufferTarget: null }];
      this.video = { kind: 'video', readyState: 'live', muted: false }; this.audio = { kind: 'audio', readyState: 'live', muted: false };
      this.s = { frames: 0, w: 720, h: 1280, fps: 30, bytes: 0, packets: 0, lost: 0, audioLevel: 0 };
    }
    async setRemoteDescription() {
      if (world.srdMs) await new Promise(r => setT(r, world.srdMs));
      if (world.srdFails) throw Object.assign(new Error('Failed to parse SessionDescription. a=candidate:1 1 udp 2122260223 192.168.1.50 50000 typ host'), { name: 'OperationError' });
      if (this.ontrack) { if (!world.audioOnly) this.ontrack({ track: this.video }); this.ontrack({ track: this.audio }); }
    }
    async createAnswer() { return { type: 'answer', sdp: ANSWER }; }
    async setLocalDescription(d) {
      this.localDescription = { type: 'answer', sdp: d.sdp }; this.iceGatheringState = 'gathering';
      for (const c of world.gatherPlan) setT(() => { if (this.closed) return; const line = `candidate:${c.at} 1 ${c.proto || 'udp'} 2122260223 10.0.0.${c.at % 250} ${50000 + c.at} typ ${c.type}`; this.localDescription = { type: 'answer', sdp: this.localDescription.sdp + 'a=' + line + '\r\n' }; if (this.onicecandidate) this.onicecandidate({ candidate: { candidate: line, type: c.type } }); }, c.at);
      if (world.gatherCompleteAt != null) setT(() => { if (this.closed) return; this.iceGatheringState = 'complete'; if (this.onicegatheringstatechange) this.onicegatheringstatechange(); if (this.onicecandidate) this.onicecandidate({ candidate: null }); }, world.gatherCompleteAt);
    }
    getReceivers() { return this.receivers; }
    async getStats() {
      if (world.statsFails) throw new Error('no stats');
      const s = this.s, m = new Map();
      if (!world.audioOnly) m.set('v', { id: 'v', type: 'inbound-rtp', kind: 'video', framesDecoded: s.frames, frameWidth: s.w, frameHeight: s.h, framesPerSecond: s.fps, bytesReceived: s.bytes, packetsReceived: s.packets, packetsLost: s.lost, freezeCount: 0, jitter: 0.004 });
      m.set('a', { id: 'a', type: 'inbound-rtp', kind: 'audio', audioLevel: s.audioLevel, totalAudioEnergy: 0, totalSamplesDuration: 0, bytesReceived: 0 });
      m.set('t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }); m.set('p', { id: 'p', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.012, localCandidateId: 'l', remoteCandidateId: 'r' });
      m.set('l', { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.20' }); m.set('r', { id: 'r', type: 'remote-candidate', candidateType: 'prflx', protocol: 'udp', address: '192.168.1.50' });
      return m;
    }
    close() { this.closed = true; this.connectionState = 'closed'; }
    state(st) { this.connectionState = st; if (this.onconnectionstatechange) this.onconnectionstatechange(); }
  }
  class FakeAudioContext {
    constructor() { world.actx = this; this.state = world.autoplay ? 'running' : 'suspended'; this.destination = { name: 'destination' }; this.sinkId = ''; this.nodes = []; }
    node(kind, more) { const n = { kind, to: null, connect(x) { this.to = x; return x; }, disconnect() { this.to = null; }, ...more }; this.nodes.push(n); return n; }
    createMediaStreamSource(stream) { return this.node('source', { stream }); }
    createDelay(max) { return this.node('delay', { max, delayTime: { value: 0 } }); }
    resume() { if (world.autoplay) { this.state = 'running'; return Promise.resolve(); } return new Promise(() => {}); } // without a gesture it simply never resolves
    setSinkId(id) { if (world.sinkFails) return Promise.reject(Object.assign(new Error('no'), { name: 'NotFoundError' })); this.sinkId = id; return Promise.resolve(); }
  }
  const win = world.win = {
    document: doc, navigator: nav, location: loc, history: hist, performance: { now: () => t }, crypto: globalThis.crypto, fetch,
    setTimeout: (fn, ms) => setT(fn, ms), clearTimeout: id => { timers.delete(id); }, setInterval: (fn, ms) => setT(fn, ms, ms), clearInterval: id => { timers.delete(id); },
    requestAnimationFrame: fn => { const id = ++ids; rafs.set(id, fn); return id; }, cancelAnimationFrame: id => { world.cancelled.push(id); rafs.delete(id); if (current) current.delete(id); },
    AbortController, MediaStream: class { constructor(tracks) { this.tracks = tracks; } }, RTCPeerConnection: FakePC, AudioContext: FakeAudioContext,
    innerWidth: 736, innerHeight: 1319, devicePixelRatio: 1,
    ...(storage ? { sessionStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); } } } : {}), // a tab's sessionStorage (it survives a reload)
    addEventListener(k, f) { (world.listeners[k] ||= []).push(f); }, removeEventListener(k, f) { world.listeners[k] = (world.listeners[k] || []).filter(x => x !== f); },
  };
  world.emit = k => (world.listeners[k] || []).slice().forEach(f => f({ type: k }));
  world.emitDoc = k => (world.docListeners[k] || []).slice().forEach(f => f({ type: k }));
  // ---- the engine as the receiver sees it (fx-engine.js: ready, raf, start(), frame(ts), postFX()) and the page ----
  world.fx = { ready: false, raf: undefined, frames: [], posts: 0, own: 0, frameThrows: null,
    frame(ts) { if (this.frameThrows) throw new Error(this.frameThrows); this.frames.push(ts); }, postFX() { this.posts++; },
    start() { const loop = () => { this.own++; this.raf = win.requestAnimationFrame(loop); }; loop(); } };
  world.video = el('video'); world.video.muted = true;
  world.log = m => world.logs.push(String(m)); world.qs = new URLSearchParams(u.search);
  world.find = tag => world.elements.filter(e => e.tag === tag);
  world.timersLeft = () => timers.size;
  return world;
}

const boot = (opts = {}, prep = null) => { const w = makeWorld(opts); if (prep) prep(w); w.rx = startLinkReceiver({ fx: w.fx, video: w.video, log: w.log, qs: w.qs, win: w.win }); return w; };
const engineUp = w => { w.fx.ready = true; w.fx.start(); }; // what fx/index.html does: await fx.init(); fx.start();
const A1 = '11111111-aaaa-4bbb-8ccc-000000000001', A2 = '22222222-aaaa-4bbb-8ccc-000000000002', A3 = '33333333-aaaa-4bbb-8ccc-000000000003';
const view = w => w.win.linkReceiver.state();
const feed = async (w, pc, ms, step = 100) => { for (let i = 0; i < ms; i += step) { pc.s.frames += 3; pc.s.bytes += 30000; pc.s.packets += 30; await w.advance(step); } }; // 30 frames a second arrive
const rxEl = w => w.find('video')[1], normEl = w => w.find('canvas')[0];
const connect = async (w, attempt = A1) => { // an offer, the connection comes up, a landscape 1280x720 picture arrives
  w.hub.offer(attempt); await w.advance(400);
  const pc = w.pcs.at(-1); pc.state('connecting'); pc.state('connected');
  const rx = rxEl(w); rx.readyState = 4; rx.videoWidth = 1280; rx.videoHeight = 720;
  await feed(w, pc, 1200); return pc;
};
const ready = async (opts, prep) => { const w = boot(opts, prep); engineUp(w); await w.advance(1200); return w; };

test('receiver: the key leaves the address at once, travels only as a header, and shows nowhere else', async () => {
  const w = boot({ url: 'http://127.0.0.1:8800/fx/?clean=1&src=live&program=air&takeover=1&audio=1#pk=test-only-key-123' });
  assert.equal(w.loc.hash, '', 'already gone when startLinkReceiver returns');
  assert.deepEqual(w.hist.replaced, ['/fx/?clean=1&src=live&program=air&takeover=1&audio=1']);
  assert.equal(w.doc.title, 'LINK PROGRAM', 'a window title of its own for the capture picker (clean mode)');
  await w.advance(50);
  const poll = w.hub.polls[0];
  const inst = poll.query.inst; assert.match(inst, /^[0-9a-f]{16}$/, 'a random value per load of the page');
  assert.deepEqual([poll.method, poll.origin, poll.path, poll.query, poll.headers, poll.credentials, poll.cache], ['GET', 'http://127.0.0.1:8801', '/api/link/program/poll', { program: 'air', inst, after: '0', takeover: '1' }, { 'X-Link-Program-Key': 'test-only-key-123' }, 'omit', 'no-store']);
  engineUp(w); const pc = await connect(w);
  assert.equal(view(w).state, 'connected');
  assert.deepEqual(w.hub.answers[0].headers, { 'Content-Type': 'application/json', 'X-Link-Program-Key': 'test-only-key-123' }); assert.deepEqual(w.hub.states.at(-1).headers, w.hub.answers[0].headers);
  w.emit('pagehide');
  assert.deepEqual([w.hub.answers[0].body.inst, w.hub.states.at(-1).body.inst, w.hub.polls.at(-1).query.inst], [inst, inst, inst], 'poll, answer and echo of one load name the same instance');
  assert.deepEqual(w.beacons, ['http://127.0.0.1:8801/api/link/program/bye?program=air&inst=' + inst], 'the program slot is given back at once; a beacon carries no key');
  const other = boot({ url: 'http://127.0.0.1:8800/fx/?clean=1&src=live&program=air&takeover=1' }); await other.advance(50);
  assert.notEqual(other.hub.polls[0].query.inst, inst, 'a second window with the very same address is another instance'); other.rx.stop();
  assert.equal(pc.closed, true, 'and the connection is closed, so the phone learns it now');
  const everything = JSON.stringify([view(w), w.win.linkReceiver.stats(), w.logs, w.beacons, w.calls.map(c => [c.path, c.query, c.body && { ...c.body, sdp: '' }])]);
  assert.ok(!everything.includes('test-only-key-123'), 'the key is in the header and nowhere else');
  assert.ok(!/v=0|a=candidate|typ host|192\.168\./.test(JSON.stringify([view(w), w.win.linkReceiver.stats(), w.logs])), 'no SDP, candidate or address in the log or in the view');
  assert.equal(view(w).hasKey, true); assert.deepEqual(Object.keys(w.win.linkReceiver), ['state', 'stats']);
  assert.throws(() => { w.win.linkReceiver.state = 1; }, TypeError, 'window.linkReceiver is read-only'); assert.throws(() => { w.win.linkReceiver = null; }, TypeError);
  assert.equal(startLinkReceiver({ fx: w.fx, video: w.video, log: w.log, qs: w.qs, win: w.win }), w.win.linkReceiver, 'started twice on one page: still one receiver'); assert.equal(w.find('canvas').length, 1);
  w.rx.stop();
});

test('receiver: a reload of the window still has the key (the tab keeps it), although the address lost it at the first load', async () => {
  const tab = new Map(), keyOf = w => w.hub.polls[0].headers['X-Link-Program-Key'];
  const first = boot({ url: 'http://127.0.0.1:8800/fx/?clean=1&src=live&program=air#pk=test-only-key-123', storage: tab }); await first.advance(50);
  assert.equal(first.loc.hash, ''); assert.equal(keyOf(first), 'test-only-key-123'); assert.deepEqual([...tab], [[core.KEY_STORE, 'test-only-key-123']]); first.rx.stop();
  const reloaded = boot({ url: 'http://127.0.0.1:8800/fx/?clean=1&src=live&program=air', storage: tab }); await reloaded.advance(50); // the same tab, the address as the first load left it
  assert.equal(keyOf(reloaded), 'test-only-key-123', 'the reloaded page sends the key again'); assert.equal(view(reloaded).hasKey, true); assert.deepEqual(reloaded.hist.replaced, [], 'nothing to take out of the address');
  assert.ok(!JSON.stringify([view(reloaded), reloaded.logs, reloaded.hub.states]).includes('test-only-key'), 'and still shows it nowhere'); reloaded.rx.stop();
  const fresh = boot({ url: 'http://127.0.0.1:8800/fx/?clean=1&src=live&program=air#pk=another-key-4567890', storage: tab }); await fresh.advance(50);
  assert.equal(keyOf(fresh), 'another-key-4567890', 'a key in the address wins over the remembered one'); assert.equal(tab.get(core.KEY_STORE), 'another-key-4567890'); fresh.rx.stop();
  const other = boot({ url: 'http://127.0.0.1:8800/fx/?clean=1&src=live&program=air', storage: new Map() }); await other.advance(50); // another tab: nothing to remember
  assert.equal(keyOf(other), undefined); assert.equal(view(other).hasKey, false); other.rx.stop();
  tab.set(core.KEY_STORE, 'bad key' + String.fromCharCode(10) + 'with a line break'); const odd = boot({ url: 'http://127.0.0.1:8800/fx/?src=live', storage: tab }); await odd.advance(50);
  assert.equal(keyOf(odd), undefined, 'a remembered value that could not travel as a header is not used'); odd.rx.stop();
});

test('receiver: the head start — the engine is held back until a waiting phone is connected, 4.5 s at most when nobody asks', async () => {
  const settled = w => { let done = false; w.rx.headStart.then(() => { done = true; }); return () => done; };
  // nobody asks: 4.5 s
  const quiet = boot(), q = settled(quiet);
  await quiet.advance(4490); assert.equal(q(), false); await quiet.advance(20); assert.equal(q(), true, 'after 4.5 s the engine may load'); quiet.rx.stop();
  // a phone asks (it lost its link through the reload of this page): answered at once, and the wait ends when the connection is up
  const w = boot(), d = settled(w);
  await w.advance(900); w.hub.offer(A1); await w.advance(400); assert.equal(w.hub.answers.length, 1, 'answered while the engine has not even started to load'); assert.equal(d(), false);
  w.pcs[0].state('connecting'); w.pcs[0].state('connected'); await w.advance(1); assert.equal(d(), true, 'connected: now the engine may take the page'); w.rx.stop();
  // an offer that is still being answered when the 4.5 s are over gets 2.5 s more, not for ever
  const slow = boot(), s = settled(slow);
  await slow.advance(4300); slow.hub.offer(A1); await slow.advance(400); assert.equal(s(), false, 'an attempt is in progress');
  await slow.advance(2200); assert.equal(s(), false); await slow.advance(200); assert.equal(s(), true); slow.rx.stop();
  // an attempt that ends without a connection ends the wait too
  const failed = boot(), f = settled(failed);
  await failed.advance(500); failed.hub.offer(A1); await failed.advance(400); failed.hub.deliver({ type: 'stop', attempt: A1, reason: 'client_stop' }); await failed.advance(50);
  assert.equal(f(), true); failed.rx.stop();
  const stopped = boot(), x = settled(stopped); stopped.rx.stop(); await stopped.advance(1); assert.equal(x(), true); assert.equal(stopped.timersLeft(), 0, 'no timer is left behind');
  assert.deepEqual([core.HEAD_START_MS, core.HEAD_START_EXTRA_MS], [4500, 2500]);
});

test('receiver: the hub client runs before the engine is ready; offer -> answer by the gather-done rule -> connected -> shown cover-fitted and mirrored', async () => {
  const w = boot();
  await w.advance(1500);
  assert.deepEqual([view(w).state, view(w).lease, w.hub.states.at(-1).body.state], ['loading', 'held', 'loading'], 'online for the hub while MediaPipe is still loading');
  const norm = normEl(w), rx = rxEl(w);
  assert.deepEqual([norm.width, norm.height, norm.ctxKind, norm.ctxOpts, norm.stream.fps], [720, 1280, '2d', { alpha: false }, 30]);
  assert.equal(w.video.srcObject, norm.stream, 'the engine\'s video is fed by the normaliser'); assert.equal(w.video.plays, 1);
  assert.ok(rx.muted && rx.inDom && /position:absolute/.test(rx.style.cssText) && /width:1px;height:1px/.test(rx.style.cssText) && /opacity:0/.test(rx.style.cssText) && !/display:\s*none/.test(rx.style.cssText));
  assert.equal(rx.srcObject, null, 'no stream on rx before a video track exists');

  w.hub.offer(A1); await w.advance(5);
  const pc = w.pcs[0];
  assert.deepEqual(pc.cfg, { iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  assert.deepEqual(rx.srcObject.tracks, [pc.video], 'the video track only'); assert.deepEqual(pc.receivers.map(r => r.jitterBufferTarget), [0, 0], 'jb on both receivers');
  await w.advance(250); assert.equal(w.hub.answers.length, 0, 'a host candidate was seen, but the last candidate is younger than 300 ms');
  await w.advance(100); assert.equal(w.hub.answers.length, 1);
  const ans = w.hub.answers[0].body;
  assert.deepEqual([ans.program, ans.attempt, ans.sdp, (ans.sdp.match(/a=candidate:/g) || []).length, view(w).gather], ['air', A1, pc.localDescription.sdp, 2, 'quiet'], 'pc.localDescription.sdp, with the candidates in it');
  assert.equal(w.hub.polls.at(-1).query.after, '1', 'the next poll went out at once (it never waits for the answer) and acknowledges the offer');
  assert.equal(view(w).state, 'loading', 'still loading for the hub, whatever the link does');

  engineUp(w); await w.advance(40); assert.equal(view(w).state, 'answering');
  pc.state('connecting'); pc.state('connected'); await w.advance(600);
  assert.deepEqual([view(w).state, view(w).showing], ['answering', 'slate'], 'connected, but not a frame yet');
  rx.readyState = 4; rx.videoWidth = 1280; rx.videoHeight = 720; await feed(w, pc, 1000);
  const v = view(w);
  assert.deepEqual([v.state, v.showing, v.attempt, v.lastError, v.connection, v.path], ['connected', 'webrtc', A1, null, 'connected', { local: 'host', remote: 'prflx', protocol: 'udp' }]);
  const draw = norm.ops.filter(o => o.op === 'draw').at(-1);
  assert.equal(draw.src, rx); assert.deepEqual(draw.transform, [-1, 0, 0, 1, 720, 0], 'mirrored unless mirror=0');
  assert.deepEqual(draw.a.map(n => Math.round(n * 10) / 10), [437.5, 0, 405, 720, 0, 0, 720, 1280], 'the landscape frame is centre-cropped to 9:16'); assert.deepEqual(norm.transform, [1, 0, 0, 1, 0, 0]);
  const echo = w.hub.states.at(-1).body;
  assert.deepEqual([echo.program, echo.attempt, echo.state, echo.showing, echo.hidden, echo.lastError], ['air', A1, 'connected', 'webrtc', false, null]);
  assert.deepEqual([echo.stats.w, echo.stats.h, echo.stats.fps, echo.stats.rttMs, echo.stats.vw, echo.stats.vh, echo.stats.dpr, echo.stats.pcCreated], [720, 1280, 30, 12, 736, 1319, 1, 1]);
  assert.ok(echo.stats.framesDecoded > 0 && echo.stats.kbps > 0 && JSON.stringify(echo).length < 2048); assert.deepEqual(echo.audio, { wanted: false, playing: false, level: 0, sink: null });
  const g0 = norm.grabs, d0 = norm.ops.length; await feed(w, pc, 1000);
  assert.equal(norm.grabs - g0, norm.ops.length - d0, 'every painted frame asks the capture track for a frame'); assert.ok(norm.ops.length - d0 >= 28 && norm.ops.length - d0 <= 31, 'about 30 a second: ' + (norm.ops.length - d0));
  w.rx.stop();
});

test('receiver: its loop takes the place of the engine\'s — at most a draw every 31 ms, a given error said once', async () => {
  const w = boot();
  await w.advance(500); assert.equal(w.fx.frames.length, 0, 'the engine is not driven before it has started');
  engineUp(w); assert.equal(w.fx.own, 1);
  await w.advance(2000);
  assert.equal(w.fx.own, 1, 'the engine\'s own display-rate loop never ran again'); assert.ok(w.cancelled.includes(w.fx.raf), 'cancelAnimationFrame(fx.raf)');
  const gaps = w.fx.frames.slice(1).map((ts, i) => ts - w.fx.frames[i]);
  assert.ok(Math.min(...gaps) >= 31, 'never two draws closer than 31 ms: ' + Math.min(...gaps));
  assert.ok(w.fx.frames.length >= 55 && w.fx.frames.length <= 62, '30 a second on a 60 Hz display: ' + w.fx.frames.length); assert.equal(w.fx.posts, w.fx.frames.length, 'frame() then postFX()');
  assert.ok(gaps.every(g => g > 0), 'the time handed to the engine only grows (MediaPipe needs that)');
  const s = w.win.linkReceiver.stats(); assert.ok(Math.abs(s.rafHz - 60) < 2 && Math.abs(s.drawHz - 30) < 2, `rafHz ${s.rafHz} drawHz ${s.drawHz}`);
  w.fx.start(); await w.advance(100); assert.equal(w.fx.own, 2, 'the engine loop was started again by somebody: taken over again');
  w.fx.frameThrows = 'detectForVideo exploded'; await w.advance(3000);
  assert.equal(w.logs.filter(l => l.includes('frame error detectForVideo exploded')).length, 1);
  w.fx.frameThrows = null; const n = w.fx.frames.length; await w.advance(500); assert.ok(w.fx.frames.length > n, 'and the loop goes on');
  for (let i = 0; i < 40; i++) { w.fx.frameThrows = 'ever new error ' + i; await w.advance(100); }
  assert.equal(w.logs.filter(l => l.includes('frame error ever new error')).length, 11, 'ever-new errors cannot flood the log either: 12 different lines of one kind, then silence');
  assert.ok(w.win.linkReceiver.state().log.length <= 60, 'and the receiver\'s own ring of lines is bounded');
  w.rx.stop();
});

test('receiver: fresh -> the last frame held under 3 s -> black; frames back -> shown again', async () => {
  const w = await ready(), pc = await connect(w), norm = normEl(w);
  norm.ops.length = 0; await w.advance(1400); assert.ok(norm.ops.some(o => o.op === 'draw'), 'still blitting within 1.5 s of the last rise');
  await w.advance(700); norm.ops.length = 0; await w.advance(300);
  assert.equal(norm.ops.length, 0, 'between 1.5 s and 3 s nothing is painted: the last frame stays');
  assert.deepEqual([view(w).state, view(w).showing, w.win.linkReceiver.stats().fps], ['stalled', 'webrtc', 0], 'a held picture is not "frames arriving"');
  await w.advance(1000);
  assert.deepEqual([view(w).state, view(w).showing, w.hub.states.at(-1).body.state], ['lost', 'slate', 'lost']);
  const fills = norm.ops.filter(o => o.op === 'fill'); assert.ok(fills.length >= 1 && fills.every(f => f.style === '#000' && f.a.join() === '0,0,720,1280'));
  norm.ops.length = 0; await w.advance(1000);
  assert.ok(norm.ops.length >= 3 && norm.ops.length <= 5 && norm.ops.every(o => o.op === 'fill'), 'the slate is painted again a few times a second, so the engine\'s input never dries up: ' + norm.ops.length);
  assert.ok(w.fx.frames.length > 100 && pc.closed === false, 'the engine keeps drawing (effects go on), and the connection is kept for the phone to come back on');
  await feed(w, pc, 700); assert.deepEqual([view(w).state, view(w).showing], ['connected', 'webrtc']);
  w.rx.stop();
});

test('receiver: a page that was held up for seconds (a long task) does not take that for a silent feed: no black flash, no "lost"', async () => {
  const w = await ready(), pc = await connect(w), norm = normEl(w);
  const words = () => w.hub.states.map(c => c.body.state);
  norm.ops.length = 0; const told = w.hub.states.length;
  pc.s.frames += 120; pc.s.bytes += 1200000; pc.s.packets += 1200; w.jump(4000); // 4 s without a timer or a frame, while the decoder kept working
  await w.advance(40);
  assert.deepEqual([view(w).state, view(w).showing], ['connected', 'webrtc'], 'the first draw after the hold-up still shows her');
  await w.advance(1500); await feed(w, pc, 600);
  assert.equal(norm.ops.filter(o => o.op === 'fill').length, 0, 'the picture never went black'); assert.ok(norm.ops.some(o => o.op === 'draw'));
  assert.ok(words().slice(told).every(word => word === 'connected'), 'and the hub was never told "stalled" or "lost": ' + words().slice(told).join());
  // the same hold-up, but this time the feed really stopped meanwhile: the first reading after it settles that, and the slate comes at once
  await w.advance(500); // (one more reading, so the last frames that came in are counted before the hold-up)
  norm.ops.length = 0; w.jump(4000);
  assert.equal(view(w).showing, 'webrtc', 'until the counter has been read again, what is there stays');
  await w.advance(700);
  assert.deepEqual([view(w).state, view(w).showing], ['lost', 'slate']); assert.ok(norm.ops.some(o => o.op === 'fill'));
  // a reading that fails counts as a reading without a rise (never a frozen picture for good)
  await feed(w, pc, 700); assert.equal(view(w).state, 'connected');
  w.statsFails = true; await w.advance(800); assert.equal(view(w).state, 'connected'); await w.advance(3000); assert.deepEqual([view(w).state, view(w).showing], ['lost', 'slate']);
  w.rx.stop();
});

test('receiver: stop closes at once and shows the slate; "camera away" from the phone shows it after 3 s even while packets flow', async () => {
  const w = await ready(); let pc = await connect(w); const norm = normEl(w), rx = rxEl(w);
  w.hub.deliver({ type: 'capture', attempt: A1, video: 'live', audio: 'live', visible: false });
  await feed(w, pc, 2500); assert.deepEqual([view(w).state, view(w).showing], ['connected', 'webrtc'], 'not yet');
  await feed(w, pc, 800); assert.deepEqual([view(w).state, view(w).showing, norm.ops.at(-1).op], ['stalled', 'slate', 'fill'], 'the phone said why: stalled, not lost');
  w.hub.deliver({ type: 'capture', attempt: A1, video: 'live', audio: 'live', visible: true }); await feed(w, pc, 300);
  assert.deepEqual([view(w).state, view(w).showing], ['connected', 'webrtc']);
  w.hub.deliver({ type: 'capture', attempt: A2, video: 'ended', audio: 'live', visible: true }); await feed(w, pc, 3500);
  assert.equal(view(w).state, 'connected', 'a message about another attempt changes nothing');

  w.hub.deliver({ type: 'stop', attempt: A1, reason: 'client_stop' }); await w.advance(40);
  assert.deepEqual([pc.closed, pc.ontrack, pc.onconnectionstatechange, rx.srcObject], [true, null, null, null], 'closed, and nothing of it is kept');
  assert.deepEqual([view(w).state, view(w).showing, view(w).attempt, view(w).connection, norm.ops.at(-1).op], ['idle', 'slate', null, null, 'fill'], 'black at once');
  await w.advance(300); assert.equal(w.hub.states.at(-1).body.state, 'idle', 'told to the hub at once, not at the next 5 s beat');
  const idle = w.hub.states.length; await w.advance(10000); assert.equal(w.hub.states.length - idle, 2, 'idle: an echo every 5 s');
  pc = await connect(w, A2); assert.deepEqual([view(w).state, w.win.linkReceiver.stats().pcCreated], ['connected', 2]);
  const live = w.hub.states.length; await feed(w, pc, 5000); assert.ok(w.hub.states.length - live >= 5 && w.hub.states.length - live <= 6, 'connected: an echo every second');
  // an offer that ran out ("expired") is black at once too
  norm.ops.length = 0; w.hub.deliver({ type: 'stop', attempt: A2, reason: 'expired' }); await w.advance(40);
  assert.deepEqual([pc.closed, view(w).state, view(w).showing, norm.ops.at(-1).op], [true, 'idle', 'slate', 'fill']);
  w.rx.stop();
});

test('receiver: stop(replaced) closes at once but holds her last frame: the hub sends it before the offer of every recovery swap and takeover', async () => {
  const w = await ready(), pc1 = await connect(w), norm = normEl(w), rx = rxEl(w);
  // exactly what the hub queues when it accepts a new offer for a connected link: stop(old, replaced), then the offer
  norm.ops.length = 0;
  w.hub.deliver({ type: 'stop', attempt: A1, reason: 'replaced' }); w.hub.offer(A2); await w.advance(100);
  assert.deepEqual([pc1.closed, pc1.ontrack, w.pcs.length, view(w).attempt, view(w).state], [true, null, 2, A2, 'answering'], 'the old connection is closed at once and the new offer is being answered');
  assert.equal(norm.ops.filter(o => o.op === 'fill').length, 0, 'no black frame: her last picture stays');
  assert.equal(view(w).showing, 'webrtc');
  await w.advance(400); const pc2 = w.pcs[1]; pc2.state('connected'); rx.readyState = 4; rx.videoWidth = 720; rx.videoHeight = 1280; await feed(w, pc2, 1200);
  assert.deepEqual([view(w).state, norm.ops.filter(o => o.op === 'fill').length], ['connected', 0], 'the swap never showed the slate');
  assert.ok(norm.ops.some(o => o.op === 'draw'), 'and the new picture is drawn');
  // the stop alone, with no offer behind it (the new phone never got through): black after what is left of the 3 s, not for ever
  await feed(w, pc2, 300); norm.ops.length = 0;
  w.hub.deliver({ type: 'stop', attempt: A2, reason: 'replaced' }); await w.advance(100);
  assert.deepEqual([pc2.closed, view(w).state, view(w).attempt, view(w).lastError], [true, 'idle', null, null]);
  await w.advance(2400); assert.equal(norm.ops.length, 0, 'held');
  await w.advance(700); assert.deepEqual([norm.ops.at(-1).op, view(w).showing], ['fill', 'slate'], 'never longer than 3 s after her last frame');
  await w.advance(300); assert.deepEqual([w.hub.states.at(-1).body.state, w.hub.states.at(-1).body.showing, w.hub.states.at(-1).body.stats.fps], ['idle', 'slate', 0]);
  w.rx.stop();
});

test('receiver: a new offer replaces the connection — one live connection, the older attempt never answered, her last frame held meanwhile', async () => {
  const w = await ready();
  w.hub.offer(A1); await w.advance(50); w.hub.offer(A2); await w.advance(600);
  assert.deepEqual([w.pcs.length, w.pcs[0].closed, w.pcs[1].closed, w.hub.answers.map(a => a.body.attempt)], [2, true, false, [A2]]);
  const pc2 = w.pcs[1], rx = rxEl(w), norm = normEl(w); pc2.state('connected'); rx.readyState = 4; rx.videoWidth = 720; rx.videoHeight = 1280; await feed(w, pc2, 1200);
  assert.equal(view(w).state, 'connected');
  w.hub.deliver({ type: 'stop', attempt: A2, reason: 'replaced' }); w.hub.offer(A3); await w.advance(60); // the hub's order for a connected link: stop first
  assert.deepEqual([pc2.closed, view(w).attempt, view(w).state], [true, A3, 'answering']);
  norm.ops.length = 0; await w.advance(2500); assert.equal(norm.ops.length, 0, 'no black flash while the new connection comes up');
  await w.advance(600); assert.equal(norm.ops.at(-1).op, 'fill', 'but never longer than 3 s after her last frame');
  w.hub.offer(A1); await w.advance(1000); assert.equal(w.pcs.length, 3, 'an offer that is delivered again is not answered twice');
  w.rx.stop();
});

test('receiver: not connected within 10 s of answering -> closed, lost, CONNECT_TIMEOUT; later idle', async () => {
  const w = await ready();
  w.hub.offer(A1); await w.advance(400); const pc = w.pcs[0]; assert.equal(w.hub.answers.length, 1);
  await w.advance(9500); assert.equal(pc.closed, false); await w.advance(600);
  assert.deepEqual([pc.closed, view(w).state, view(w).lastError, view(w).attempt], [true, 'lost', 'CONNECT_TIMEOUT', A1]);
  await w.advance(400); assert.deepEqual([w.hub.states.at(-1).body.state, w.hub.states.at(-1).body.lastError], ['lost', 'CONNECT_TIMEOUT']);
  await w.advance(10000); assert.deepEqual([view(w).state, view(w).attempt], ['idle', null]);
  w.rx.stop();
});

test('receiver: a stream that is too large or keeps changing size is refused; a failed connection is closed, an interrupted one is kept', async () => {
  const w = await ready(); let pc = await connect(w);
  pc.state('disconnected'); await feed(w, pc, 1000); assert.equal(pc.closed, false); pc.state('connected'); await feed(w, pc, 500); assert.equal(view(w).state, 'connected');
  pc.s.w = 1920; pc.s.h = 1080; await feed(w, pc, 600);
  assert.deepEqual([pc.closed, view(w).state, view(w).lastError, view(w).showing], [true, 'lost', 'STREAM_REJECTED', 'slate']);
  pc = await connect(w, A2); assert.deepEqual([view(w).state, view(w).lastError], ['connected', null], 'a good link clears the last error');
  for (let i = 0; i < 6; i++) { pc.s.w = i % 2 ? 720 : 540; pc.s.h = i % 2 ? 1280 : 960; await feed(w, pc, 600); }
  assert.deepEqual([pc.closed, view(w).lastError], [true, 'STREAM_REJECTED']);
  pc = await connect(w, A3); pc.state('failed'); await w.advance(60);
  assert.deepEqual([pc.closed, view(w).state, view(w).lastError, view(w).showing], [true, 'lost', 'CONNECTION_FAILED', 'slate']);
  w.rx.stop();
});

test('receiver: PROGRAM_BUSY -> ask again every 5 s, said once; PROGRAM_SUPERSEDED -> stop for good, said once', async () => {
  const w = boot({ url: 'http://127.0.0.1:8800/fx/?src=live' }, w => { w.hub.pollReply = { status: 409, body: { error: 'PROGRAM_BUSY' } }; });
  await w.advance(16000);
  assert.deepEqual(w.hub.polls.map(p => Math.round(p.at)), [0, 5000, 10000, 15000]);
  assert.equal(w.hub.polls[0].query.takeover, '0'); assert.match(w.hub.polls[0].query.program, /^p-[0-9a-f]{16}$/, 'no program= in the address: a random page id per load');
  assert.equal(w.logs.filter(l => l.includes('PROGRAM_BUSY')).length, 1);
  assert.deepEqual([view(w).lease, w.hub.states.length, w.doc.title], ['busy', 0, 'WANNA Live FX'], 'no echo from a page that does not hold the slot; the title changes in clean mode only');
  w.emit('pagehide'); assert.equal(w.beacons.length, 0, 'nothing to give back');
  w.hub.pollReply = null; await w.advance(6500);
  assert.equal(view(w).lease, 'held'); assert.ok(w.hub.states.length >= 1);
  engineUp(w); const pc = await connect(w); assert.equal(view(w).state, 'connected');
  const polls = w.hub.polls.length;
  w.hub.parked.done(410, { error: 'PROGRAM_SUPERSEDED' }); await w.advance(50);
  assert.deepEqual([pc.closed, view(w).lease, view(w).state, view(w).lastError], [true, 'superseded', 'idle', 'PROGRAM_SUPERSEDED']);
  const states = w.hub.states.length, frames = w.fx.frames.length; await w.advance(60000);
  assert.deepEqual([w.hub.polls.length, w.hub.states.length], [polls, states], 'no poll and no echo ever again');
  assert.equal(w.logs.filter(l => l.includes('PROGRAM_SUPERSEDED')).length, 1); assert.ok(w.fx.frames.length > frames + 1000, 'the picture loop itself goes on (slate, effects)');
  w.emit('pagehide'); assert.equal(w.beacons.length, 0, 'and it does not release the slot of the page that took over');
  w.rx.stop();
});

test('receiver: gateway away -> growing pauses, said once, media untouched; back as a new process -> its numbering is followed and the echo lets it adopt the link', async () => {
  const w = await ready(), pc = await connect(w);
  w.hub.deliver({ type: 'capture', attempt: A1, video: 'live', audio: 'live', visible: true }); await w.advance(50);
  assert.equal(w.hub.polls.at(-1).query.after, '2');
  const parked = w.hub.parked; w.hub.parked = null; w.hub.down = true; const diedAt = w.now(); parked.done(500, { error: 'REQUEST_FAILED' }); await w.advance(0);
  const n = w.calls.length; await feed(w, pc, 20000);
  const tries = w.calls.slice(n).filter(c => c.path.endsWith('/poll')).map(c => Math.round(c.at - diedAt));
  assert.deepEqual(tries.slice(0, 6), [500, 1500, 2500, 3500, 4500, 5500], 'a pause of 0.5 s, then 1 s each time');
  assert.equal(w.logs.filter(l => l.includes('does not answer')).length, 1);
  assert.deepEqual([pc.closed, view(w).state, view(w).lease], [false, 'connected', 'none'], 'media does not depend on the gateway');
  const echoed = w.hub.states.length, backAt = w.now();
  w.hub.down = false; w.hub.seq = 0; w.hub.queue = []; await feed(w, pc, 1300); // the new process numbers its messages from 1 again
  assert.deepEqual([w.hub.polls.at(-1).query.after, view(w).lease], ['0', 'held'], 'an old `after` must not hide the new hub\'s messages');
  // the phone gives a link that is "not mine" 3 s: poll (within 1 s) and echo (0.2 s after it) must both be there well before that
  assert.ok(w.hub.states.length > echoed, 'the echo left'); assert.ok(w.hub.states[echoed].at - backAt <= 1300, 'within 1.3 s of the gateway being back: ' + (w.hub.states[echoed].at - backAt));
  assert.ok(w.hub.polls.at(-1).at <= w.hub.states[echoed].at, 'after the poll that takes the slot');
  await feed(w, pc, 5000);
  assert.deepEqual([w.hub.states.at(-1).body.attempt, w.hub.states.at(-1).body.state], [A1, 'connected'], 'soft state: the hub can adopt the live attempt from the echo');
  w.hub.deliver({ type: 'stop', attempt: A1, reason: 'client_stop' }); await w.advance(50); assert.equal(pc.closed, true, 'seq 1 of the new hub was not skipped');
  w.rx.stop();
});

test('receiver: a hub that repeats itself, or answers empty at once, cannot make the page spin; a refused key is asked again slowly', async () => {
  const w = await ready(); w.hub.keepAcked = true; w.hub.ignoreAfter = true;
  w.hub.offer(A1); await w.advance(2000);
  assert.equal(w.pcs.length, 1, 'answered once'); const perSecond = w.hub.polls.filter(p => p.at > 2200 && p.at <= 3200).length; assert.ok(perSecond <= 5, 'repeats are paced: ' + perSecond);
  w.rx.stop();
  const z = boot({}, z => { z.hub.pollMs = 0; }); await z.advance(5000); assert.ok(z.hub.polls.length <= 11, 'an empty reply that did not wait is paced: ' + z.hub.polls.length); z.rx.stop();
  const k = boot({ url: 'http://127.0.0.1:8800/fx/?src=live' }, k => { k.hub.pollReply = { status: 403, body: { error: 'PROGRAM_KEY_REQUIRED' } }; }); await k.advance(21000);
  assert.deepEqual([k.hub.polls.length, k.logs.filter(l => l.includes('PROGRAM_KEY_REQUIRED')).length, k.hub.states.length, view(k).lease, 'X-Link-Program-Key' in k.hub.polls[0].headers], [5, 1, 0, 'none', false]); k.rx.stop();
});

test('receiver: the answer — complete wins, the 2 s cap without a host candidate, at most 40 candidates, three tries, a deadline, a final 4xx', async () => {
  let w = await ready({}, w => { w.gatherPlan = [{ at: 10, type: 'host' }]; w.gatherCompleteAt = 60; });
  w.hub.offer(A1); await w.advance(50); assert.equal(w.hub.answers.length, 0); await w.advance(30); assert.deepEqual([w.hub.answers.length, view(w).gather], [1, 'complete']); w.rx.stop();
  w = await ready({}, w => { w.gatherPlan = [{ at: 10, type: 'srflx' }, { at: 1500, type: 'srflx' }]; });
  w.hub.offer(A1); await w.advance(1950); assert.equal(w.hub.answers.length, 0); await w.advance(100); assert.deepEqual([w.hub.answers.length, view(w).gather], [1, 'cap']); w.rx.stop();
  w = await ready({}, w => { w.gatherPlan = Array.from({ length: 50 }, (_, i) => ({ at: 1 + i, type: 'host', proto: i % 2 ? 'tcp' : 'udp' })); });
  w.hub.offer(A1); await w.advance(500);
  const sent = w.hub.answers[0].body.sdp.split('\r\n').filter(l => l.startsWith('a=candidate:'));
  assert.deepEqual([sent.length, sent.filter(l => l.split(' ')[2] === 'udp').length, (w.pcs[0].localDescription.sdp.match(/a=candidate:/g) || []).length], [40, 25, 50], 'cut for the hub only; the connection keeps all of them'); w.rx.stop();
  w = await ready(); w.hub.answerReply = 'down'; w.hub.offer(A1); await w.advance(4000);
  assert.deepEqual([w.hub.answers.length, w.pcs[0].closed, view(w).state, view(w).lastError], [3, true, 'lost', 'ANSWER_FAILED']); w.rx.stop();
  w = await ready(); let n = 0; w.hub.answerReply = () => (++n < 2 ? 'down' : { status: 200, body: { ok: true, repeated: true } }); w.hub.offer(A1); await w.advance(1500);
  assert.deepEqual([w.hub.answers.length, w.pcs[0].closed, view(w).state], [2, false, 'answering'], 'the second try got through'); w.rx.stop();
  w = await ready({}, w => { w.srdMs = 1e9; }); w.hub.offer(A1); await w.advance(11900); assert.equal(w.pcs[0].closed, false); await w.advance(200);
  assert.deepEqual([w.pcs[0].closed, view(w).state, view(w).lastError, w.hub.answers.length], [true, 'lost', 'ANSWER_FAILED', 0], 'a browser call that never returns ends at the deadline'); w.rx.stop();
  for (const [status, code] of [[409, 'STALE_ATTEMPT'], [410, 'CLIENT_GONE'], [400, 'SDP_INVALID']]) {
    w = await ready(); w.hub.answerReply = { status, body: { error: code } }; w.hub.offer(A1); await w.advance(600);
    assert.deepEqual([w.hub.answers.length, w.pcs[0].closed, view(w).state, view(w).lastError], [1, true, 'lost', code], 'refused by the hub: closed at once, not asked again'); w.rx.stop();
  }
});

test('receiver: a broken offer, ICE servers, an offer without video, failing getStats, a failing blit — no crash, no SDP in the log', async () => {
  let w = await ready();
  w.hub.deliver({ type: 'offer', attempt: A1, sdp: 'not an sdp', iceServers: [] }); await w.advance(300);
  assert.deepEqual([w.pcs.length, view(w).state, view(w).lastError, view(w).attempt], [0, 'lost', 'SDP_INVALID', A1]);
  w.srdFails = true; w.hub.offer(A2); await w.advance(300);
  assert.deepEqual([w.pcs.length, w.pcs[0].closed, view(w).lastError, w.hub.answers.length], [1, true, 'SDP_INVALID', 0]);
  assert.ok(!/192\.168\.|typ host|v=0/.test(w.logs.join('\n')), 'the browser\'s error text quotes the SDP: only its name is logged'); w.rx.stop();
  w = await ready();
  w.hub.offer(A1, { iceServers: [{ urls: 'stun:stun.example.org:3478' }, { urls: 'http://evil.example/' }, { urls: ['turn:turn.example.org:3478?transport=udp'], username: 'u', credential: 'c', extra: 1 }] }); await w.advance(50);
  assert.deepEqual(w.pcs[0].cfg.iceServers, [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478?transport=udp'], username: 'u', credential: 'c' }]); w.rx.stop();
  w = await ready({}, w => { w.pcThrowsOnIce = true; }); w.hub.offer(A1, { iceServers: [{ urls: 'stun:stun.example.org:3478' }] }); await w.advance(500);
  assert.deepEqual([w.pcs.length, w.pcs[0].cfg.iceServers, w.hub.answers.length], [1, [], 1], 'a list the browser refuses: host candidates only'); w.rx.stop();
  w = await ready({}, w => { w.audioOnly = true; }); w.hub.offer(A1); await w.advance(400); w.pcs[0].state('connected'); await w.advance(1000);
  assert.deepEqual([rxEl(w).srcObject, view(w).state], [null, 'answering'], 'rx never holds a stream without a video track'); await w.advance(2500);
  assert.deepEqual([view(w).state, view(w).showing], ['lost', 'slate']); w.rx.stop();
  w = await ready({}, w => { w.statsFails = true; }); w.hub.offer(A1); await w.advance(400); w.pcs[0].state('connected'); await w.advance(4000);
  assert.deepEqual([view(w).state, view(w).showing], ['lost', 'slate'], 'no reading is no rise'); w.rx.stop();
  w = await ready(); const pc = await connect(w); w.drawThrows = true; const n = w.fx.frames.length; await feed(w, pc, 2000);
  assert.deepEqual([w.logs.filter(l => l.includes('blit failed')).length, normEl(w).transform], [1, [1, 0, 0, 1, 0, 0]], 'said once, and the mirror transform never sticks'); assert.ok(w.fx.frames.length - n > 50, 'the engine is still driven'); w.rx.stop();
});

test('receiver: gw=, program=, mirror=0 and jb= from the address; a foreign gw= is not used', async () => {
  let w = await ready({ url: 'http://localhost:18880/fx/?src=live&gw=http://localhost:18881&program=my%20air!&mirror=0&jb=120' });
  assert.deepEqual([w.hub.polls[0].origin, w.hub.polls[0].query.program, w.hub.polls[0].headers, view(w).hasKey], ['http://localhost:18881', 'myair', {}, false]);
  const pc = await connect(w);
  assert.deepEqual(normEl(w).ops.filter(o => o.op === 'draw').at(-1).transform, [1, 0, 0, 1, 0, 0]); assert.deepEqual(pc.receivers.map(r => r.jitterBufferTarget), [120, 120]); w.rx.stop();
  w = boot({ url: 'http://127.0.0.1:8810/fx/?src=live&gw=https://evil.example#pk=k1' }); await w.advance(100);
  assert.deepEqual([w.hub.polls[0].origin, w.calls.every(c => c.origin === 'http://127.0.0.1:8811'), w.logs.filter(l => l.includes('gw= ignored')).length], ['http://127.0.0.1:8811', true, 1]); w.rx.stop();
});

test('receiver: the window is covered or hidden (no animation frames) — hub client, freshness and echo keep working', async () => {
  const w = await ready(), pc = await connect(w);
  w.rafOn = false; w.doc.hidden = true; w.emitDoc('visibilitychange'); await feed(w, pc, 3000);
  const echo = w.hub.states.at(-1).body;
  assert.deepEqual([echo.state, echo.hidden, echo.stats.rafHz, echo.stats.drawHz], ['connected', true, 0, 0], 'the hub can tell a throttled program window');
  await w.advance(4000); assert.equal(w.hub.states.at(-1).body.state, 'lost', 'frames stopped: seen through getStats, with no rendering at all');
  w.rx.stop(); await w.advance(40000); assert.equal(w.timersLeft(), 0, 'stop() leaves no timer behind');
});

test('receiver: linked while the engine is still loading — loading until it is ready, then connected at once', async () => {
  const w = boot(); await w.advance(1200); const pc = await connect(w);
  assert.deepEqual([view(w).state, view(w).connection, w.hub.states.at(-1).body.state, w.hub.states.at(-1).body.attempt, w.fx.frames.length], ['loading', 'connected', 'loading', A1, 0]);
  assert.ok(normEl(w).ops.some(o => o.op === 'draw'), 'the normaliser already holds her picture');
  engineUp(w); await feed(w, pc, 800); assert.deepEqual([view(w).state, w.hub.states.at(-1).body.state], ['connected', 'connected']);
  w.rx.stop();
});

test('receiver audio: off unless audio=1; then its own element; sink= fails closed; adelay goes through a delay line', async () => {
  const devices = [{ kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers (Realtek)' }, { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers (Realtek)' }, { kind: 'audiooutput', deviceId: 'cab', label: 'CABLE Input (VB-Audio Virtual Cable)' }];
  const at = q => 'http://127.0.0.1:8800/fx/?clean=1&src=live' + q;
  let w = await ready(), pc = await connect(w); // off
  assert.equal(w.find('audio').length, 0); assert.deepEqual(view(w).audio, { wanted: false, playing: false, level: 0, sink: null, blocked: false }); w.rx.stop();

  w = await ready({ url: at('&audio=1') }); pc = await connect(w); // on, default output
  let au = w.find('audio')[0];
  assert.deepEqual([au.srcObject.tracks, au.muted, au.paused, au.sinkId, w.video.muted, rxEl(w).muted], [[pc.audio], false, false, '', true, true], 'the audio track alone, on a dedicated element; both videos stay muted');
  pc.s.audioLevel = 0.2; await feed(w, pc, 2100);
  assert.deepEqual(w.hub.states.at(-1).body.audio, { wanted: true, playing: true, level: 0.2, sink: 'default' });
  w.hub.deliver({ type: 'stop', attempt: A1, reason: 'client_stop' }); await w.advance(50);
  assert.deepEqual([au.muted, au.paused, au.srcObject], [true, true, null]); w.rx.stop();

  w = await ready({ url: at('&audio=1&sink=headphones'), devices }); // the wanted output is not there: the operator sees it before she connects
  assert.deepEqual([view(w).audio.sink, w.logs.filter(l => l.includes('no output device matches')).length], ['no_sink', 1]);
  pc = await connect(w); au = w.find('audio')[0];
  assert.deepEqual([au.muted, au.sinkId, view(w).audio], [true, '', { wanted: true, playing: false, level: 0, sink: 'no_sink', blocked: false }], 'silent: never the default speakers');
  w.devices = [...devices, { kind: 'audiooutput', deviceId: 'hp', label: 'Headphones (USB Audio)' }]; w.devListeners.forEach(f => f()); await feed(w, pc, 500); // plugged in
  assert.deepEqual([au.muted, au.sinkId, view(w).audio.sink, view(w).audio.playing], [false, 'hp', 'Headphones USB Audio', true]);
  w.devices = devices; w.devListeners.forEach(f => f()); await feed(w, pc, 500); // pulled out
  assert.deepEqual([au.muted, view(w).audio.sink, view(w).audio.playing], [true, 'no_sink', false], 'silent at once'); w.rx.stop();

  w = await ready({ url: at('&audio=1&sink=speakers'), devices }); assert.equal(view(w).audio.sink, 'Speakers Realtek'); pc = await connect(w);
  assert.equal(w.find('audio')[0].sinkId, 'spk', 'the device itself, not the "Default - …" alias'); w.rx.stop();
  w = await ready({ url: at('&audio=1&sink=cable'), devices: [{ kind: 'audiooutput', deviceId: '', label: '' }] }); pc = await connect(w); // the browser hides the names
  assert.deepEqual([w.find('audio')[0].muted, view(w).audio.sink, w.logs.filter(l => l.includes('hides the output device names')).length], [true, 'no_sink', 1]); w.rx.stop();
  w = await ready({ url: at('&audio=1&sink=cable'), devices }, w => { w.sinkFails = true; }); pc = await connect(w); // the device refuses to be selected
  assert.deepEqual([w.find('audio')[0].muted, view(w).audio.sink, view(w).audio.playing], [true, 'no_sink', false]); w.rx.stop();

  w = await ready({ url: at('&audio=1&sink=cable&adelay=120'), devices }); pc = await connect(w); // source -> delay -> destination
  au = w.find('audio')[0]; const [src, delay] = w.actx.nodes;
  assert.deepEqual([au.muted, au.paused, au.srcObject.tracks, w.actx.sinkId, src.stream === au.srcObject, src.to === delay, delay.to === w.actx.destination], [true, false, [pc.audio], 'cab', true, true, true], 'the element stays, muted: Chrome needs an element sink for remote audio');
  near(delay.delayTime.value, 0.12); assert.deepEqual(view(w).audio, { wanted: true, playing: true, level: 0, sink: 'CABLE Input VB-Audio Virtual Cable', blocked: false });
  w.hub.deliver({ type: 'stop', attempt: A1, reason: 'client_stop' }); await w.advance(50); assert.deepEqual([src.to, delay.to], [null, null]); w.rx.stop();
});

test('receiver audio: play() refused by the autoplay policy -> playing:false, nothing is drawn into the picture, the first click tries again', async () => {
  for (const extra of ['', '&adelay=80']) {
    const w = await ready({ url: 'http://127.0.0.1:8800/fx/?clean=1&src=live&audio=1' + extra, autoplay: false }), pc = await connect(w), norm = normEl(w);
    assert.deepEqual([view(w).audio.playing, view(w).audio.blocked, view(w).state, w.hub.states.at(-1).body.audio.playing], [false, true, 'connected', false], 'the picture is not held up by the sound');
    assert.ok(norm.ops.every(o => (o.op === 'draw' && o.src === rxEl(w)) || (o.op === 'fill' && o.style === '#000')), 'only her picture and the black slate are ever painted');
    assert.deepEqual([w.elements.map(e => e.tag).sort(), w.logs.filter(l => l.includes('autoplay')).length], [['audio', 'canvas', 'video', 'video'], 1], 'no prompt element is added to the page');
    w.autoplay = true; w.emit('pointerdown'); await feed(w, pc, 700);
    assert.deepEqual([view(w).audio.playing, view(w).audio.blocked, (w.listeners.pointerdown || []).length, (w.listeners.keydown || []).length], [true, false, 0, 0]);
    w.rx.stop();
  }
});
