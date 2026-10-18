import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lane, WorkerPool } from '../dist/pool.js';
const worker = new URL('./fake-worker.mjs', import.meta.url);
test('worker deadline kills hung evaluation and a replacement serves the next request', async t => {
  const lane = new Lane('solver', worker);
  t.after(() => lane.close());
  await assert.rejects(lane.request({ hang: true }, 150), /worker_timeout/);
  assert.equal((await lane.request({ value: 42 }, 2000)).value, 42);
  await assert.rejects(lane.request({ crash: true }, 2000), /worker_failure/);
  assert.equal((await lane.request({ value: 43 }, 2000)).value, 43);
});
test('queue bounds and deadlines include queue time; shutdown settles all requests', async t => {
  const lane = new Lane('WEB', worker, 1);
  t.after(() => lane.close());
  const active = lane.request({ delay: 150, value: 1 }, 2000);
  const queued = lane.request({ value: 2 }, 50);
  await assert.rejects(lane.request({ value: 3 }, 2000), /busy/);
  await assert.rejects(queued, /worker_timeout/);
  assert.equal((await active).value, 1);
  const pending = lane.request({ delay: 1000 }, 2000);
  lane.close(); await assert.rejects(pending, /shutting_down/);
});
test('identical simultaneous requests share one flight and failures are removed', async t => {
  const pool = new WorkerPool(); t.after(() => pool.close());
  let count = 0;
  pool.lanes.set('solver', { request() { count++; return new Promise(resolve => setTimeout(() => resolve({ value: count }), 10)); }, close() {} });
  const a = pool.request('solver', { jsUrl: 'same' }, 1000);
  const b = pool.request('solver', { jsUrl: 'same' }, 1000);
  assert.equal(a, b); await Promise.all([a,b]); assert.equal(count, 1);
  await pool.request('solver', { jsUrl: 'same' }, 1000); assert.equal(count, 2);
  pool.lanes.set('WEB', { request: () => Promise.reject(new Error('failed')), close() {} });
  await assert.rejects(pool.request('WEB', {}, 100)); assert.equal(pool.flights.size, 0);
  pool.close(); await assert.rejects(pool.request('solver', {}, 1000), /shutting_down/);
});

test('mint deadlines preserve HTTP 504 and recycle workers; config and remaining deadline cross IPC', async t => {
  const previous = process.env.GENERATE_IT_ENDPOINT;
  process.env.GENERATE_IT_ENDPOINT = 'youtube';
  const lane = new Lane('TVHTML5', worker);
  t.after(() => { lane.close(); if (previous === undefined) delete process.env.GENERATE_IT_ENDPOINT; else process.env.GENERATE_IT_ENDPOINT = previous; });
  const sent = Date.now();
  const before = await lane.request({ value: 'first' }, 2000);
  assert.equal(before.endpoint, 'youtube');
  assert.ok(before.deadline >= sent + 1450 && before.deadline <= Date.now() + 1500);
  await assert.rejects(lane.request({ mintDeadline: true }, 2000), error => error.code === 'mint_deadline' && error.status === 504);
  const after = await lane.request({ value: 'replacement' }, 2000);
  assert.notEqual(before.pid, after.pid);
});
