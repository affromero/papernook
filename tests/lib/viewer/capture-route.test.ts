import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/capture");
  vi.doUnmock("@/lib/capture/download");
  vi.doUnmock("@/lib/capture/jobs");
});

class FakeCaptureError extends Error {}

interface FakeJob {
  slug: string;
  state: "analyzing" | "failed" | "done";
  sourceUrl: string;
  addedBy: string;
  startedAt: string;
  error?: string;
  finalSlug?: string;
}

function mocks(opts: {
  signedIn: boolean;
  captureAsync?: () => { slug: string };
  job?: FakeJob | null;
  clearCaptureJob?: (slug: string) => void;
  removeCaptureJobDir?: (slug: string) => void;
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
  vi.doMock("@/lib/capture/jobs", () => ({
    readCaptureJob: () => opts.job ?? null,
    clearCaptureJob: opts.clearCaptureJob ?? (() => {}),
    removeCaptureJobDir: opts.removeCaptureJobDir ?? (() => {}),
  }));
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function statusGet(slug: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/capture?slug=${encodeURIComponent(slug)}`,
  );
}

function job(overrides: Partial<FakeJob>): FakeJob {
  return {
    slug: "2209-03416",
    state: "analyzing",
    sourceUrl: "https://arxiv.org/pdf/2209.03416",
    addedBy: "andres",
    startedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
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

  it("accepts the capture and returns the pollable slug without waiting", async () => {
    mocks({
      signedIn: true,
      captureAsync: () => ({ slug: "1706-03762" }),
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(
      post({ url: "https://arxiv.org/abs/1706.03762" }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ slug: "1706-03762" });
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

describe("capture status poll", () => {
  it("requires a session", async () => {
    mocks({ signedIn: false });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.GET(statusGet("2209-03416"));
    expect(response.status).toBe(401);
  });

  it("rejects invalid slugs", async () => {
    mocks({ signedIn: true });
    const route = await import("@/app/api/v1/capture/route");
    expect((await route.GET(statusGet("../etc"))).status).toBe(400);
    expect((await route.GET(statusGet(""))).status).toBe(400);
  });

  it("404s for missing jobs and other profiles' jobs", async () => {
    mocks({ signedIn: true, job: null });
    let route = await import("@/app/api/v1/capture/route");
    expect((await route.GET(statusGet("2209-03416"))).status).toBe(404);

    vi.resetModules();
    mocks({ signedIn: true, job: job({ addedBy: "someone-else" }) });
    route = await import("@/app/api/v1/capture/route");
    expect((await route.GET(statusGet("2209-03416"))).status).toBe(404);
  });

  it("reports an analyzing job as still running", async () => {
    mocks({ signedIn: true, job: job({ state: "analyzing" }) });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.GET(statusGet("2209-03416"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "analyzing" });
  });

  it("reports a failed job with the recorded reason", async () => {
    mocks({
      signedIn: true,
      job: job({ state: "failed", error: "arXiv said no." }),
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.GET(statusGet("2209-03416"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "failed",
      error: "arXiv said no.",
    });
  });

  it("reports done once and retires the marker", async () => {
    const cleared: string[] = [];
    mocks({
      signedIn: true,
      job: job({ state: "done", finalSlug: "attention-is-all-you-need" }),
      clearCaptureJob: (slug) => cleared.push(`clear:${slug}`),
      removeCaptureJobDir: (slug) => cleared.push(`rm:${slug}`),
    });
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.GET(statusGet("2209-03416"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "done",
      finalSlug: "attention-is-all-you-need",
    });
    expect(cleared).toEqual(["clear:2209-03416", "rm:2209-03416"]);
  });
});
