import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { PaperMeta } from "@/lib/library/papers";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-rev-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("@/lib/auth/session");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function meta(overrides: Partial<PaperMeta> = {}): PaperMeta {
  return {
    title: "Synced Paper",
    authors: ["A"],
    year: 2024,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: "https://example.org",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
    needsReview: true,
    ...overrides,
  };
}

async function fileTestPaper(topic: string, slug: string): Promise<void> {
  const papers = await import("@/lib/library/papers");
  papers.writeMeta(topic, slug, meta());
  const pdf = papers.pdfPath(topic, slug);
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4 fake pdf");
}

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/papers/review", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("confirmed-paper move + review", () => {
  it("movePaper relocates pdf, exercises pdf, and companion dir", async () => {
    await fileTestPaper("topic-a", "paper-x");
    const papers = await import("@/lib/library/papers");
    fs.writeFileSync(papers.exercisesPdfPath("topic-a", "paper-x"), "%PDF ex");

    const moved = papers.movePaper("topic-a", "paper-x", "topic-b");
    expect(moved.topic).toBe("topic-b");
    expect(fs.existsSync(papers.pdfPath("topic-b", "paper-x"))).toBe(true);
    expect(fs.existsSync(papers.exercisesPdfPath("topic-b", "paper-x"))).toBe(
      true,
    );
    expect(papers.getPaper("topic-a", "paper-x")).toBeNull();
    expect(papers.getPaper("topic-b", "paper-x")?.meta.title).toBe(
      "Synced Paper",
    );
  });

  it("movePaper rejects unsafe slugs and missing papers", async () => {
    const papers = await import("@/lib/library/papers");
    expect(() => papers.movePaper("topic-a", "../../etc", "topic-b")).toThrow();
    expect(() => papers.movePaper("topic-a", "ghost", "topic-b")).toThrow(
      /No paper/,
    );
  });

  it("review route keeps or re-files and clears the flag", async () => {
    await fileTestPaper("topic-a", "keep-me");
    await fileTestPaper("topic-a", "move-me");
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => ({ username: "andres" }),
    }));
    const route = await import("@/app/api/v1/papers/review/route");

    const keep = await route.PATCH(
      patchRequest({ topic: "topic-a", slug: "keep-me" }),
    );
    expect(keep.status).toBe(200);
    const papers = await import("@/lib/library/papers");
    expect(papers.getPaper("topic-a", "keep-me")?.meta.needsReview).toBe(
      undefined,
    );

    const move = await route.PATCH(
      patchRequest({ topic: "topic-a", slug: "move-me", moveTo: "topic-b" }),
    );
    expect(move.status).toBe(200);
    expect(papers.getPaper("topic-b", "move-me")?.meta.needsReview).toBe(
      undefined,
    );
    expect(papers.getPaper("topic-a", "move-me")).toBeNull();

    // The rebuilt index no longer flags anything.
    const { allIndexed } = await import("@/lib/library/index-db");
    expect(allIndexed().filter((p) => p.needsReview)).toHaveLength(0);
  });

  it("review route rejects anonymous and malformed requests", async () => {
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => null,
    }));
    const route = await import("@/app/api/v1/papers/review/route");
    expect(
      (await route.PATCH(patchRequest({ topic: "a", slug: "b" }))).status,
    ).toBe(401);

    vi.doUnmock("@/lib/auth/session");
    vi.resetModules();
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => ({ username: "andres" }),
    }));
    const authed = await import("@/app/api/v1/papers/review/route");
    expect(
      (
        await authed.PATCH(
          patchRequest({ topic: "topic-a", slug: "../escape" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await authed.PATCH(patchRequest({ topic: "topic-a", slug: "ghost" })))
        .status,
    ).toBe(404);
  });
});
