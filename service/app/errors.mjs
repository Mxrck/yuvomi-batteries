// Domain refusals. `code` is the HTTP status and `reason` the machine string, the same pair
// Yuvomi uses ({error, code, reason}); server.mjs serialises them as they are.

export class DomainError extends Error {
  constructor(code, reason, message = reason, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.reason = reason;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    const body = { error: this.message, code: this.code, reason: this.reason };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

const STATUS = {
  invalid_input: 400,
  pool_not_found: 404,
  place_not_found: 404,
  stock_exceeded: 409,
  insufficient_drawer: 409,
  ambiguous_target: 409,
  pool_exists: 409,
  request_id_reused: 409,
  allocation_closed: 409,
};

export function fail(reason, message, details) {
  const code = STATUS[reason];
  if (!code) throw new Error(`unknown domain reason ${reason}`);
  throw new DomainError(code, reason, message ?? reason, details);
}

// SQLite refusals that are domain rules (triggers, identity index) become DomainErrors, so a
// rule enforced only by the database still reaches the caller as a 409, not a 500.
export function fromSqlite(err) {
  if (err instanceof DomainError) return err;
  const msg = String(err?.message || '');
  if (msg.includes('stock_exceeded')) {
    return new DomainError(409, 'stock_exceeded', 'The places would hold more batteries than the pool total.');
  }
  if (msg.includes("index 'pools_identity'")) {
    return new DomainError(409, 'pool_exists', 'A pool with the same type, brand, line and capacity already exists.');
  }
  return err;
}
