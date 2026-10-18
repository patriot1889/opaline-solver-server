import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { solve, timestamp } from '../dist/solver.js';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
test('immutable TV/web n and signature vectors, prepared cache and timestamp consistency', async t => {
  const original = globalThis.fetch;
  const calls = [];
  const sources = Object.fromEntries(['tv','web'].map(name => {
    const source = readFileSync(new URL(`./players/${name}.js`, import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), fixtures[name].sha256);
    return [fixtures[name].url, source];
  }));
  globalThis.fetch = async url => { calls.push(url); return new Response(sources[url]); };
  t.after(() => { globalThis.fetch = original; });
  for (const name of ['tv','web']) {
    const fixture = fixtures[name];
    assert.equal(timestamp(sources[fixture.url]), fixture.sts);
    const challenges = { n: Object.keys(fixture.n), ...(fixture.sig ? { sig: Object.keys(fixture.sig) } : {}) };
    const first = await solve(fixture.url, challenges);
    assert.deepEqual({ ...first.solved }, { ...fixture.n, ...fixture.sig });
    assert.equal(first.adapter, name === 'tv' ? 'tv-ejs' : 'ejs');
    assert.deepEqual((await solve(new URL(fixture.url).pathname, challenges)).solved, first.solved);
    assert.equal((await solve(fixture.url)).sts, fixture.sts);
  }
  assert.equal(calls.length, 2);
  const rotatedURL = fixtures.tv.url.replace('/0229cd64/', '/nextbuild/');
  globalThis.fetch = async () => new Response(sources[fixtures.tv.url].replaceAll('signatureTimestamp:20739001', 'signatureTimestamp:20739002'));
  assert.equal((await solve(rotatedURL)).sts, 20739002);
  globalThis.fetch = async () => new Response('not a supported player');
  await assert.rejects(solve(rotatedURL.replace('nextbuild','unsupported'), { n: ['x'] }));
});
