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

const MAX_TRACKED = 10_000;

const buckets = new Map<string, Bucket>();
const windows = new Map<string, { startedAt: number; count: number }>();

// Hard memory cap: even if every tracked key is still fresh (a flood of
// distinct keys), drop the oldest-inserted entries so the map can never grow
// without bound. Map iteration is insertion-ordered, so the first keys are the
// oldest — good enough for a DoS backstop, and legitimate keys re-add cheaply.
function evictOldest(map: Map<string, unknown>): void {
  const excess = map.size - MAX_TRACKED + 1_000;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++removed >= excess) break;
  }
}

function bucket(key: string): Bucket {
  if (buckets.size > MAX_TRACKED) {
    const now = Date.now();
    for (const [candidate, value] of buckets) {
      if (value.lockedUntil < now && value.lastSeen < now - MAX_LOCK_MS) {
        buckets.delete(candidate);
      }
    }
    if (buckets.size > MAX_TRACKED) evictOldest(buckets);
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
  if (windows.size > MAX_TRACKED) {
    for (const [candidate, value] of windows) {
      if (value.startedAt + windowMs <= now) windows.delete(candidate);
    }
    if (windows.size > MAX_TRACKED) evictOldest(windows);
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
