import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-exp-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A real 2-page PDF with content at known coordinates + an annotation. */
async function placeRealPaper(): Promise<string> {
  const { ensureDataDirs } = await import("@/lib/data-dir");
  ensureDataDirs();
  const papers = await import("@/lib/library/papers");
  papers.writeMeta("nlp", "attention", {
    title: "T",
    authors: [],
    year: null,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: "https://x",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
  });
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([595, 842]);
  p1.drawText("content", { x: 100, y: 700, size: 12 });
  p1.drawRectangle({
    x: 50,
    y: 50,
    width: 20,
    height: 20,
    color: rgb(1, 0, 0),
  });
  doc.addPage([595, 842]);
  const pdfPath = papers.pdfPath("nlp", "attention");
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  fs.writeFileSync(pdfPath, await doc.save());
  // Age the file past the recent-write guard.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(pdfPath, old, old);
  return pdfPath;
}

describe("PDF expansion", () => {
  it("margin mode widens every page to the right, origin fixed, pages unchanged", async () => {
    const pdfPath = await placeRealPaper();
    const { expandPdf } = await import("@/lib/library/expand");
    const before = await PDFDocument.load(fs.readFileSync(pdfPath));
    const beforeBox = before.getPage(0).getMediaBox();

    const result = await expandPdf("nlp", "attention", "margin");
    expect(result.pages).toBe(2);

    const after = await PDFDocument.load(fs.readFileSync(pdfPath));
    expect(after.getPageCount()).toBe(2);
    const box = after.getPage(0).getMediaBox();
    expect(box.x).toBe(beforeBox.x); // origin never shifts
    expect(box.y).toBe(beforeBox.y);
    expect(box.width).toBe(beforeBox.width + 200);
    expect(box.height).toBe(beforeBox.height);
  });

  it("page mode appends one blank page matching the last page size", async () => {
    const pdfPath = await placeRealPaper();
    const { expandPdf } = await import("@/lib/library/expand");
    const result = await expandPdf("nlp", "attention", "page");
    expect(result.pages).toBe(3);
    const after = await PDFDocument.load(fs.readFileSync(pdfPath));
    expect(after.getPage(2).getSize()).toEqual({ width: 595, height: 842 });
  });

  it("refuses when the file was written seconds ago (iPad mid-save guard)", async () => {
    const pdfPath = await placeRealPaper();
    fs.utimesSync(pdfPath, new Date(), new Date()); // just touched
    const { expandPdf, ExpandError } = await import("@/lib/library/expand");
    await expect(expandPdf("nlp", "attention", "margin")).rejects.toThrow(
      ExpandError,
    );
  });
});
