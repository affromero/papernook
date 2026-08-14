import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const diagnostic = {
  protocol: 1,
  type: "papernook-three-diagnostic",
  kind: "module-evaluation-failed",
  line: 17,
  column: 4,
} as const;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/auth/session");
});

function mockSession(signedIn = true) {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => (signedIn ? { username: "andres" } : null),
  }));
}

function request(
  body: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/v1/client-logs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("Three.js client diagnostic route", () => {
  it("requires an authenticated profile", async () => {
    mockSession(false);
    const route = await import("@/app/api/v1/client-logs/route");
    const response = await route.POST(request(JSON.stringify(diagnostic)));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("logs one structured, data-free diagnostic and returns no content", async () => {
    mockSession();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = await import("@/app/api/v1/client-logs/route");
    const response = await route.POST(
      request(JSON.stringify(diagnostic), {
        "User-Agent": "Safari SECRET-IN-UA",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      event: "papernook-three-diagnostic",
      username: "andres",
      userAgent: "Safari SECRET-IN-UA",
      ...diagnostic,
    });
  });

  it("rejects extra fields so scene text cannot cross the sandbox", async () => {
    mockSession();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = await import("@/app/api/v1/client-logs/route");
    const response = await route.POST(
      request(
        JSON.stringify({
          ...diagnostic,
          message: "SECRET PAPER TEXT",
          stack: "https://example.test/three-sandbox.html#SECRET-CODE",
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  });

  it("preserves malformed and oversized request status", async () => {
    mockSession();
    const route = await import("@/app/api/v1/client-logs/route");
    expect((await route.POST(request("{"))).status).toBe(400);
    expect(
      (
        await route.POST(
          request(
            JSON.stringify({ ...diagnostic, padding: "x".repeat(5_000) }),
          ),
        )
      ).status,
    ).toBe(413);
  });

  it("throttles repeated diagnostics per profile", async () => {
    mockSession();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = await import("@/app/api/v1/client-logs/route");
    let response = await route.POST(request(JSON.stringify(diagnostic)));
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      response = await route.POST(request(JSON.stringify(diagnostic)));
    }
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledTimes(20);
  });
});
