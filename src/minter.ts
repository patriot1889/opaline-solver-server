import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders } from 'bgutils-js/utils';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import { Cache } from './cache.js';
import { download, pageConfig, pageChallenge, TV_UA, WEB_UA, MOBILE_UA } from './network.js';
import { ServiceError } from './errors.js';
import { MintBudget, integrityEndpoint, type IntegrityEndpoint } from './mint-budget.js';

export type Client = 'TVHTML5' | 'WEB' | 'MWEB';
export type MintState = {
  value: { mintAsWebsafeString(binding: string): Promise<string> };
  expires: number;
  close(): Promise<void>;
};
export type MintFactory = (client: Client, endpoint: IntegrityEndpoint, budget: MintBudget) => Promise<MintState>;
const retryable = new Set([
  'upstream_http_error', 'upstream_unreachable', 'upstream_timeout',
  'botguard_challenge_missing', 'botguard_initialization_failed', 'botguard_snapshot_failed',
  'botguard_minter_missing', 'integrity_token_rejected', 'token_mint_failed'
]);

export const createMinter: MintFactory = async (client, endpoint, budget) => {
  const isTV = client === 'TVHTML5';
  const base = isTV ? 'https://www.youtube.com/tv' : client === 'MWEB' ? 'https://m.youtube.com/' : 'https://www.youtube.com/';
  const ua = isTV ? TV_UA : client === 'MWEB' ? MOBILE_UA : WEB_UA;
  const fetchText = (url: string, init: RequestInit = {}, limit?: number) =>
    budget.run(() => download(url, { ...init, signal: budget.signal }, limit));
  const html = await fetchText(base, { headers: { 'user-agent': ua } });
  const config = pageConfig(html);
  const supplied = config.INNERTUBE_CONTEXT;
  if (!supplied?.client || supplied.client.clientName !== client) throw new ServiceError('client_context_mismatch');
  if (typeof config.EVENT_ID !== 'string' || !config.EVENT_ID.trim()) throw new ServiceError('page_event_id_missing');
  let challenge = pageChallenge(html);
  // WEB/MWEB require the challenge paired with this exact page's EVENT_ID.
  // TV pages may omit it; retain their client-specific att/get flow.
  if (!challenge && isTV) {
    let attestation: any;
    try {
      attestation = JSON.parse(await fetchText('https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false', {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua, origin: 'https://www.youtube.com', referer: base },
        body: JSON.stringify({ context: supplied, engagementType: 'ENGAGEMENT_TYPE_UNBOUND' })
      }, 2 * 1024 * 1024));
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('botguard_challenge_missing');
    }
    challenge = attestation?.bgChallenge;
  }
  if (typeof challenge?.program !== 'string' || !challenge.program || typeof challenge.globalName !== 'string' || !challenge.globalName)
    throw new ServiceError('botguard_challenge_missing');
  const interpreterPath = challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  if (typeof interpreterPath !== 'string' || !interpreterPath) throw new ServiceError('untrusted_interpreter');
  let interpreter: URL;
  try { interpreter = new URL(interpreterPath, base); } catch { throw new ServiceError('untrusted_interpreter'); }
  if (interpreter.protocol !== 'https:' || interpreter.username || interpreter.password || interpreter.port ||
      !['www.google.com', 'www.gstatic.com', 'www.youtube.com'].includes(interpreter.hostname)) throw new ServiceError('untrusted_interpreter');

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url: base, referrer: base });
  Object.defineProperty(dom.window.navigator, 'userAgent', { value: ua, configurable: true });
  for (const key of ['window', 'document', 'navigator', 'location', 'origin'] as const)
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
  (globalThis as any).yt = { config_: config };
  (dom.window as any).yt = (globalThis as any).yt;
  let bg: BotGuardClient | undefined;
  const close = async () => {
    if (bg) { try { await bg.shutdown(250); } catch {} }
    dom.window.close();
    Reflect.deleteProperty(globalThis, challenge!.globalName);
  };
  try {
    const script = await fetchText(interpreter.href);
    budget.check();
    try {
      vm.runInThisContext(script, { timeout: Math.max(1, Math.min(3_000, budget.remaining)) });
      bg = await budget.run(() => BotGuardClient.create({ program: challenge!.program, globalName: challenge!.globalName, globalObject: globalThis }));
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('botguard_initialization_failed');
    }
    const signals: WebPoSignalOutput = [];
    let snapshot: string;
    try { snapshot = await budget.run(() => bg!.snapshot({ webPoSignalOutput: signals }, Math.max(1, Math.min(3_000, budget.remaining)))); }
    catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('botguard_snapshot_failed');
    }
    if (typeof signals[0] !== 'function') throw new ServiceError('botguard_minter_missing');
    const raw = await fetchText(buildURL('GenerateIT', endpoint === 'youtube'), {
      method: 'POST', headers: { ...getHeaders(), 'user-agent': ua }, body: JSON.stringify(['O43z0dpjhgX20SCx4KAo', snapshot])
    }, 1024 * 1024);
    let response: any;
    try { response = JSON.parse(raw); } catch { throw new ServiceError('integrity_token_rejected'); }
    if (!Array.isArray(response)) throw new ServiceError('integrity_token_rejected');
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = response;
    if (typeof integrityToken !== 'string' || !integrityToken || !Number.isFinite(estimatedTtlSecs) || estimatedTtlSecs <= 0)
      throw new ServiceError('integrity_token_rejected');
    let value: WebPoMinter;
    try { value = await budget.run(() => WebPoMinter.create({ integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken }, signals)); }
    catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('integrity_token_rejected');
    }
    return { value, expires: Date.now() + Math.min(estimatedTtlSecs * 800, 25 * 60_000), close };
  } catch (error) {
    await close();
    throw error;
  }
};

