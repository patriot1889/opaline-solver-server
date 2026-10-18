import { WorkerPool } from '../dist/pool.js';
import { tvPlayer } from '../dist/network.js';
const pool = new WorkerPool();
let failed = false;
async function check(label, role, payload, timeout) {
  const start = performance.now();
  try {
    const result = await pool.request(role, payload, timeout);
    console.log(JSON.stringify({ probe: label, outcome: 'ok', durationMs: Math.round(performance.now() - start), cache: result.cache, adapter: result.adapter, tokenLength: result.poToken?.length }));
  } catch (error) { failed = true; console.log(JSON.stringify({ probe: label, outcome: error.message, durationMs: Math.round(performance.now() - start) })); }
}
try {
  const jsUrl = process.env.PLAYER_URL ?? await tvPlayer();
  for (const label of ['cold', 'warm']) {
    await check(`${label}_tv_sts`, 'solver', { jsUrl }, 7000);
    await check(`${label}_tv_n`, 'solver', { jsUrl, challenges: { n: ['opalinewarmup12345678'] } }, 7000);
    await check(`${label}_tv_pot`, 'TVHTML5', { binding: 'OpalineTV+1/', bypass: false }, 14000);
    await check(`${label}_web_pot`, 'WEB', { binding: 'dQw4w9WgXcQ', bypass: false }, 14000);
    await check(`${label}_mweb_pot`, 'MWEB', { binding: 'dQw4w9WgXcQ', bypass: false }, 14000);
  }
  await check('bypass_tv_pot', 'TVHTML5', { binding: 'OpalineTV+1/', bypass: true }, 14000);
} catch (error) { failed = true; console.log(JSON.stringify({ probe: 'discovery', outcome: error.message })); }
finally { pool.close(); }
console.log('These probes do not verify CDN acceptance or signed-in playback.');
if (failed) process.exitCode = 1;
