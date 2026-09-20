import { testProfileCapability } from "../../helpers/access";
import { createTestProfile } from "../../helpers/access";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-jobs-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
  await createTestProfile("Andres");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/capture/download");
  vi.doUnmock("@/lib/capture/analyze");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ANALYSIS = {
  title: "Attention Is All You Need",
  authors: ["Vaswani"],
  year: 2017,
  venue: "NeurIPS",
  bibtex: null,
  tags: ["transformers"],
  related: [],
  topic: "nlp",
  summary: "The transformer paper.",
  starterQuestions: ["Why attention?"],
};

async function mockPipeline(opts?: {
  download?: () => Promise<{
    bytes: Buffer;
    finalUrl: string;
    arxivId: string | null;
  }>;
}) {
  const actual = await vi.importActual<typeof import("@/lib/capture/download")>(
    "@/lib/capture/download",
  );
  vi.doMock("@/lib/capture/download", () => ({
    ...actual,
    downloadPdf:
      opts?.download ??
      (async () => ({
        bytes: Buffer.from("%PDF-1.4 fake"),
        finalUrl: "https://arxiv.org/pdf/1706.03762",
        arxivId: "1706.03762",
      })),
  }));
  vi.doMock("@/lib/capture/analyze", () => ({
    extractPdfText: async () => "extracted text",
    analyzePaper: async () => ANALYSIS,
    linearizePdf: async () => undefined,
    compressPdf: async () => undefined,
  }));
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

describe("capture job markers", () => {
  it("erases an interrupted temporary job publication containing a private source URL", async () => {
    const jobs = await import("@/lib/capture/jobs");
    jobs.writeCaptureJob({
      slug: "interrupted",
      state: "analyzing",
      sourceUrl: "https://private.example/paper",
      addedBy: "andres",
      startedAt: new Date().toISOString(),
    });
    const file = path.join(tmpDir, "capture-jobs", "interrupted.json");
    const temporary = `${file}.11111111-1111-4111-8111-111111111111.tmp`;
    fs.renameSync(file, temporary);
    jobs.sweepCaptureJobs("andres");
    expect(fs.existsSync(temporary)).toBe(false);
  });

  it("reports incomplete erasure when temporary job ownership cannot be decoded", async () => {
    const jobs = await import("@/lib/capture/jobs");
    const root = path.join(tmpDir, "capture-jobs");
    fs.mkdirSync(root, { recursive: true });
    const temporary = path.join(
      root,
      "interrupted.json.11111111-1111-4111-8111-111111111111.tmp",
    );
    fs.writeFileSync(temporary, "{broken");
    expect(() => jobs.sweepCaptureJobs("andres")).toThrow();
    expect(fs.existsSync(temporary)).toBe(true);
  });

  it("does not report erasure complete when a capture record has unreadable ownership", async () => {
    const jobs = await import("@/lib/capture/jobs");
    const root = path.join(tmpDir, "capture-jobs");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "corrupt.json"), "{broken");
    expect(() => jobs.sweepCaptureJobs("andres")).toThrow();
    expect(fs.readFileSync(path.join(root, "corrupt.json"), "utf8")).toBe(
      "{broken",
    );
  });

  it("round-trips markers and lists them per profile, newest first", async () => {
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    const jobs = await import("@/lib/capture/jobs");
    jobs.writeCaptureJob({
      slug: "older",
      state: "analyzing",
      sourceUrl: "https://a.io/1.pdf",
      addedBy: "andres",
      startedAt: "2026-08-10T10:00:00.000Z",
    });
    jobs.writeCaptureJob({
      slug: "newer",
      state: "failed",
      sourceUrl: "https://a.io/2.pdf",
      addedBy: "andres",
      startedAt: "2026-08-10T11:00:00.000Z",
      error: "boom",
    });
    jobs.writeCaptureJob({
      slug: "guests",
      state: "analyzing",
      sourceUrl: "https://a.io/3.pdf",
      addedBy: "guest",
      startedAt: "2026-08-10T12:00:00.000Z",
    });
    expect(jobs.listCaptureJobs("andres").map((j) => j.slug)).toEqual([
      "newer",
      "older",
    ]);
    expect(jobs.readCaptureJob("newer")?.error).toBe("boom");
  });

  it("recovers interrupted captures and preserves completed polling handles", async () => {
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    const jobs = await import("@/lib/capture/jobs");
    jobs.writeCaptureJob({
      slug: "mid-flight",
      jobId: "11111111-1111-4111-8111-111111111111",
      pollingSlug: "mid-flight",
      generation: testProfileCapability("andres").generation,
      state: "analyzing",
      sourceUrl: "https://a.io/1.pdf",
      addedBy: "andres",
      startedAt: "2026-08-10T10:00:00.000Z",
    });
    jobs.writeCaptureJob({
      slug: "long-done",
      state: "done",
      sourceUrl: "https://a.io/2.pdf",
      addedBy: "andres",
      startedAt: "2026-08-10T10:00:00.000Z",
      finalSlug: "some-title",
    });
    jobs.recoverInterruptedCaptures();
    const recovered = jobs.readCaptureJob("mid-flight");
    expect(recovered?.state).toBe("failed");
    expect(recovered?.error).toContain("restart");
    expect(jobs.readCaptureJob("long-done")?.state).toBe("done");
  });

  it("erasure sweep removes only the erased profile's markers", async () => {
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    const jobs = await import("@/lib/capture/jobs");
    for (const [slug, addedBy] of [
      ["mine", "andres"],
      ["theirs", "guest"],
    ] as const) {
      jobs.writeCaptureJob({
        slug,
        state: "failed",
        sourceUrl: `https://a.io/${slug}.pdf`,
        addedBy,
        startedAt: "2026-08-10T10:00:00.000Z",
        error: "x",
      });
    }
    const { anonymizePapersByUser } = await import("@/lib/library/papers");
    anonymizePapersByUser("andres");
    expect(jobs.readCaptureJob("mine")).toBeNull();
    expect(jobs.readCaptureJob("theirs")?.addedBy).toBe("guest");
  });

  it("reserves marker dirs in uniqueSlug", async () => {
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    const jobs = await import("@/lib/capture/jobs");
    jobs.writeCaptureJob({
      slug: "paper",
      state: "analyzing",
      sourceUrl: "https://a.io/paper.pdf",
      addedBy: "andres",
      startedAt: "2026-08-10T10:00:00.000Z",
    });
    const { uniqueSlug } = await import("@/lib/library/papers");
    expect(uniqueSlug("paper")).toBe("paper-2");
  });

  it("lets owners dismiss marker dirs and blocks other profiles", async () => {
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    const jobs = await import("@/lib/capture/jobs");
    jobs.writeCaptureJob({
      slug: "stuck",
      state: "failed",
      sourceUrl: "https://a.io/x.pdf",
      addedBy: "andres",
      startedAt: "2026-08-10T10:00:00.000Z",
      error: "x",
    });
    const papers = await import("@/lib/library/papers");
    expect(() => papers.discardInboxCapture("stuck", "guest")).toThrow(
      papers.CaptureOwnershipError,
    );
    papers.discardInboxCapture("stuck", "andres");
    expect(jobs.readCaptureJob("stuck")).toBeNull();
  });
});

