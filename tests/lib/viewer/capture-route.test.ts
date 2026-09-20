import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { acquireFileLockSync } from "thesidedoor-core/storage";
import {
  createTestProfile,
  testSession,
  testProfileCapability,
} from "../../helpers/access";
import {
  writeCaptureJob,
  readCaptureJob,
  type CaptureJob,
} from "@/lib/capture/jobs";

let directory: string;
const browser = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "papernook_access" && browser.token
        ? { value: browser.token }
        : undefined,
  }),
}));
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-capture-route-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Andres");
  browser.token = await testSession("andres");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(directory, { recursive: true, force: true });
});

function post(body: unknown) {
  return new NextRequest("http://localhost/api/v1/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function statusGet(slug = "pending-capture") {
  return new NextRequest(
    "http://localhost/api/v1/capture?slug=" + encodeURIComponent(slug),
  );
}
function seedJob(overrides: Partial<CaptureJob> = {}) {
  const job: CaptureJob = {
    slug: "pending-capture",
    state: "analyzing",
    sourceUrl: "https://arxiv.org/pdf/2209.03416",
    addedBy: "andres",
    generation: testProfileCapability("andres").generation,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
  writeCaptureJob(job);
  return job;
}
describe("capture admission and status", () => {
  it("gives bookmarklet users a retryable page when capture is busy", async () => {
    const release = acquireFileLockSync(
      path.join(directory, "locks", "capture-reservation.guard"),
    );
    try {
      const { getProfile } = await import("@/lib/auth/users");
      const route = await import("@/app/add/route");
      const response = await route.POST(
        new NextRequest("http://localhost/add", {
          method: "POST",
          body: new URLSearchParams({
            token: getProfile("andres")!.captureToken,
            url: "https://example.com/paper.pdf",
          }),
        }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).toContain(
        "Capture is busy. Try again shortly.",
      );
      const { listCaptureJobs } = await import("@/lib/capture/jobs");
      expect(listCaptureJobs()).toEqual([]);
    } finally {
      release();
    }
  }, 15_000);

  it("returns a retryable response when capture reservation remains busy", async () => {
    const release = acquireFileLockSync(
      path.join(directory, "locks", "capture-reservation.guard"),
    );
    try {
      const route = await import("@/app/api/v1/capture/route");
      const response = await route.POST(
        post({ url: "https://example.com/paper.pdf" }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.json()).toEqual({
        error: "Capture is busy. Try again shortly.",
      });
      const { listCaptureJobs } = await import("@/lib/capture/jobs");
      expect(listCaptureJobs()).toEqual([]);
    } finally {
      release();
    }
  }, 15_000);

  it("requires a persisted session for capture and polling", async () => {
    browser.token = null;
    const route = await import("@/app/api/v1/capture/route");
    expect(
      (await route.POST(post({ url: "https://arxiv.org/pdf/2209.03416" })))
        .status,
    ).toBe(401);
    expect((await route.GET(statusGet())).status).toBe(401);
  });
  it("rejects invalid capture requests and status references", async () => {
    const route = await import("@/app/api/v1/capture/route");
    for (const body of [
      {},
      { url: "nope" },
      { url: "https://arxiv.org/pdf/2209.03416", extra: 1 },
    ])
      expect((await route.POST(post(body))).status).toBe(400);
    expect((await route.GET(statusGet("../etc"))).status).toBe(400);
    expect((await route.GET(statusGet(""))).status).toBe(400);
  });
  it("returns a polling handle and records rejection of a private download address", async () => {
    const route = await import("@/app/api/v1/capture/route");
    const response = await route.POST(
      post({ url: "http://127.0.0.1/private.pdf" }),
    );
    expect(response.status).toBe(202);
    const { slug } = (await response.json()) as { slug: string };
    await vi.waitFor(() => expect(readCaptureJob(slug)?.state).toBe("failed"));
    const status = await route.GET(statusGet(slug));
    expect(await status.json()).toEqual({
      state: "failed",
      error: expect.stringContaining("public internet addresses"),
    });
  });
  it("hides missing, foreign, incomplete and stale-generation jobs without changing them", async () => {
    const route = await import("@/app/api/v1/capture/route");
    expect((await route.GET(statusGet())).status).toBe(404);
    for (const overrides of [
      { addedBy: "another-reader" },
      { generation: undefined },
      { generation: 999 },
    ]) {
      const job = seedJob(overrides);
      expect((await route.GET(statusGet())).status).toBe(404);
      expect(readCaptureJob(job.slug)).toEqual(
        job.generation === undefined
          ? expect.objectContaining({ addedBy: job.addedBy })
          : job,
      );
    }
  });
  it("reports an admitted generation's running and failed jobs", async () => {
    const route = await import("@/app/api/v1/capture/route");
    seedJob();
    expect(await (await route.GET(statusGet())).json()).toEqual({
      state: "analyzing",
    });
    seedJob({ state: "failed", error: "Publisher denied access." });
    expect(await (await route.GET(statusGet())).json()).toEqual({
      state: "failed",
      error: "Publisher denied access.",
    });
  });
  it("retires a completed marker after reporting it once", async () => {
    const route = await import("@/app/api/v1/capture/route");
    const job = seedJob({ state: "done", finalSlug: "finished-paper" });
    expect(await (await route.GET(statusGet())).json()).toEqual({
      state: "done",
      finalSlug: "finished-paper",
    });
    expect(readCaptureJob(job.slug)).toBeNull();
    expect((await route.GET(statusGet())).status).toBe(404);
  });
});
