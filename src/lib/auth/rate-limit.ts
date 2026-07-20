/**
 * In-process login throttling for public exposure: per-IP and per-account
 * counters with exponential lockout. State is in memory by design; a restart
 * clears it, which only ever helps the legitimate owner. Caddy-level bot
 * mitigation sits in front of this in production.
 */

interface Bucket {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

const BASE_LOCK_MS = 2_000;
const MAX_LOCK_MS = 15 * 60_000;
const FREE_ATTEMPTS = 3;

const buckets = new Map<string, Bucket>();
const windows = new Map<string, { startedAt: number; count: number }>();

function bucket(key: string): Bucket {
  if (buckets.size > 10_000) {
    const now = Date.now();
    for (const [candidate, value] of buckets) {
      if (value.lockedUntil < now && value.lastSeen < now - MAX_LOCK_MS) {
        buckets.delete(candidate);
      }
    }
  }
  let b = buckets.get(key);
  if (!b) {
    b = { failures: 0, lockedUntil: 0, lastSeen: Date.now() };
    buckets.set(key, b);
  }
  return b;
}

export function consumeRequestLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): number {
  if (windows.size > 10_000) {
    for (const [candidate, value] of windows) {
      if (value.startedAt + windowMs <= now) windows.delete(candidate);
    }
  }
  const current = windows.get(key);
  if (!current || current.startedAt + windowMs <= now) {
    windows.set(key, { startedAt: now, count: 1 });
    return 0;
  }
  current.count += 1;
  return current.count > limit ? current.startedAt + windowMs - now : 0;
}

/** Milliseconds until the key may try again; 0 when allowed now. */
export function retryAfterMs(key: string, now = Date.now()): number {
  const value = bucket(key);
  value.lastSeen = now;
  return Math.max(0, value.lockedUntil - now);
}

export function recordFailure(key: string, now = Date.now()): void {
  const b = bucket(key);
  b.lastSeen = now;
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

export function forgetAccountRateLimit(username: string): void {
  buckets.delete(`user:${username}`);
}

/** Test hook: reset all state. */
export function resetRateLimits(): void {
  buckets.clear();
  windows.clear();
}
