import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-ctx-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("@/lib/auth/session");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function placePaper(
  topic: string | null,
  slug: string,
  title: string,
  text: string,
  addedBy = "andres",
) {
  const papers = await import("@/lib/library/papers");
  const dataDir = await import("@/lib/data-dir");
  dataDir.ensureDataDirs();
  papers.writeMeta(topic, slug, {
    title,
    authors: ["Ada"],
    year: 2024,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: `https://example.com/${slug}.pdf`,
    addedAt: new Date().toISOString(),
    addedBy,
  });
  papers.writeText(topic, slug, text);
  papers.writeSummary(topic, slug, `${title} summary line.`);
  const pdf = papers.pdfPath(topic, slug);
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4");
}

describe("relatedLibraryContext", () => {
  it("lists relevant confirmed papers but never another profile's inbox", async () => {
    await placePaper("ml", "focus", "Focus Paper", "gaussian splatting text");
    await placePaper("ml", "cousin", "Gaussian Cousins", "gaussian splatting");
    await placePaper(
      null,
      "secret",
      "Gaussian Secret",
      "gaussian splatting",
      "ana",
    );
    const { rebuildIndex } = await import("@/lib/library/index-db");
    rebuildIndex();
    const papers = await import("@/lib/library/papers");
    const { relatedLibraryContext } =
      await import("@/lib/library/context/related");
    const paper = papers.getPaper("ml", "focus");
    if (!paper) throw new Error("missing focus paper");

    const context = relatedLibraryContext(
      paper,
      "gaussian splatting",
      "andres",
    );
    expect(context).toContain("Gaussian Cousins");
    expect(context).not.toContain("Gaussian Secret");
    expect(context).not.toContain("Focus Paper"); // never lists itself
  });
});

describe("findPaperByReference", () => {
  it("matches only when the reference contains most of a title", async () => {
    await placePaper(
      "ml",
      "splat-mcmc",
      "3D Gaussian Splatting as Markov Chain Monte Carlo",
      "full text",
    );
    const { rebuildIndex } = await import("@/lib/library/index-db");
    rebuildIndex();
    const { findPaperByReference } =
      await import("@/lib/library/context/reference-match");
    expect(
      findPaperByReference(
        "Kheradmand, S., et al.: 3D Gaussian splatting as Markov chain Monte Carlo. NeurIPS (2024)",
      )?.slug,
    ).toBe("splat-mcmc");
    expect(
      findPaperByReference(
        "Kerbl, B.: Some entirely different gaussian paper. TOG (2023)",
      ),
    ).toBeNull();
  });
});

describe("citations match route", () => {
  it("gates on session and resolves references conservatively", async () => {
    await placePaper("ml", "splat-mcmc", "Gaussian Splatting Dynamics", "text");
    const { rebuildIndex } = await import("@/lib/library/index-db");
    rebuildIndex();
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => null,
    }));
    let route = await import("@/app/api/v1/citations/match/route");
    const url = (q: string) =>
      new NextRequest(
        `http://localhost/api/v1/citations/match?q=${encodeURIComponent(q)}`,
      );
    expect(
      (await route.GET(url("Gaussian Splatting Dynamics 2024"))).status,
    ).toBe(401);

    vi.doUnmock("@/lib/auth/session");
    vi.resetModules();
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => ({ username: "andres" }),
    }));
    route = await import("@/app/api/v1/citations/match/route");
    const hit = await route.GET(
      url("Author, A.: Gaussian splatting dynamics. Venue (2024)"),
    );
    expect(((await hit.json()) as { match: { slug: string } }).match.slug).toBe(
      "splat-mcmc",
    );
    const miss = await route.GET(url("Totally unrelated citation text here"));
    expect(((await miss.json()) as { match: null }).match).toBeNull();
    expect((await route.GET(url("short"))).status).toBe(400);
  });
});
