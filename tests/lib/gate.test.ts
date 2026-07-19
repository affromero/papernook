import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", "x".repeat(64));
});

describe("access gate token", () => {
  it("round-trips a valid token and rejects tampering", async () => {
    const g = await import("@/lib/auth/gate");
    const token = g.createGateToken();
    expect(g.verifyGateToken(token)).toBe(true);
    const [expiry, sig] = token.split(".");
    // Forged expiry with the old signature must fail.
    expect(g.verifyGateToken(`${Number(expiry) + 1}.${sig}`)).toBe(false);
    expect(g.verifyGateToken("garbage")).toBe(false);
    expect(g.verifyGateToken("")).toBe(false);
  });

  it("rejects expired tokens", async () => {
    const g = await import("@/lib/auth/gate");
    const past = Date.now() - 1000 * 60 * 60;
    const token = g.createGateToken(past);
    expect(g.verifyGateToken(token)).toBe(false);
  });

  it("a token signed under a different secret does not verify", async () => {
    const g1 = await import("@/lib/auth/gate");
    const token = g1.createGateToken();
    vi.resetModules();
    vi.stubEnv("SESSION_SECRET", "y".repeat(64));
    const g2 = await import("@/lib/auth/gate");
    expect(g2.verifyGateToken(token)).toBe(false);
  });
});

describe("host-based exposure", () => {
  it("public host and its dav sibling are public; other hosts are private", async () => {
    const { hostIsPublic } = await import("@/lib/auth/exposure");
    const pub = "papernook.example.com";
    expect(hostIsPublic("papernook.example.com", pub)).toBe(true);
    expect(hostIsPublic("papernook.example.com:443", pub)).toBe(true);
    expect(hostIsPublic("dav-papernook.example.com", pub)).toBe(true);
    expect(hostIsPublic("localhost:3020", pub)).toBe(false);
    expect(hostIsPublic("100.101.102.103:3020", pub)).toBe(false);
    expect(hostIsPublic("server.tailnet-name.ts.net", pub)).toBe(false);
  });

  it("without a configured public host, every request counts as public", async () => {
    const { hostIsPublic } = await import("@/lib/auth/exposure");
    expect(hostIsPublic("anything.example.com", undefined)).toBe(true);
    expect(hostIsPublic(null, "papernook.example.com")).toBe(true);
  });
});

describe("invite tokens", () => {
  it("round-trips, is distinct from gate tokens, and expires", async () => {
    const g = await import("@/lib/auth/gate");
    const invite = g.createInviteToken();
    expect(g.verifyInviteToken(invite)).toBe(true);
    // an invite is not a gate token and vice versa
    expect(g.verifyGateToken(invite)).toBe(false);
    expect(g.verifyInviteToken(g.createGateToken())).toBe(false);
    const old = g.createInviteToken(Date.now() - 1000 * 60 * 60 * 24 * 8);
    expect(g.verifyInviteToken(old)).toBe(false);
  });
});
