import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Cache } from '../dist/cache.js';
import { playerURL, download, pageConfig, pageChallenge } from '../dist/network.js';
import { timestamp } from '../dist/solver.js';
import { exposeTVFactory } from '../dist/tv-extractor.js';
import { TokenMinter } from '../dist/minter.js';

test('only canonical HTTPS YouTube player URLs are fetched', () => {
  const path = '/s/player/abc/tv-player-ias-tcl.vflset/tv-player-ias-tcl.js';
  assert.equal(playerURL(path), `https://www.youtube.com${path}`);
  for (const value of [null, {}, '//evil.test/s/player/a/b.js', 'http://www.youtube.com/s/player/a/b.js',
    'https://www.youtube.com.evil.test/s/player/a/b.js', 'https://user:pass@www.youtube.com/s/player/a/b.js',
    'https://www.youtube.com:444/s/player/a/b.js', '/s/player/a/b.js?foo=x', '/s/player/a/%62.js', '/s/player/a/b.js#n', '/watch?v=x', '/s/player/a/b\\c.js']) assert.throws(() => playerURL(value));
});
test('download limits, upstream errors and redirects', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response('ok'); };
  assert.equal(await download('https://example.test'), 'ok');
  globalThis.fetch = async () => new Response('bad', { status: 403 });
  await assert.rejects(download('https://example.test'), /upstream_http_error/);
  globalThis.fetch = async () => new Response('x'.repeat(100));
  await assert.rejects(download('https://example.test', {}, 16), /download_too_large/);
  globalThis.fetch = async () => { throw new Error('secret upstream URL'); };
  await assert.rejects(download('https://example.test'), e => e.message === 'upstream_unreachable');
});
test('JSON page extraction handles braces inside strings without evaluating scripts', () => {
  const config = { client: { value: 'a}b\\"c' }, array: [1, 2] };
  assert.deepEqual(pageConfig(`script;ytcfg.set(${JSON.stringify(config)});evil()`), config);
  assert.throws(() => pageConfig('ytcfg.set({bad})'));
  assert.deepEqual(pageChallenge(`window.ytAtN({'R':{'bgChallenge':{"program":"a})b","globalName":"safe"}}})`), { program: 'a})b', globalName: 'safe' });
  assert.deepEqual(pageChallenge(String.raw`window.ytAtN({'R':'\x7b\x22bgChallenge\x22:\x7b\x22program\x22:\x22mobile\x22\x7d\x7d'})`), { program: 'mobile' });
  assert.throws(() => pageChallenge('window.ytAtN({R:evil()})'), /page_challenge_invalid/);
});
test('timestamps stay tied to exact player contents and reject conflicts', () => {
  assert.equal(timestamp('x={signatureTimestamp:100};y={signatureTimestamp:100}'), 100);
  assert.equal(timestamp('{"STS":101}'), 101);
  assert.throws(() => timestamp('signatureTimestamp:100,signatureTimestamp:101'));
  assert.throws(() => timestamp('no timestamp'));
});
test('cache is bounded, expires and evicts least recently used entries', async () => {
  const cache = new Cache(2, 10000);
  cache.set('a', 1); cache.set('b', 2); assert.equal(cache.get('a'), 1); cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  cache.set('old', 4, -1); assert.equal(cache.get('old'), undefined);
  cache.delete('c'); assert.equal(cache.get('c'), undefined);
});
test('TV extractor discovers renamed dispatchers and rejects unproven factories', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../vendor/yt.solver.lib.js', import.meta.url), 'utf8'), context);
  const source = `(function(){var table='set|alr|yes'.split('|'), dispatcher=function(a,b,url,key,sig){var k=a^b,result; if(a===7){result=new Factory(url);result[table[k^99]](table[k^98],table[k^97]);}return result;};var call=dispatcher(7,100,'url');}).call(this);`;
  const transformed = exposeTVFactory(source, context.lib.meriyah, context.lib.astring);
  assert.match(transformed, /dispatcher\(7, 100, url, key, sig\)/);
  assert.match(transformed, /result\.set\("alr", "yes"\)/);
  assert.throws(() => exposeTVFactory(source.replace('dispatcher(7,100', 'dispatcher(7,101'), context.lib.meriyah, context.lib.astring), /unsupported_tv_player/);
});
test('token cache separates client and binding and bypass replaces integrity state', async () => {
  let generation = 0;
  function fake(client) {
    return new TokenMinter(client, 'google', async () => {
      const id = ++generation;
      return { expires: Date.now() + 60_000, close: async () => {}, value: { async mintAsWebsafeString(binding) { return `${client}_${binding}_${id}`; } } };
    });
  }
  const tv = fake('TVHTML5'), web = fake('WEB');
  const first = await tv.mint('same', false);
  assert.equal((await tv.mint('same', false)).cache, 'hit');
  assert.notEqual((await web.mint('same', false)).poToken, first.poToken);
  assert.notEqual((await tv.mint('other', false)).poToken, first.poToken);
  const refreshed = await tv.mint('same', true);
  assert.notEqual(refreshed.poToken, first.poToken);
  assert.equal((await tv.mint('same', false)).poToken, refreshed.poToken);
  tv.minter.expires = 0;
  assert.notEqual((await tv.mint('same', false)).poToken, refreshed.poToken);
});
