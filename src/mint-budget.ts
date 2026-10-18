import { ServiceError } from './errors.js';

export type IntegrityEndpoint = 'google' | 'youtube';
export function integrityEndpoint(value = process.env.GENERATE_IT_ENDPOINT ?? 'google'): IntegrityEndpoint {
  if (value !== 'google' && value !== 'youtube') throw new Error('GENERATE_IT_ENDPOINT must be google or youtube');
  return value;
}

/** One budget covers both attempts, cleanup and all upstream requests. */
export class MintBudget {
  private controller = new AbortController();
  private timer: NodeJS.Timeout;
  readonly deadline: number;
  constructor(deadline = Date.now() + 12_500) {
    this.deadline = Math.min(deadline, Date.now() + 12_500);
    this.timer = setTimeout(() => this.controller.abort(), Math.max(1, this.remaining));
  }
  get remaining(): number { return this.deadline - Date.now(); }
  get signal(): AbortSignal { return this.controller.signal; }
  check(): void {
    if (this.remaining <= 0 || this.signal.aborted) throw new ServiceError('mint_deadline', 504);
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let onAbort: () => void = () => {};
    const timeout = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ServiceError('mint_deadline', 504));
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([operation(), timeout]); }
    finally { this.signal.removeEventListener('abort', onAbort); }
  }
  close(): void { clearTimeout(this.timer); }
}
