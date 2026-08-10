import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/capture");
  vi.doUnmock("@/lib/capture/download");
});

class FakeCaptureError extends Error {}

function mocks(opts: {
  signedIn: boolean;
  captureAsync?: () => { slug: string };
}): void {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => (opts.signedIn ? { username: "andres" } : null),
  }));
  vi.doMock("@/lib/capture", () => ({
    captureAsync:
      opts.captureAsync ??
      (() => {
        throw new Error("captureAsync must not run");
      }),
  }));
  vi.doMock("@/lib/capture/download", () => ({
    CaptureError: FakeCaptureError,
  }));
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("session-authed capture route", () => {
  it("requires a session", async () => {
    mocks({ signedIn: false });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(post({ url: "https://a.io/x.pdf" }));
    expect(response.status).toBe(401);
  });

  it("rejects malformed bodies and non-URL values", async () => {
    mocks({ signedIn: true });
    const route = await import("@/app/api/v1/capture/route");
    expect((await route.POST(post({}))).status).toBe(400);
    expect((await route.POST(post({ url: "nope" }))).status).toBe(400);
    expect(
      (await route.POST(post({ url: "https://a.io/x.pdf", extra: 1 }))).status,
    ).toBe(400);
  });

  it("accepts the capture and points at the inbox without waiting", async () => {
    mocks({
      signedIn: true,
      captureAsync: () => ({ slug: "1706-03762" }),
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(
      post({ url: "https://arxiv.org/abs/1706.03762" }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      slug: "1706-03762",
      href: "/?topic=_inbox",
    });
  });

  it("surfaces synchronous start failures with the reason", async () => {
    mocks({
      signedIn: true,
      captureAsync: () => {
        throw new Error("Disk full.");
      },
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(post({ url: "https://a.io/x.pdf" }));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /Disk full/,
    );
  });

  it("maps synchronous capture errors (profile mid-erasure) to 422", async () => {
    mocks({
      signedIn: true,
      captureAsync: () => {
        throw new FakeCaptureError(
          "This profile was deleted while the capture was running.",
        );
      },
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(post({ url: "https://a.io/x.pdf" }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /deleted/,
    );
  });
});
