import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStageUrl, stageUrlFor, programUrlWithStage, stageGate, STAGE_TIMEOUT_MS } from '../fx/stage-url.js';

// a gate with a hand-driven clock: fire() runs the timeout, and we see whether it was cleared
function gateUnderTest(opts = {}) {
  const calls = { open: 0, close: [] }; let pending = null, cleared = 0;
  const gate = stageGate({ onOpen: () => calls.open++, onClose: why => calls.close.push(why), setTimer: fn => { pending = fn; return 'timer'; }, clearTimer: id => { if (id === 'timer') cleared++; }, ...opts });
  return { gate, calls, fire: () => pending?.(), get cleared() { return cleared; } };
}

test('the gate opens only when the iframe loaded AND the host answered the probe', () => {
  const a = gateUnderTest(); a.gate.loaded(); assert.deepEqual([a.calls.open, a.calls.close], [0, []], 'an iframe "load" alone is not enough (the browser loads its own error page too)');
  a.gate.reachable(); assert.deepEqual([a.calls.open, a.calls.close, a.cleared, a.gate.settled], [1, [], 1, true]);
  a.gate.loaded(); a.gate.reachable(); a.gate.failed('late'); a.fire(); assert.deepEqual([a.calls.open, a.calls.close], [1, []], 'one call, ever');
  const b = gateUnderTest(); b.gate.reachable(); b.gate.loaded(); assert.equal(b.calls.open, 1, 'in either order');
});

test('the gate closes for good on a failed probe, an iframe error, or when the time is up', () => {
  const a = gateUnderTest(); a.gate.loaded(); a.gate.failed('unreachable: Failed to fetch'); assert.deepEqual([a.calls.open, a.calls.close, a.cleared], [0, ['unreachable: Failed to fetch'], 1]);
  a.gate.reachable(); assert.equal(a.calls.open, 0, 'a late success does not reopen it');
  const b = gateUnderTest(); b.gate.failed(); assert.deepEqual(b.calls.close, ['error']);
  const c = gateUnderTest(); c.gate.reachable(); c.fire(); assert.deepEqual([c.calls.close, c.gate.settled], [['timeout'], true]); c.gate.loaded(); assert.equal(c.calls.open, 0, 'the iframe arriving after the timeout changes nothing');
});

const WALL = 'https://vardy-verse-connect.lovable.app/stage?creator=NAME&t=TOKEN';

test('a stage address is https, or http on this computer only', () => {
  assert.equal(parseStageUrl(WALL), WALL);
  assert.equal(parseStageUrl('  ' + WALL + '  '), WALL, 'spaces around it are ignored');
  assert.equal(parseStageUrl('http://127.0.0.1:8800/public/wall.html'), 'http://127.0.0.1:8800/public/wall.html');
  assert.equal(parseStageUrl('http://localhost:8800/x'), 'http://localhost:8800/x');
  assert.equal(parseStageUrl('http://[::1]:8800/x'), 'http://[::1]:8800/x');
  assert.equal(parseStageUrl('http://studio.lan:8800/x', 'studio.lan'), 'http://studio.lan:8800/x', 'http on the page\'s own host (tests)');
  for (const bad of ['http://example.com/wall', 'javascript:alert(1)', 'data:text/html,hi', 'wall', '', '   ', null, undefined, 42, 'ftp://x/y', '//example.com/wall'])
    assert.equal(parseStageUrl(bad, 'studio.lan'), null, `rejected: ${String(bad)}`);
});

test('the program reads ?stage= only in clean mode, and an inner & written as %26 comes back whole', () => {
  const search = '?clean=1&src=camera&stage=https://vardy-verse-connect.lovable.app/stage?creator=tohar.bell%26t=abc123';
  assert.equal(stageUrlFor(search), 'https://vardy-verse-connect.lovable.app/stage?creator=tohar.bell&t=abc123');
  assert.equal(stageUrlFor('?clean=1&src=phone&stage=' + encodeURIComponent(WALL)), WALL, 'a fully encoded address works too');
  assert.equal(stageUrlFor('?src=camera&stage=' + encodeURIComponent(WALL)), null, 'the operator panel (no clean=1) never frames a stage');
  assert.equal(stageUrlFor('?clean=1&src=phone'), null, 'no stage -> the program as before');
  assert.equal(stageUrlFor('?clean=1&stage=http://example.com/wall'), null, 'a plain-http site is not framed');
  assert.equal(stageUrlFor(''), null); assert.equal(stageUrlFor(undefined), null);
});

test('the Studio link with a stage keeps the wall\'s own query intact through our query', () => {
  const link = programUrlWithStage(WALL, { src: 'phone', streamer: 'noa' });
  assert.equal(link, '/clean/program?src=phone&streamer=noa&stage=' + encodeURIComponent(WALL));
  assert.equal(stageUrlFor(link.replace('/clean/program?', '?clean=1&')), WALL, 'the redirect /clean/program -> /fx/?clean=1&… hands it back whole');
  assert.equal(programUrlWithStage(WALL), '/clean/program?src=phone&stage=' + encodeURIComponent(WALL));
  assert.ok(STAGE_TIMEOUT_MS >= 5000 && STAGE_TIMEOUT_MS <= 60000, 'the iframe gets a sane time to load before the program goes on without it');
});
