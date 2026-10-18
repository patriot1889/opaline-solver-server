export class ServiceError extends Error {
  constructor(public code: string, public status = 502) { super(code); }
}
export function errorCode(error: unknown): string {
  return error instanceof ServiceError ? error.code : 'upstream_failure';
}
