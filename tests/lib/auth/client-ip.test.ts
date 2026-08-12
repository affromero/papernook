import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { clientIp } from "@/lib/auth/request-security";

function withHeaders(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://papernook.test/api/v1/gate", { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientIp trust boundary", () => {
  it("takes the proxy-appended (rightmost) X-Forwarded-For entry, not a spoofed leftmost one", () => {
    // Attacker prepends a fake IP; Caddy appends the real peer on the right.
    const request = withHeaders({
      "x-forwarded-for": "1.2.3.4, 203.0.113.9",
    });
    expect(clientIp(request)).toBe("203.0.113.9");
  });

  it("never trusts X-Real-IP (Caddy leaves it client-controlled)", () => {
    const request = withHeaders({
      "x-real-ip": "1.2.3.4",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(clientIp(request)).toBe("203.0.113.9");
  });

  it("counts TRUSTED_PROXY_HOPS entries from the right", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    const request = withHeaders({
      // spoofed, real-client, caddy-appended-cloudflare
      "x-forwarded-for": "9.9.9.9, 203.0.113.9, 10.0.0.1",
    });
    expect(clientIp(request)).toBe("203.0.113.9");
  });

  it("fails closed to 'unknown' when the chain is shorter than the hop count", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "3");
    const request = withHeaders({ "x-forwarded-for": "203.0.113.9" });
    expect(clientIp(request)).toBe("unknown");
  });

  it("ignores the header entirely when no proxy is in front", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    const request = withHeaders({ "x-forwarded-for": "203.0.113.9" });
    // Directly exposed: every entry is client-authored, so a rotating
    // X-Forwarded-For must not mint a fresh rate-limit bucket per request.
    expect(clientIp(request)).toBe("unknown");
    expect(clientIp(withHeaders({ "x-forwarded-for": "198.51.100.4" }))).toBe(
      "unknown",
    );
  });

  it("returns 'unknown' with no forwarding header and rejects non-IP junk", () => {
    expect(clientIp(withHeaders({}))).toBe("unknown");
    expect(clientIp(withHeaders({ "x-forwarded-for": "not an ip" }))).toBe(
      "unknown",
    );
  });
});

describe("lockout buckets", () => {
  it("gives no bucket to a client it cannot identify", async () => {
    const { lockoutKey } = await import("@/lib/auth/request-security");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");

    // Without a trusted proxy every caller looks identical, so locking the
    // shared bucket would let one attacker shut the whole instance out.
    expect(
      lockoutKey(withHeaders({ "x-forwarded-for": "203.0.113.9" }), "gate"),
    ).toBeNull();
    expect(lockoutKey(withHeaders({}), "ip")).toBeNull();
  });

  it("keys identifiable clients separately per purpose", async () => {
    const { lockoutKey } = await import("@/lib/auth/request-security");
    const request = withHeaders({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" });

    expect(lockoutKey(request, "gate")).toBe("gate:203.0.113.9");
    expect(lockoutKey(request, "ip")).toBe("ip:203.0.113.9");
  });
});

describe("escalating lockout buckets stay isolated", () => {
  it("never lets a cross-site-reachable route lock the login bucket", async () => {
    const { lockoutKey } = await import("@/lib/auth/request-security");
    const request = withHeaders({ "x-forwarded-for": "203.0.113.9" });

    // /add accepts cross-site form posts by design (bookmarklet, Shortcut),
    // so a hostile page can drive its failure counter using the victim's own
    // address. That must never be the bucket that gates signing in.
    const login = lockoutKey(request, "ip");
    const capture = lockoutKey(request, "capture-token-ip");
    const status = lockoutKey(request, "status-ip");
    const confirm = lockoutKey(request, "confirm-ip");
    const gate = lockoutKey(request, "gate");

    const buckets = [login, capture, status, confirm, gate];
    expect(new Set(buckets).size).toBe(buckets.length);
  });
});
