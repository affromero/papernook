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
