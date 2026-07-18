import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-test-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  delete process.env.PUBLIC_EXPOSURE;
  delete process.env.SESSION_SECRET;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function users() {
  return import("@/lib/auth/users");
}

async function session() {
  return import("@/lib/auth/session");
}

async function rateLimit() {
  return import("@/lib/auth/rate-limit");
}

describe("profiles on disk", () => {
  it("creates a profile and lists it back from disk", async () => {
    const u = await users();
    const created = u.createProfile("Andres R", "jaguar");
    expect(created.username).toBe("andres-r");
    expect(created.avatarSlug).toBe("jaguar");
    const listed = u.listProfiles();
    expect(listed.map((p) => p.username)).toEqual(["andres-r"]);
  });

  it("rejects duplicate and unusable names", async () => {
    const u = await users();
    u.createProfile("Ana");
    expect(() => u.createProfile("Ana")).toThrow(/already exists/);
    expect(() => u.createProfile("!")).toThrow(/at least two/);
  });

  it("never resolves usernames outside the users root", async () => {
    const u = await users();
    expect(u.getProfile("../escape")).toBeNull();
    expect(u.getProfile("..")).toBeNull();
    expect(u.getProfile("a/../../b")).toBeNull();
  });
});

describe("capture token attribution", () => {
  it("resolves a token to exactly its owning profile", async () => {
    const u = await users();
    const ana = u.createProfile("Ana");
    const ben = u.createProfile("Ben");
    expect(u.profileForCaptureToken(ana.captureToken)?.username).toBe("ana");
    expect(u.profileForCaptureToken(ben.captureToken)?.username).toBe("ben");
  });

  it("rejects malformed and unknown tokens", async () => {
    const u = await users();
    u.createProfile("Ana");
    expect(u.profileForCaptureToken("a".repeat(48))).toBeNull();
    expect(u.profileForCaptureToken("not-a-token")).toBeNull();
    expect(u.profileForCaptureToken("")).toBeNull();
  });

  it("rotation invalidates the old token", async () => {
    const u = await users();
    const ana = u.createProfile("Ana");
    const old = ana.captureToken;
    const rotated = u.rotateCaptureToken("ana");
    expect(u.profileForCaptureToken(old)).toBeNull();
    expect(u.profileForCaptureToken(rotated.captureToken)?.username).toBe(
      "ana",
    );
  });
});

describe("sessions", () => {
  it("round-trips a valid token and rejects tampering", async () => {
    const s = await session();
    const token = s.createSessionToken("ana");
    expect(s.verifySessionToken(token)).toBe("ana");
    // Forged username with the original signature must fail.
    const parts = token.split(".");
    expect(s.verifySessionToken(`ben.${parts[1]}.${parts[2]}`)).toBeNull();
    // Truncated / garbage tokens must fail, not throw.
    expect(s.verifySessionToken("ana")).toBeNull();
    expect(s.verifySessionToken("")).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const s = await session();
    const past = Date.now() - 1000 * 60 * 60 * 24 * 120;
    const token = s.createSessionToken("ana", past);
    expect(s.verifySessionToken(token)).toBeNull();
  });
});

describe("passwords under public exposure", () => {
  it("verifies a set password and rejects wrong ones", async () => {
    const u = await users();
    u.createProfile("Ana");
    await u.setPassword("ana", "correct horse battery");
    expect(await u.verifyPassword("ana", "correct horse battery")).toBe(true);
    expect(await u.verifyPassword("ana", "wrong")).toBe(false);
    expect(await u.verifyPassword("ana", "")).toBe(false);
  });

  it("passwordless profiles never verify (no bypass via empty hash)", async () => {
    const u = await users();
    u.createProfile("Ana");
    expect(await u.verifyPassword("ana", "")).toBe(false);
    expect(await u.verifyPassword("ana", "anything")).toBe(false);
  });

  it("requiresPassword follows the exposure flag", async () => {
    const u = await users();
    expect(u.requiresPassword()).toBe(false);
    process.env.PUBLIC_EXPOSURE = "true";
    expect(u.requiresPassword()).toBe(true);
  });
});

describe("login rate limiting", () => {
  it("locks out after repeated failures with growing delays", async () => {
    const rl = await rateLimit();
    rl.resetRateLimits();
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) rl.recordFailure("ip:1.2.3.4", now);
    expect(rl.retryAfterMs("ip:1.2.3.4", now)).toBe(0); // free attempts
    rl.recordFailure("ip:1.2.3.4", now);
    const first = rl.retryAfterMs("ip:1.2.3.4", now);
    expect(first).toBeGreaterThan(0);
    rl.recordFailure("ip:1.2.3.4", now);
    expect(rl.retryAfterMs("ip:1.2.3.4", now)).toBeGreaterThan(first);
  });

  it("success clears the bucket", async () => {
    const rl = await rateLimit();
    rl.resetRateLimits();
    for (let i = 0; i < 10; i += 1) rl.recordFailure("user:ana");
    expect(rl.retryAfterMs("user:ana")).toBeGreaterThan(0);
    rl.recordSuccess("user:ana");
    expect(rl.retryAfterMs("user:ana")).toBe(0);
  });

  it("buckets are independent per key", async () => {
    const rl = await rateLimit();
    rl.resetRateLimits();
    for (let i = 0; i < 10; i += 1) rl.recordFailure("user:ana");
    expect(rl.retryAfterMs("user:ben")).toBe(0);
  });
});
