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
  it("public host and its dav twin are public; other hosts are private", async () => {
    const { hostIsPublic } = await import("@/lib/auth/exposure");
    const pub = "papernook.afromero.co";
    expect(hostIsPublic("papernook.afromero.co", pub)).toBe(true);
    expect(hostIsPublic("papernook.afromero.co:443", pub)).toBe(true);
    expect(hostIsPublic("dav.papernook.afromero.co", pub)).toBe(true);
    expect(hostIsPublic("localhost:3020", pub)).toBe(false);
    expect(hostIsPublic("100.101.102.103:3020", pub)).toBe(false);
    expect(hostIsPublic("server.tailnet-name.ts.net", pub)).toBe(false);
  });

  it("without a configured public host, every request counts as public", async () => {
    const { hostIsPublic } = await import("@/lib/auth/exposure");
    expect(hostIsPublic("anything.example.com", undefined)).toBe(true);
    expect(hostIsPublic(null, "papernook.afromero.co")).toBe(true);
  });
});
