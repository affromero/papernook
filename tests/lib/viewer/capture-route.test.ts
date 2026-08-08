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
  capture?: () => Promise<{ slug: string; proposedTopic: string }>;
}): void {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => (opts.signedIn ? { username: "andres" } : null),
  }));
  vi.doMock("@/lib/capture", () => ({
    capture:
      opts.capture ??
      (async () => {
        throw new Error("capture must not run");
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

  it("returns the inbox href on success", async () => {
    mocks({
      signedIn: true,
      capture: async () => ({
        slug: "attention-is-all-you-need",
        proposedTopic: "transformers",
      }),
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(
      post({ url: "https://arxiv.org/abs/1706.03762" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "attention-is-all-you-need",
      proposedTopic: "transformers",
      href: "/inbox/attention-is-all-you-need",
    });
  });

  it("surfaces non-capture errors (misconfigured provider) as 502 with the reason", async () => {
    mocks({
      signedIn: true,
      capture: async () => {
        throw new Error(
          "CLI agent providers are disabled for public exposure because model tools can read host files.",
        );
      },
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(
      post({ url: "https://arxiv.org/abs/1706.03762" }),
    );
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /public exposure/,
    );
  });

  it("maps capture failures (duplicates, dead URLs) to 422", async () => {
    mocks({
      signedIn: true,
      capture: async () => {
        throw new FakeCaptureError("This paper is already in your library.");
      },
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(
      post({ url: "https://arxiv.org/abs/1706.03762" }),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /already in your library/,
    );
  });
});