describe("captureAsync", () => {
  it("returns immediately, then lands the paper with a done marker handle", async () => {
    await mockPipeline();
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    await createTestProfile("Andres");
    const { captureAsync } = await import("@/lib/capture");
    const jobs = await import("@/lib/capture/jobs");

    const { slug } = await captureAsync(
      "https://arxiv.org/abs/1706.03762",
      testProfileCapability("andres"),
    );
    expect(jobs.readCaptureJob(slug)?.state).toBe("analyzing");

    await waitFor(() => jobs.readCaptureJob(slug)?.state === "done");
    const done = jobs.readCaptureJob(slug);
    expect(done?.finalSlug).toBe("attention-is-all-you-need");
    const papers = await import("@/lib/library/papers");
    const paper = papers.getPaper(null, "attention-is-all-you-need");
    expect(paper?.meta.title).toBe(ANALYSIS.title);
    // The traveled marker must not make the real paper read as a job.
    expect(jobs.readCaptureJob("attention-is-all-you-need")).toBeNull();
  });

  it("keeps the polling handle at the provisional slug across the title rename", async () => {
    await mockPipeline();
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    await createTestProfile("Andres");
    const { capturePdf } = await import("@/lib/capture");
    const jobs = await import("@/lib/capture/jobs");

    // The async flow writes the marker, then runs capturePdf, then writes
    // "done" over it. In between, a status poll may land at any moment —
    // if the marker travels to the title slug with the renamed dir, the
    // poll reads "job vanished" and the UI reports a finishing capture lost.
    jobs.writeCaptureJob({
      slug: "2209-03416",
      state: "analyzing",
      sourceUrl: "https://arxiv.org/pdf/2209.03416",
      addedBy: "andres",
      startedAt: "2026-08-11T10:00:00.000Z",
    });
    const result = await capturePdf(Buffer.from("%PDF-1.4 fake"), {
      sourceUrl: "https://arxiv.org/pdf/2209.03416",
      username: "andres",
      capability: testProfileCapability("andres"),
      provisionalSlug: "2209-03416",
    });
    expect(result.slug).toBe("attention-is-all-you-need");
    expect(jobs.readCaptureJob("2209-03416")?.state).toBe("analyzing");
    expect(jobs.readCaptureJob(result.slug)).toBeNull();
  });

  it("dedupes a double-submit of the same URL while analyzing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockPipeline({
      download: async () => {
        await gate;
        return {
          bytes: Buffer.from("%PDF-1.4 fake"),
          finalUrl: "https://a.io/x.pdf",
          arxivId: null,
        };
      },
    });
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    await createTestProfile("Andres");
    const { captureAsync } = await import("@/lib/capture");
    const jobs = await import("@/lib/capture/jobs");

    const first = await captureAsync(
      "https://a.io/x.pdf",
      testProfileCapability("andres"),
    );
    const second = await captureAsync(
      "https://a.io/x.pdf",
      testProfileCapability("andres"),
    );
    expect(second.slug).toBe(first.slug);
    expect(jobs.readCaptureJob(first.slug)?.generation).toBe(
      testProfileCapability("andres").generation,
    );
    release();
    await waitFor(() => jobs.readCaptureJob(first.slug)?.state === "done");
    expect(jobs.readCaptureJob(first.slug)?.generation).toBe(
      testProfileCapability("andres").generation,
    );
  });

  it("records download failures as a failed marker with the real reason", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/capture/download")
    >("@/lib/capture/download");
    await mockPipeline({
      download: async () => {
        throw new actual.CaptureError("The publisher blocks downloads.");
      },
    });
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    await createTestProfile("Andres");
    const { captureAsync } = await import("@/lib/capture");
    const jobs = await import("@/lib/capture/jobs");

    const { slug } = await captureAsync(
      "https://paywall.example/x.pdf",
      testProfileCapability("andres"),
    );
    await waitFor(() => jobs.readCaptureJob(slug)?.state === "failed");
    expect(jobs.readCaptureJob(slug)?.error).toBe(
      "The publisher blocks downloads.",
    );
    // The failed marker dir holds no PDF.
    const dir = path.join(tmpDir, "library", "_inbox", slug);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
