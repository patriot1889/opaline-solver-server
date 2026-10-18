import { ServiceError, errorCode } from './errors.js';
import type { Client } from './minter.js';
const role = process.argv[2];
// Solver workers do not load browser emulation; token workers own exactly one client.
const service = role === 'solver' ? await import('./solver.js') : undefined;
const minter = role !== 'solver' ? new (await import('./minter.js')).TokenMinter(role as Client) : undefined;
process.on('message', async (message: any) => {
  try {
    const result = service ? await service.solve(message.jsUrl, message.challenges) : await minter!.mint(message.binding, message.bypass, message.deadline);
    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({ ok: false, code: errorCode(error), status: error instanceof ServiceError ? error.status : 502 });
  }
});
