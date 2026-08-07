import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/capture/download");
});

function mockSession(signedIn: boolean): void {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => (signedIn ? { username: "andres" } : null),
  }));
}

class FakeCaptureError extends Error {}

function mockDownload(impl: () => Promise<{ bytes: Buffer }>): void {
  vi.doMock("@/lib/capture/download", () => ({
    CaptureError: FakeCaptureError,
    downloadPdf: impl,
  }));
}

function get(src: string | null): NextRequest {
  const url = new URL("http://localhost/api/v1/viewer/pdf");
  if (src !== null) url.searchParams.set("src", src);
  return new NextRequest(url);
}

describe("viewer PDF proxy", () => {
  it("requires a session", async () => {
    mockSession(false);
    mockDownload(async () => {
      throw new Error("must not fetch");
    });
    const route = await import("@/app/api/v1/viewer/pdf/route");
    expect(
      (await route.GET(get("https://arxiv.org/pdf/1706.03762"))).status,
    ).toBe(401);
  });

  it("rejects missing and non-http src URLs", async () => {
    mockSession(true);
    mockDownload(async () => {
      throw new Error("must not fetch");
    });
    const route = await import("@/app/api/v1/viewer/pdf/route");
    expect((await route.GET(get(null))).status).toBe(400);
    expect((await route.GET(get("not a url"))).status).toBe(400);
    expect((await route.GET(get("file:///etc/passwd"))).status).toBe(400);
  });

  it("maps download failures to 422 with the message", async () => {
    mockSession(true);
    mockDownload(async () => {
      throw new FakeCaptureError("That page has no PDF.");
    });
    const route = await import("@/app/api/v1/viewer/pdf/route");
    const response = await route.GET(get("https://example.com/paper"));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /no PDF/,
    );
  });

  it("streams fetched bytes back as an inline PDF", async () => {
    mockSession(true);
    mockDownload(async () => ({ bytes: Buffer.from("%PDF-1.4 fake") }));
    const route = await import("@/app/api/v1/viewer/pdf/route");
    const response = await route.GET(get("https://example.com/paper.pdf"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toContain(
      "%PDF-1.4",
    );
  });
});
