import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Cache } from './cache.js';
import { download, playerURL } from './network.js';
import { ServiceError } from './errors.js';
import { exposeTVFactory } from './tv-extractor.js';

export type Challenges = { n?: string[]; sig?: string[] };
type Player = { source: string; sts: number; prepared?: string; adapter?: string };
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../vendor/yt.solver.lib.js', import.meta.url), 'utf8'), context);
vm.runInContext('var meriyah=lib.meriyah, astring=lib.astring;', context);
vm.runInContext(readFileSync(new URL('../vendor/yt.solver.core.js', import.meta.url), 'utf8'), context);
const players = new Cache<Player>(4, 24 * 60 * 60_000);
export function timestamp(source: string): number {
  const values = [...source.matchAll(/(?:signatureTimestamp|["']STS["'])\s*:\s*(\d+)/g)].map(m => Number(m[1]));
  if (!values.length || values.some(n => !Number.isSafeInteger(n) || n <= 0 || n !== values[0])) throw new ServiceError('timestamp_missing_or_conflicting');
  return values[0]!;
}
async function player(url: string): Promise<{ entry: Player; cached: boolean }> {
  const cached = players.get(url);
  if (cached) return { entry: cached, cached: true };
  const source = await download(url);
  const entry = { source, sts: timestamp(source) };
  players.set(url, entry);
  return { entry, cached: false };
}
function evaluate(input: object): any {
  context.__input = input;
  try { return vm.runInContext('jsc(__input)', context, { timeout: 4_000 }); }
  catch { throw new ServiceError('unsupported_player'); }
  finally { delete context.__input; }
}
function prepare(source: string): string {
  const result = evaluate({ type: 'player', player: source, requests: [], output_preprocessed: true });
  if (typeof result.preprocessed_player !== 'string' || result.preprocessed_player.length > 16 * 1024 * 1024) throw new ServiceError('unsupported_player');
  return result.preprocessed_player;
}
function run(prepared: string, challenges: Challenges): Record<string, string> {
  const requests = Object.entries(challenges).map(([type, challenges]) => ({ type, challenges }));
  const result = evaluate({ type: 'preprocessed', preprocessed_player: prepared, requests });
  const solved: Record<string, string> = Object.create(null);
  if (result.type !== 'result' || result.responses?.length !== requests.length) throw new ServiceError('unsupported_player');
  result.responses.forEach((response: any, i: number) => {
    if (response.type !== 'result') throw new ServiceError('unsupported_player');
    for (const value of requests[i]!.challenges!) {
      const answer = response.data?.[value];
      if (typeof answer !== 'string' || !answer || answer === value || answer.length > 8192 || /^(?:enhanced_except_|ERR:)/.test(answer)) throw new ServiceError('challenge_failed');
      if (Object.hasOwn(solved, value) && solved[value] !== answer) throw new ServiceError('ambiguous_challenges', 400);
      solved[value] = answer;
    }
  });
  return solved;
}
export async function solve(jsUrl: string, challenges?: Challenges): Promise<object> {
  const url = playerURL(jsUrl);
  const { entry, cached } = await player(url);
  if (!challenges) return { sts: entry.sts, cache: cached ? 'hit' : 'miss' };
  if (!entry.prepared) { entry.prepared = prepare(entry.source); entry.adapter = 'ejs'; }
  let solved: Record<string, string>;
  try { solved = run(entry.prepared, challenges); }
  catch (error) {
    if (!url.includes('/tv-player-ias-tcl.vflset/') || entry.adapter === 'tv-ejs') throw error;
    const adapted = exposeTVFactory(entry.source, context.lib.meriyah, context.lib.astring);
    const prepared = prepare(adapted);
    solved = run(prepared, challenges);
    entry.prepared = prepared;
    entry.adapter = 'tv-ejs';
  }
  return { solved, adapter: entry.adapter, cache: cached ? 'hit' : 'miss' };
}