export class TokenMinter {
  private minter?: MintState;
  private tokens = new Cache<string>(256, 25 * 60_000);
  constructor(private client: Client, private endpoint: IntegrityEndpoint = integrityEndpoint(), private factory: MintFactory = createMinter) {}
  private async dispose(): Promise<void> {
    const previous = this.minter;
    this.minter = undefined;
    this.tokens.clear();
    if (previous) await previous.close();
  }
  async mint(binding: string, bypass: boolean, deadline?: number): Promise<object> {
    if (!bypass) {
      const cached = this.tokens.get(binding);
      if (cached && this.minter && this.minter.expires > Date.now()) return { poToken: cached, cache: 'hit' };
    }
    const budget = new MintBudget(deadline);
    let endpoint = this.endpoint;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          budget.check();
          if (bypass || attempt > 0 || !this.minter || this.minter.expires <= Date.now()) {
            await this.dispose();
            budget.check();
            this.minter = await this.factory(this.client, endpoint, budget);
          }
          let poToken: string;
          try { poToken = await budget.run(() => this.minter!.value.mintAsWebsafeString(binding)); }
          catch (error) {
            if (error instanceof ServiceError) throw error;
            throw new ServiceError('token_mint_failed');
          }
          if (!poToken || !/^[A-Za-z0-9_-]+={0,2}$/.test(poToken)) throw new ServiceError('token_mint_failed');
          this.tokens.set(binding, poToken, Math.min(25 * 60_000, this.minter.expires - Date.now()));
          return { poToken, cache: 'miss' };
        } catch (error) {
          await this.dispose();
          budget.check();
          if (attempt > 0 || !(error instanceof ServiceError) || !retryable.has(error.code) || budget.remaining < 1500) throw error;
          // Route changes never reuse an interpreter, snapshot or integrity token.
          if (['integrity_token_rejected', 'upstream_http_error', 'upstream_unreachable', 'upstream_timeout'].includes(error.code))
            endpoint = endpoint === 'google' ? 'youtube' : 'google';
        }
      }
      throw new ServiceError('token_mint_failed');
    } finally { budget.close(); }
  }
}
