import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-addstatus-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/capture/download");
  vi.doUnmock("@/lib/capture/analyze");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function post(pathname: string, fields: Record<string, string>): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new NextRequest(`http://papernook.test${pathname}`, {
    method: "POST",
    body: form,
  });
}

async function makeProfile() {
  const { ensureDataDirs } = await import("@/lib/data-dir");
  ensureDataDirs();
  const users = await import("@/lib/auth/users");
  return users.createProfile("Andres");
}

describe("async /add flow", () => {
  it("answers immediately with a pending page that polls /add/status", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/capture/download")
    >("@/lib/capture/download");
    vi.doMock("@/lib/capture/download", () => ({
      ...actual,
      // Never resolves: the response must not depend on the download.
      downloadPdf: () => new Promise(() => {}),
    }));
    const profile = await makeProfile();
    const { POST } = await import("@/app/add/route");
    const response = await POST(
      post("/add", {
        url: "https://arxiv.org/abs/1706.03762",
        token: profile.captureToken,
      }),
    );
    expect(response.status).toBe(202);
    const body = await response.text();
    expect(body).toContain('action="/add/status"');
    expect(body).toContain(profile.captureToken);
    expect(body).toContain("Capturing…");
  });

  it("keeps polling while analyzing and shows the reason after failure", async () => {
    const profile = await makeProfile();
    const jobs = await import("@/lib/capture/jobs");
    jobs.writeCaptureJob({
      slug: "slow-paper",
      state: "analyzing",
      sourceUrl: "https://a.io/x.pdf",
      addedBy: profile.username,
      startedAt: new Date().toISOString(),
    });
    const { POST } = await import("@/app/add/status/route");
    const pending = await POST(
      post("/add/status", { token: profile.captureToken, slug: "slow-paper" }),
    );
    expect(pending.status).toBe(202);
    expect(await pending.text()).toContain('action="/add/status"');

    jobs.writeCaptureJob({
      slug: "slow-paper",
      state: "failed",
      sourceUrl: "https://a.io/x.pdf",
      addedBy: profile.username,
      startedAt: new Date().toISOString(),
      error: "The publisher blocks downloads.",
    });
    const failed = await POST(
      post("/add/status", { token: profile.captureToken, slug: "slow-paper" }),
    );
    expect(failed.status).toBe(422);
    expect(await failed.text()).toContain("The publisher blocks downloads.");
  });

  it("renders the confirmation for a finished capture and retires the handle", async () => {
    const profile = await makeProfile();
    const papers = await import("@/lib/library/papers");
    papers.writeMeta(null, "attention-is-all-you-need", {
      title: "Attention Is All You Need",
      authors: ["Vaswani"],
      year: 2017,
      venue: "NeurIPS",
      arxivId: "1706.03762",
      bibtex: null,
      tags: ["transformers"],
      related: [],
      proposedTopic: "nlp",
      sourceUrl: "https://arxiv.org/abs/1706.03762",
      addedAt: new Date().toISOString(),
      addedBy: profile.username,
    });
    papers.writeSummary(
      null,
      "attention-is-all-you-need",
      "The transformer paper.",
    );
    fs.writeFileSync(
      papers.pdfPath(null, "attention-is-all-you-need"),
      "%PDF-1.4",
    );
    const jobs = await import("@/lib/capture/jobs");
    jobs.writeCaptureJob({
      slug: "1706-03762",
      state: "done",
      sourceUrl: "https://arxiv.org/abs/1706.03762",
      addedBy: profile.username,
      startedAt: new Date().toISOString(),
      finalSlug: "attention-is-all-you-need",
    });

    const { POST } = await import("@/app/add/status/route");
    const done = await POST(
      post("/add/status", { token: profile.captureToken, slug: "1706-03762" }),
    );
    expect(done.status).toBe(200);
    const body = await done.text();
    expect(body).toContain("Attention Is All You Need");
    expect(body).toContain('action="/add/confirm"');
    expect(body).toContain("nlp");
    expect(jobs.readCaptureJob("1706-03762")).toBeNull();

    const again = await POST(
      post("/add/status", { token: profile.captureToken, slug: "1706-03762" }),
    );
    expect(again.status).toBe(404);
  });

  it("rejects bad tokens and other profiles' captures", async () => {
    const profile = await makeProfile();
    const jobs = await import("@/lib/capture/jobs");
    jobs.writeCaptureJob({
      slug: "private-job",
      state: "analyzing",
      sourceUrl: "https://a.io/x.pdf",
      addedBy: profile.username,
      startedAt: new Date().toISOString(),
    });
    const users = await import("@/lib/auth/users");
    const other = users.createProfile("Other");
    const { POST } = await import("@/app/add/status/route");
    expect(
      (await POST(post("/add/status", { token: "bogus", slug: "private-job" })))
        .status,
    ).toBe(401);
    expect(
      (
        await POST(
          post("/add/status", {
            token: other.captureToken,
            slug: "private-job",
          }),
        )
      ).status,
    ).toBe(404);
  });
});
