import { integrityEndpoint } from './mint-budget.js';
import { createApp, type Health } from './app.js';
import { WorkerPool } from './pool.js';
import { tvPlayer } from './network.js';
import { errorCode } from './errors.js';

integrityEndpoint(); // Reject invalid endpoint configuration before accepting requests.
const pool = new WorkerPool();
const health: Health = { tvSolve: false, tvMint: false, playbackVerified: false };
const app = createApp(process.env.SOLVER_SECRET ?? '', pool, health);
const port = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const server = app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ operation: 'startup', port })));
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
let stopping = false;
async function warm() {
  if (stopping) return;
  try {
    const url = await tvPlayer();
    await pool.request('solver', { jsUrl: url, challenges: { n: ['opalinewarmup12345678'] } }, 30_000);
    health.tvSolve = true;
    console.log(JSON.stringify({ operation: 'warmup_solve', outcome: 'ok' }));
  } catch (error) { health.tvSolve = false; console.log(JSON.stringify({ operation: 'warmup_solve', outcome: errorCode(error) })); }
  if (stopping) return;
  try {
    await pool.request('TVHTML5', { binding: 'OpalineTV+1/', bypass: false }, 30_000);
    health.tvMint = true;
    console.log(JSON.stringify({ operation: 'warmup_mint', outcome: 'ok' }));
  } catch (error) { health.tvMint = false; console.log(JSON.stringify({ operation: 'warmup_mint', outcome: errorCode(error) })); }
}
if (process.env.WARMUP !== 'false') void warm();
const timer = setInterval(() => { if (process.env.WARMUP !== 'false') void warm(); }, 15 * 60_000);
timer.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  stopping = true; clearInterval(timer); pool.close(); server.close(); server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); }, 1000).unref();
});
