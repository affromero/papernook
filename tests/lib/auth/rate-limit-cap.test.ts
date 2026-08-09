import { beforeEach, describe, expect, it } from "vitest";
import {
  recordFailure,
  retryAfterMs,
  resetRateLimits,
} from "@/lib/auth/rate-limit";

beforeEach(() => resetRateLimits());

describe("rate-limit memory cap", () => {
  it("evicts oldest entries once the tracked-key ceiling is exceeded", () => {
    // Lock a victim key hard (4 failures > the 3 free attempts).
    const victim = "gate:203.0.113.7";
    for (let i = 0; i < 4; i += 1) recordFailure(victim);
    expect(retryAfterMs(victim)).toBeGreaterThan(0);

    // Flood past the 10k ceiling with distinct fresh keys (spoofed-IP flood).
    for (let i = 0; i < 10_500; i += 1) recordFailure(`gate:flood-${i}`);

    // The victim was the oldest-inserted, so it is dropped; a fresh lookup
    // returns 0 (a new unlocked bucket) rather than growing memory unbounded.
    expect(retryAfterMs(victim)).toBe(0);
  });
});
