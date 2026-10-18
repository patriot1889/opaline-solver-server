import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createApp } from '../dist/app.js';
const secret = randomBytes(32).toString('hex');
const temp = await mkdtemp(join(tmpdir(), 'opaline-proxy-'));
let proxy, server, logs = '';
const port = Number(process.env.SMOKE_PORT ?? 18443);
const appLogs = [];
function request(path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'localhost', port, path, method: body ? 'POST' : 'GET', rejectUnauthorized: false, headers: { 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.setTimeout(1000, () => req.destroy(new Error('timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
try {
  server = createApp(secret, { async request(role, payload) {
    return role === 'solver' ? payload.challenges ? { solved: { 'test-challenge': 'test-answer' } } : { sts: 20739 } : { poToken: 'test-token' };
  } }, { tvSolve: false, tvMint: false, playbackVerified: false }, e => appLogs.push(e)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  let config = await readFile(new URL('../Caddyfile', import.meta.url), 'utf8');
  config = config.replace('{', '{\n admin off\n skip_install_trust\n auto_https disable_redirects')
    .replace('solver:8080', `127.0.0.1:${server.address().port}`);
  const file = join(temp, 'Caddyfile'); await writeFile(file, config);
  proxy = spawn(process.env.CADDY_BIN ?? 'caddy', ['run', '--config', file, '--adapter', 'caddyfile'], {
    env: { ...process.env, SOLVER_DOMAIN: `localhost:${port}`, SOLVER_SECRET: secret, XDG_DATA_HOME: join(temp,'data'), XDG_CONFIG_HOME: join(temp,'config') }, stdio: ['ignore','pipe','pipe']
  });
  proxy.stdout.on('data', chunk => { logs += chunk; }); proxy.stderr.on('data', chunk => { logs += chunk; });
  let spawnError; proxy.on('error', error => { spawnError = error; });
  let started = false;
  for (let i=0;i<80;i++) {
    if (spawnError) throw spawnError;
    try { if ((await request('/')).status === 404) { started = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.ok(started, 'Caddy did not start');
  const jsUrl = '/s/player/build/base.js';
  assert.equal((await request(`/${secret}/sts`, { jsUrl })).status, 200);
  assert.equal((await request(`/${secret}/solve`, { jsUrl, n: ['test-challenge'] })).status, 200);
  assert.equal((await request(`/${secret}/get_pot`, { content_binding: 'private-binding', client: 'WEB' })).status, 200);
  for (const path of ['/wrong/sts', '/health/live', '/health/ready', `/${secret}/health/live`, `/${secret}/unknown`]) assert.equal((await request(path, { jsUrl })).status, 404);
  assert.equal((await request(`/${secret}/sts`)).status, 404);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined;
  assert.equal((await request(`/${secret}/sts`, { jsUrl })).status, 502);
  await new Promise(resolve => setTimeout(resolve,100));
  for (const value of [secret, 'private-binding', 'test-challenge', 'test-answer', 'test-token']) assert.ok(!(logs + JSON.stringify(appLogs)).includes(value), 'Sensitive value found in logs');
  console.log('HTTPS proxy smoke passed: endpoint routing, denied health routes, authentication and error-log redaction.');
} finally {
  server?.closeAllConnections(); server?.close();
  if (proxy?.pid) { proxy.kill('SIGTERM'); await once(proxy, 'exit'); }
  await rm(temp, { recursive: true, force: true });
}
