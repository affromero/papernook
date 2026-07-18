/**
 * In-process login throttling for public exposure: per-IP and per-account
 * counters with exponential lockout. State is in memory by design; a restart
 * clears it, which only ever helps the legitimate owner. Caddy-level bot
 * mitigation sits in front of this in production.
 */

interface Bucket {
  failures: number;
  lockedUntil: number;
}

const BASE_LOCK_MS = 2_000;
const MAX_LOCK_MS = 15 * 60_000;
const FREE_ATTEMPTS = 3;

const buckets = new Map<string, Bucket>();

function bucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { failures: 0, lockedUntil: 0 };
    buckets.set(key, b);
  }
  return b;
}

/** Milliseconds until the key may try again; 0 when allowed now. */
export function retryAfterMs(key: string, now = Date.now()): number {
  return Math.max(0, bucket(key).lockedUntil - now);
}

export function recordFailure(key: string, now = Date.now()): void {
  const b = bucket(key);
  b.failures += 1;
  if (b.failures > FREE_ATTEMPTS) {
    const exponent = b.failures - FREE_ATTEMPTS - 1;
    const lock = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** exponent);
    b.lockedUntil = now + lock;
  }
}

export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/** Test hook: reset all state. */
export function resetRateLimits(): void {
  buckets.clear();
}
