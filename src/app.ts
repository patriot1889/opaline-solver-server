import express, { type ErrorRequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ServiceError, errorCode } from './errors.js';
import { playerURL } from './network.js';
import type { Client } from './minter.js';

export type Backend = { request(role: string, payload: object, timeout: number): Promise<any> };
export type Health = { tvSolve: boolean; tvMint: boolean; playbackVerified: false };
type Log = (event: Record<string, unknown>) => void;
function bodyObject(body: any): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError('invalid_request', 400);
  return body;
}
function keys(body: Record<string, any>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ServiceError('unknown_field', 400);
}
export function createApp(secret: string, backend: Backend, health: Health, log: Log = event => console.log(JSON.stringify(event))) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new Error('SOLVER_SECRET must contain 32–128 URL-safe characters');
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/health/live', (_req, res) => { res.json({ live: true }); });
  app.get('/health/ready', (_req, res) => { const ready = health.tvSolve && health.tvMint; res.status(ready ? 200 : 503).json({ ready, ...health }); });
  const expected = Buffer.from(secret);
  app.use((req, res, next) => {
    const slash = req.url.indexOf('/', 1);
    const prefix = req.url.slice(1, slash < 0 ? undefined : slash);
    const candidate = Buffer.from(prefix);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) { res.status(404).json({ error: 'not_found' }); return; }
    req.url = slash < 0 ? '/' : req.url.slice(slash);
    next();
  });
  // One bounded bucket for a personal instance; no growing per-address map.
  let tokens = 120, refill = Date.now();
  app.use((_req, res, next) => {
    const now = Date.now(); tokens = Math.min(120, tokens + (now - refill) / 500); refill = now;
    if (tokens < 1) { res.setHeader('Retry-After', '1'); res.status(429).json({ error: 'rate_limited' }); return; }
    tokens--; next();
  });
  app.use((req, _res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) throw new ServiceError('json_required', 415);
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));
  app.post(['/solve', '/sts', '/get_pot'], async (req, res) => {
    const operation = req.path.slice(1);
    const start = performance.now();
    let build: string | undefined;
    let outcome = 'ok', cache: unknown, tvSolveAttempt = false, tvMintAttempt = false;
    try {
      const body = bodyObject(req.body);
      let result: any;
      if (operation === 'get_pot') {
        keys(body, ['content_binding', 'client', 'bypass_cache']);
        const client = body.client as Client;
        if (!['TVHTML5', 'WEB', 'MWEB'].includes(client)) throw new ServiceError('unsupported_client', 400);
        // Opaline's livingRoomPoTokenId uses standard base64, including + and /.
        if (typeof body.content_binding !== 'string' || !/^[A-Za-z0-9_+/-]{1,254}={0,2}$/.test(body.content_binding)) throw new ServiceError('invalid_binding', 400);
        if (body.bypass_cache !== undefined && typeof body.bypass_cache !== 'boolean') throw new ServiceError('invalid_bypass_cache', 400);
        tvMintAttempt = client === 'TVHTML5';
        result = await backend.request(client, { binding: body.content_binding, bypass: body.bypass_cache === true }, 14_000);
        if (client === 'TVHTML5') health.tvMint = true;
        res.json({ poToken: result.poToken });
      } else {
        keys(body, operation === 'solve' ? ['jsUrl', 'n', 'sig'] : ['jsUrl']);
        const jsUrl = playerURL(body.jsUrl);
        build = new URL(jsUrl).pathname.split('/')[3];
        const payload: { jsUrl: string; challenges?: { n?: string[]; sig?: string[] } } = { jsUrl };
        if (operation === 'solve') {
          const challenges: { n?: string[]; sig?: string[] } = {};
          let count = 0;
          for (const kind of ['n', 'sig'] as const) if (body[kind] !== undefined) {
            const values = body[kind];
            if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v.length || v.length > 4096)) throw new ServiceError('invalid_challenges', 400);
            count += values.length;
            challenges[kind] = [...new Set<string>(values)].sort();
          }
          if (!count || count > 16) throw new ServiceError('invalid_challenges', 400);
          if (challenges.n && challenges.sig && challenges.n.some(v => challenges.sig!.includes(v))) throw new ServiceError('ambiguous_challenges', 400);
          payload.challenges = challenges;
        }
        tvSolveAttempt = operation === 'solve' && jsUrl.includes('/tv-player-ias-tcl.vflset/') && !!payload.challenges?.n;
        result = await backend.request('solver', payload, 7_000);
        if (operation === 'solve' && jsUrl.includes('/tv-player-ias-tcl.vflset/') && payload.challenges?.n) health.tvSolve = true;
        res.json(operation === 'sts' ? { sts: result.sts } : { solved: result.solved });
      }
      cache = result.cache;
    } catch (error) {
      outcome = errorCode(error);
      if (tvMintAttempt) health.tvMint = false;
      if (tvSolveAttempt) health.tvSolve = false;
      res.status(error instanceof ServiceError ? error.status : 502).json({ error: outcome });
    } finally {
      log({ operation, ...(build ? { playerBuild: build } : {}), durationMs: Math.round(performance.now() - start), ...(cache ? { cache } : {}), outcome });
    }
  });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof ServiceError ? error.status : error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: error instanceof ServiceError ? error.code : status === 413 ? 'body_too_large' : status === 400 ? 'invalid_json' : 'internal_error' });
  };
  app.use(onError);
  return app;
}
