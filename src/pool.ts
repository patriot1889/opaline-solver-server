import { fork, type ChildProcess } from 'node:child_process';
import { ServiceError } from './errors.js';
type Job = { payload: object; resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; deadline: number };
export class Lane {
  private child?: ChildProcess;
  private active?: Job;
  private queue: Job[] = [];
  private closed = false;
  private completed = 0;
  constructor(private role: string, private worker = new URL('./worker.js', import.meta.url), private maxQueue = 16) {}
  request(payload: object, timeout: number): Promise<any> {
    if (this.closed) return Promise.reject(new ServiceError('shutting_down', 503));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new ServiceError('busy', 503));
    return new Promise((resolve, reject) => {
      const job: Job = { payload, resolve, reject, deadline: Date.now() + timeout, timer: setTimeout(() => {
        if (this.active === job) {
          this.active = undefined;
          this.dropChild();
        } else this.queue = this.queue.filter(item => item !== job);
        reject(new ServiceError('worker_timeout', 504));
        this.pump();
      }, timeout) };
      this.queue.push(job);
      this.pump();
    });
  }
  private dropChild(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGKILL');
  }
  private pump(): void {
    if (this.active || this.closed || !this.queue.length) return;
    if (!this.child) {
      const child = fork(this.worker, [this.role], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=384', '--disable-proto=throw'],
        // The worker must never inherit the URL secret or unrelated host credentials.
        env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '', TZ: 'UTC', GENERATE_IT_ENDPOINT: process.env.GENERATE_IT_ENDPOINT ?? 'google' }
      });
      this.child = child;
      child.on('message', (message: any) => {
        if (this.child !== child || !this.active) return;
        const job = this.active;
        this.active = undefined;
        clearTimeout(job.timer);
        if (message?.ok === true && message.result && typeof message.result === 'object') job.resolve(message.result);
        else job.reject(new ServiceError(typeof message?.code === 'string' ? message.code : 'worker_failure', [400, 502, 503, 504].includes(message?.status) ? message.status : 502));
        if (message?.code === 'mint_deadline' || ++this.completed >= 256) { this.completed = 0; this.dropChild(); }
        this.pump();
      });
      const failed = () => {
        if (this.child !== child) return;
        this.dropChild();
        if (this.active) { clearTimeout(this.active.timer); this.active.reject(new ServiceError('worker_failure')); this.active = undefined; }
        this.pump();
      };
      child.once('exit', failed);
      child.once('error', failed);
    }
    const job = this.queue.shift()!;
    const child = this.child;
    this.active = job;
    child.send({ ...job.payload, deadline: job.deadline - 500 }, error => {
      if (error && this.active === job && this.child === child) {
        this.active = undefined;
        this.dropChild();
        clearTimeout(job.timer);
        job.reject(new ServiceError('worker_failure'));
        this.pump();
      }
    });
  }
  close(): void {
    this.closed = true;
    this.dropChild();
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) {
      clearTimeout(job.timer); job.reject(new ServiceError('shutting_down', 503));
    }
    this.active = undefined;
    this.queue = [];
  }
}
export class WorkerPool {
  private lanes = new Map<string, Lane>();
  private flights = new Map<string, Promise<any>>();
  private closing = false;
  request(role: string, payload: object, timeout: number): Promise<any> {
    if (this.closing) return Promise.reject(new ServiceError('shutting_down', 503));
    const key = JSON.stringify([role, payload]);
    const existing = this.flights.get(key);
    if (existing) return existing;
    if (this.flights.size >= 32) return Promise.reject(new ServiceError('busy', 503));
    let lane = this.lanes.get(role);
    if (!lane) { lane = new Lane(role); this.lanes.set(role, lane); }
    const promise = lane.request(payload, timeout).finally(() => this.flights.delete(key));
    this.flights.set(key, promise);
    return promise;
  }
  close(): void { this.closing = true; this.lanes.forEach(lane => lane.close()); }
}
