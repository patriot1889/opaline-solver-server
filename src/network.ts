import { ServiceError } from './errors.js';
import { parseLooseJSON } from 'bgutils-js/utils';

export const TV_UA = 'Mozilla/5.0 (Linux armeabi-v7a; Android 7.1.2; Fire OS 6.0) Cobalt/22.lts.3.306369-gold (unlike Gecko) v8/8.8.278.8-jit gles Starboard/13, Amazon_ATV_mediatek8695_2019/NS6294 (Amazon, AFTMM, Wireless) com.amazon.firetv.youtube/22.3.r2.v66.0';
export const WEB_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
export const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
export function playerURL(input: unknown): string {
  if (typeof input !== 'string' || input.length > 512 || /[\\\s%?#]/.test(input)) throw new ServiceError('invalid_player_url', 400);
  let url: URL;
  try { url = new URL(input, 'https://www.youtube.com'); } catch { throw new ServiceError('invalid_player_url', 400); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.port || url.username || url.password ||
      !/^\/s\/player\/[a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.js$/.test(url.pathname)) {
    throw new ServiceError('invalid_player_url', 400);
  }
  return url.href;
}
export async function download(url: string, init: RequestInit = {}, maxBytes = 8 * 1024 * 1024): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal });
    if (!response.ok || !response.body) throw new ServiceError('upstream_http_error');
    if (Number(response.headers.get('content-length')) > maxBytes) throw new ServiceError('download_too_large');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new ServiceError('download_too_large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError((controller.signal.aborted || init.signal?.aborted) ? 'upstream_timeout' : 'upstream_unreachable');
  } finally { clearTimeout(timer); }
}
/** Read a bounded object literal without evaluating any page scripts. */
function objectAfter(html: string, marker: RegExp): string | undefined {
  const match = marker.exec(html);
  if (!match) return;
  const start = match.index + match[0].length;
  let depth = 0, quote = '', escaped = false;
  const end = Math.min(html.length, start + 2 * 1024 * 1024);
  for (let i = start; i < end; i++) {
    const c = html[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new ServiceError('page_data_incomplete');
}
export function pageConfig(html: string): Record<string, any> {
  const object = objectAfter(html, /ytcfg\.set\(\s*(?=\{)/);
  if (!object) throw new ServiceError('page_config_missing');
  try {
    const result = JSON.parse(object);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new ServiceError('page_config_invalid'); }
}
export function pageChallenge(html: string): Record<string, any> | undefined {
  const object = objectAfter(html, /window\.ytAtN\(\s*(?=\{)/);
  if (!object) return;
  try { return parseLooseJSON(object).R?.bgChallenge; } catch { throw new ServiceError('page_challenge_invalid'); }
}
export async function tvPlayer(): Promise<string> {
  const html = await download('https://www.youtube.com/tv', { headers: { 'user-agent': TV_UA } });
  const config = pageConfig(html);
  const match = html.match(/"(?:PLAYER_JS_URL|jsUrl)":"([^"\s]+\.js)"/);
  const path = config.PLAYER_JS_URL ?? match?.[1]?.replace(/\\\//g, '/');
  // jsUrl is also carried in the TV page's separate player configuration.
  if (typeof path === 'string') return playerURL(path.replace(/\/[^/]+\.vflset\/[^/]+\.js$/, '/tv-player-ias-tcl.vflset/tv-player-ias-tcl.js'));
  throw new ServiceError('tv_player_missing');
}
