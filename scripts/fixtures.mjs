import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { download } from '../dist/network.js';
const fixtures = JSON.parse(await readFile(new URL('../tests/fixtures.json', import.meta.url), 'utf8'));
await mkdir(new URL('../tests/players/', import.meta.url), { recursive: true });
for (const name of ['tv', 'web']) {
  const fixture = fixtures[name];
  const source = await download(fixture.url);
  if (createHash('sha256').update(source).digest('hex') !== fixture.sha256) throw new Error(`${name}: immutable fixture hash changed`);
  await writeFile(new URL(`../tests/players/${name}.js`, import.meta.url), source);
  console.log(`Verified ${name} fixture`);
}
