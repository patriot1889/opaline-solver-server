import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../dist/app.js';
import { ServiceError } from '../dist/errors.js';
const secret = 's'.repeat(64);
const path = '/s/player/build/tv-player-ias-tcl.vflset/tv-player-ias-tcl.js';
test('Opaline HTTP contract, authentication, bounds, errors and redaction', async t => {
  const calls = [], logs = [];
  const health = { tvSolve: false, tvMint: false, playbackVerified: false };
  const backend = { async request(role, payload, timeout) {
    calls.push({ role, payload, timeout });
    if (payload.binding === 'fail') throw new ServiceError('integrity_token_rejected');
    if (payload.challenges) return { solved: Object.fromEntries(Object.values(payload.challenges).flat().map(v => [v, `answer-${v}`])), cache: 'hit' };
    return role === 'solver' ? { sts: 12345, cache: 'miss' } : { poToken: 'private-token', cache: 'miss' };
  } };
  const server = createApp(secret, backend, health, e => logs.push(e)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function post(route, body, prefix = secret) {
    return fetch(`${base}/${prefix}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  for (const jsUrl of [path, `https://www.youtube.com${path}`]) {
    const response = await post('solve', { jsUrl, n: ['private-challenge'] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { solved: { 'private-challenge': 'answer-private-challenge' } });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls.at(-1).payload.jsUrl, `https://www.youtube.com${path}`);
    assert.equal(calls.at(-1).timeout, 7000);
  }
  assert.deepEqual(await (await post('solve', { jsUrl: path, sig: ['cipher'] })).json(), { solved: { cipher: 'answer-cipher' } });
  assert.deepEqual(await (await post('sts', { jsUrl: path })).json(), { sts: 12345 });
  assert.deepEqual(await (await post('get_pot', { content_binding: 'livingRoomId', client: 'TVHTML5', bypass_cache: true })).json(), { poToken: 'private-token' });
  assert.deepEqual(calls.at(-1), { role: 'TVHTML5', payload: { binding: 'livingRoomId', bypass: true }, timeout: 14000 });
  assert.equal((await post('get_pot', { content_binding: 'OpalineTV+1/', client: 'TVHTML5' })).status, 200);
  assert.equal(calls.at(-1).payload.binding, 'OpalineTV+1/');
  for (const client of ['WEB', 'MWEB']) assert.equal((await post('get_pot', { content_binding: 'video', client })).status, 200);
  const before = calls.length;
  for (const prefix of ['wrong', 'x'.repeat(64)]) assert.equal((await post('solve', { jsUrl: path, n: ['a'] }, prefix)).status, 404);
  for (const [route, payload] of [
    ['solve', { jsUrl: path }], ['solve', { jsUrl: path, n: [] }], ['solve', { jsUrl: path, n: [3] }],
    ['solve', { jsUrl: path, n: Array(17).fill('x') }], ['solve', { jsUrl: path, n: ['x'.repeat(4097)] }],
    ['solve', { jsUrl: path, n: ['a'], sig: ['a'] }], ['solve', { jsUrl: path, n: ['a'], surprise: true }],
    ['solve', { jsUrl: 'https://localhost/s/player/a/b.js', n: ['a'] }],
    ['sts', { jsUrl: path, n: ['a'] }], ['get_pot', { content_binding: 'x', client: 'ANDROID' }],
    ['get_pot', { content_binding: 'x', client: 'WEB', bypass_cache: 'true' }], ['get_pot', { content_binding: '', client: 'WEB' }],
    ['get_pot', { content_binding: 'x', client: 'WEB', proxy: 'http://localhost' }], ['get_pot', []]
  ]) assert.equal((await post(route, payload)).status, 400, JSON.stringify([route, payload]));
  assert.equal(calls.length, before);
  const malformed = await fetch(`${base}/${secret}/solve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400);
  const oversized = await post('solve', { n: ['x'.repeat(70000)] }); assert.equal(oversized.status, 413);
  const wrongType = await fetch(`${base}/${secret}/solve`, { method: 'POST', body: '{}' }); assert.equal(wrongType.status, 415);
  assert.equal((await fetch(`${base}/${secret}/other`)).status, 404);
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  assert.equal((await (await fetch(`${base}/health/ready`)).json()).playbackVerified, false);
  const failure = await post('get_pot', { client: 'TVHTML5', content_binding: 'fail' });
  assert.equal(failure.status, 502);
  assert.deepEqual(await failure.json(), { error: 'integrity_token_rejected' });
  assert.equal((await fetch(`${base}/health/ready`)).status, 503);
  const logText = JSON.stringify(logs);
  for (const value of [secret, 'private-token', 'private-challenge', 'livingRoomId', path]) assert.ok(!logText.includes(value));
  assert.ok(logs.every(e => e.operation && typeof e.durationMs === 'number' && e.outcome));
});
test('missing or weak secrets fail startup', () => {
  for (const value of ['', 'short', 'x'.repeat(129), '/'.repeat(64)]) assert.throws(() => createApp(value, {}, {}));
});
