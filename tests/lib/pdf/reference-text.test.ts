import { describe, expect, it } from "vitest";
import {
  locatorLinesAtPoint,
  referenceEntryAtPoint,
  referenceTextAtPoint,
} from "@/lib/pdf/reference-text";
import pixworldRefs from "./fixtures/pixworld-refs.json";

const PAGE_WIDTH = 612;

// A single-column bibliography: entry [18] spans two lines, [19] follows.
const CHUNKS = [
  { str: "[17]", x: 72, y: 500 },
  { str: "Jin, C.: How to escape saddle points. ICML (2017)", x: 100, y: 500 },
  { str: "[18]", x: 72, y: 470 },
  {
    str: "Jin, C., Netrapalli, P.: On nonconvex optimization for",
    x: 100,
    y: 470,
  },
  { str: "machine learning. Journal of the ACM 68(2) (2021)", x: 100, y: 455 },
  { str: "[19]", x: 72, y: 425 },
  { str: "Kerbl, B.: 3d gaussian splatting. ACM TOG (2023)", x: 100, y: 425 },
];

describe("referenceTextAtPoint", () => {
  it("returns the whole clicked entry, joined across its lines", () => {
    const text = referenceTextAtPoint(CHUNKS, { x: 200, y: 456 }, PAGE_WIDTH);
    expect(text).toBe(
      "Jin, C., Netrapalli, P.: On nonconvex optimization for machine learning. Journal of the ACM 68(2) (2021)",
    );
  });

  it("bounds the entry at the next marker instead of bleeding into it", () => {
    const text = referenceTextAtPoint(CHUNKS, { x: 200, y: 425 }, PAGE_WIDTH);
    expect(text).toContain("gaussian splatting");
    expect(text).not.toContain("nonconvex");
  });

  it("boxes every line of the entry, in reading order", () => {
    const entry = referenceEntryAtPoint(CHUNKS, { x: 200, y: 456 }, PAGE_WIDTH);
    expect(entry?.boxes).toHaveLength(2);
    const [first, second] = entry?.boxes ?? [];
    expect(first?.y).toBeGreaterThan(second?.y ?? 0);
    expect(first?.width).toBeGreaterThan(0);
    expect(first?.height).toBeGreaterThan(0);
    // The marker column is covered too, so the highlight starts at [18].
    expect(first?.x).toBeLessThanOrEqual(72);
  });

  it("never widens a box across the gutter into the next column", () => {
    // Two columns whose lines share y coordinates, as printed pages do.
    const chunks = [];
    for (let row = 0; row < 6; row += 1) {
      const y = 500 - row * 12;
      chunks.push({ str: `[${row + 1}]`, x: 72, y, width: 16 });
      chunks.push({
        str: `Left entry ${row}. ICML (2017)`,
        x: 100,
        y,
        width: 150,
      });
      chunks.push({ str: `[${row + 7}]`, x: 340, y, width: 16 });
      chunks.push({
        str: `Right entry ${row}. ICML (2018)`,
        x: 368,
        y,
        width: 150,
      });
    }
    const entry = referenceEntryAtPoint(chunks, { x: 150, y: 476 }, PAGE_WIDTH);
    expect(entry?.text).toContain("Left entry 2");
    for (const box of entry?.boxes ?? []) {
      expect(box.x + box.width).toBeLessThanOrEqual(340);
    }
  });

  it("ignores clicks above every marker and in other columns", () => {
    expect(
      referenceTextAtPoint(CHUNKS, { x: 200, y: 560 }, PAGE_WIDTH),
    ).toBeNull();
    expect(
      referenceTextAtPoint(CHUNKS, { x: 500, y: 456 }, PAGE_WIDTH),
    ).toBeNull();
  });
});

// An author-year bibliography without markers or hanging indent (AAAI
// style): entries separated only by slightly larger vertical gaps.
const AUTHOR_YEAR_CHUNKS = [
  { str: "References", x: 140, y: 320 },
  {
    str: "Bansal, H.; and Grover, A. 2025. VideoPhy: Evaluating",
    x: 54,
    y: 300,
  },
  { str: "Physical Commonsense for Video Generation. In ICLR,", x: 54, y: 289 },
  { str: "volume 2025, 102075–102121.", x: 54, y: 278 },
  {
    str: "Bian, Y.; and Xu, Q. 2025. VideoPainter: Video Inpainting",
    x: 54,
    y: 263,
  },
  { str: "and Editing with Plug-and-Play Context Control. In", x: 54, y: 252 },
  { str: "SIGGRAPH Conference Papers.", x: 54, y: 241 },
  { str: "Guan, H.; and Lau, R. W. 2022. Learning Semantic", x: 54, y: 226 },
  {
    str: "Associations for Mirror Detection. In CVPR, 5941–5950.",
    x: 54,
    y: 215,
  },
];

describe("referenceTextAtPoint (author-year)", () => {
  it("returns the clicked entry bounded by its neighbors", () => {
    const text = referenceTextAtPoint(
      AUTHOR_YEAR_CHUNKS,
      { x: 200, y: 252 },
      PAGE_WIDTH,
    );
    expect(text).toBe(
      "Bian, Y.; and Xu, Q. 2025. VideoPainter: Video Inpainting and Editing with Plug-and-Play Context Control. In SIGGRAPH Conference Papers.",
    );
  });

  it("does not bleed the previous or next entry into the result", () => {
    const text = referenceTextAtPoint(
      AUTHOR_YEAR_CHUNKS,
      { x: 200, y: 300 },
      PAGE_WIDTH,
    );
    expect(text).toContain("VideoPhy");
    expect(text).not.toContain("VideoPainter");
  });
});

// arXiv PixWorld, references page 11: two Gao entries back to back (Ruiqi
// Gao 2024 at y=377.6, Sensen Gao 2026 at y=335.6). hyperref points its
// GoTo destination at the TOP of the cited entry's first line — y=346.6 for
// the Sensen entry — which sits in the gap below the previous entry's last
// baseline (355.7), so "nearest start above the point" lands one entry high.
describe("hyperref destinations", () => {
  const PIXWORLD = pixworldRefs.find((page) => page.pageNumber === 11)! as {
    pageNumber: number;
    pageWidth: number;
    chunks: { str: string; x: number; y: number; width?: number }[];
  };

  it("resolves the entry the destination points into, not the one above", () => {
    const entry = referenceEntryAtPoint(
      PIXWORLD.chunks,
      // ReferencePreview probes at destination.left + 15, destination.top - 6.
      { x: 83.093 + 15, y: 346.608 - 6 },
      PIXWORLD.pageWidth,
    );
    expect(entry?.text).toContain("Sensen Gao");
    expect(entry?.text).toContain("2026");
    expect(entry?.text).not.toContain("Ruiqi Gao");
  });

  it("still resolves an entry probed at its own baseline", () => {
    const entry = referenceEntryAtPoint(
      PIXWORLD.chunks,
      { x: 108 + 15, y: 377.6 + 2 },
      PIXWORLD.pageWidth,
    );
    expect(entry?.text).toContain("Ruiqi Gao");
    expect(entry?.text).toContain("Cat3d");
  });
});

// A body page: a section heading, a paragraph, then a two-line figure
// caption followed (after a paragraph gap) by more body text. hyperref
// anchors point at the TOP of the heading/caption line, and
// ReferencePreview probes at (left + 15, top - 6).
const BODY_CHUNKS = [
  { str: "2", x: 72, y: 700, width: 6 },
  { str: "Method", x: 86, y: 700, width: 40 },
  {
    str: "We describe the pipeline in three stages.",
    x: 72,
    y: 680,
    width: 200,
  },
  {
    str: "Each stage refines the previous estimate.",
    x: 72,
    y: 668,
    width: 200,
  },
  {
    str: "Figure 3: Qualitative results on the held-out",
    x: 72,
    y: 420,
    width: 210,
  },
  {
    str: "split. Rows show inputs, ours, and ground truth.",
    x: 72,
    y: 409,
    width: 210,
  },
  {
    str: "Section 3 evaluates the method on two datasets",
    x: 72,
    y: 380,
    width: 210,
  },
  { str: "and reports ablations over each stage.", x: 72, y: 368, width: 200 },
  {
    str: "Right column body text at the caption height.",
    x: 340,
    y: 420,
    width: 200,
  },
  { str: "More right column text below it.", x: 340, y: 409, width: 200 },
  // Column detection needs a few line starts per column, as real pages have.
  { str: "And a third right column line.", x: 340, y: 398, width: 200 },
];

describe("locatorLinesAtPoint", () => {
  it("returns just the heading line for a section destination", () => {
    const hit = locatorLinesAtPoint(
      BODY_CHUNKS,
      { x: 72 + 15, y: 712 - 6 },
      PAGE_WIDTH,
      { multiline: false },
    );
    expect(hit?.text).toBe("2 Method");
    expect(hit?.boxes).toHaveLength(1);
    expect(hit?.boxes[0]?.y).toBeLessThan(700);
    expect(
      (hit?.boxes[0]?.y ?? 0) + (hit?.boxes[0]?.height ?? 0),
    ).toBeGreaterThan(700);
  });

  it("joins a wrapped caption but stops at the paragraph gap below it", () => {
    const hit = locatorLinesAtPoint(
      BODY_CHUNKS,
      { x: 72 + 15, y: 430 - 6 },
      PAGE_WIDTH,
      { multiline: true },
    );
    expect(hit?.text).toBe(
      "Figure 3: Qualitative results on the held-out split. Rows show inputs, ours, and ground truth.",
    );
    expect(hit?.boxes).toHaveLength(2);
    // Right-column text sits at the same baselines; boxes stop at the gutter.
    for (const box of hit?.boxes ?? []) {
      expect(box.x + box.width).toBeLessThanOrEqual(340);
    }
  });

  it("finds a centred one-line caption from an anchor at the column base", () => {
    // LaTeX centres a caption that fits on one line, while hyperref's anchor
    // for the float records the column's left edge.
    const chunks = [
      { str: "Body line one.", x: 72, y: 500, width: 100 },
      { str: "Body line two.", x: 72, y: 488, width: 100 },
      { str: "Body line three.", x: 72, y: 476, width: 100 },
      { str: "Figure 3: Results.", x: 130, y: 440, width: 90 },
      { str: "Body resumes after the figure.", x: 72, y: 410, width: 150 },
      { str: "And continues at the usual pitch.", x: 72, y: 398, width: 150 },
    ];
    const hit = locatorLinesAtPoint(
      chunks,
      { x: 72 + 15, y: 450 - 6 },
      PAGE_WIDTH,
      { multiline: true },
    );
    expect(hit?.text).toBe("Figure 3: Results.");
    expect(hit?.boxes).toHaveLength(1);
    expect(hit?.boxes[0]?.x).toBeCloseTo(129);
  });

  it("stops a table caption before the rows that follow at body pitch", () => {
    const chunks = [
      { str: "Table 2: Ablation over stages.", x: 72, y: 440, width: 150 },
      { str: "Stage", x: 72, y: 428, width: 25 },
      { str: "PSNR", x: 150, y: 428, width: 25 },
      { str: "SSIM", x: 220, y: 428, width: 25 },
      { str: "One", x: 72, y: 416, width: 20 },
      { str: "31.2", x: 150, y: 416, width: 20 },
      { str: "0.91", x: 220, y: 416, width: 20 },
      { str: "Two", x: 72, y: 404, width: 20 },
      { str: "32.0", x: 150, y: 404, width: 20 },
      { str: "0.93", x: 220, y: 404, width: 20 },
    ];
    const hit = locatorLinesAtPoint(
      chunks,
      { x: 72 + 15, y: 450 - 6 },
      PAGE_WIDTH,
      { multiline: true },
    );
    expect(hit?.text).toBe("Table 2: Ablation over stages.");
    expect(hit?.boxes).toHaveLength(1);
  });

  it("stops a table caption before rows that start at a different x", () => {
    const chunks = [
      { str: "Body line one.", x: 72, y: 476, width: 100 },
      { str: "Body line two.", x: 72, y: 464, width: 100 },
      { str: "Table 2: Ablation over stages.", x: 72, y: 440, width: 150 },
      { str: "Stage 1 31.2 dB 0.91", x: 100, y: 428, width: 120 },
      { str: "Stage 2 32.0 dB 0.93", x: 100, y: 416, width: 120 },
      { str: "Stage 3 32.4 dB 0.94", x: 100, y: 404, width: 120 },
    ];
    const hit = locatorLinesAtPoint(
      chunks,
      { x: 72 + 15, y: 450 - 6 },
      PAGE_WIDTH,
      { multiline: true },
    );
    expect(hit?.text).toBe("Table 2: Ablation over stages.");
    expect(hit?.boxes).toHaveLength(1);
  });

  it("joins a full-width caption across the gutter of a two-column page", () => {
    const chunks = [
      { str: "Left body line one.", x: 72, y: 700, width: 200 },
      { str: "Left body line two.", x: 72, y: 688, width: 200 },
      { str: "Left body line three.", x: 72, y: 676, width: 200 },
      { str: "Right body line one.", x: 340, y: 700, width: 200 },
      { str: "Right body line two.", x: 340, y: 688, width: 200 },
      { str: "Right body line three.", x: 340, y: 676, width: 200 },
      // A figure* caption: the left part runs into the gutter, the rest
      // lands past the right column's base.
      { str: "Figure 4: Full-width results across", x: 72, y: 420, width: 262 },
      { str: "all datasets and baselines, with", x: 342, y: 420, width: 190 },
      { str: "the strongest baseline in bold.", x: 72, y: 409, width: 160 },
    ];
    const hit = locatorLinesAtPoint(
      chunks,
      { x: 72 + 15, y: 430 - 6 },
      PAGE_WIDTH,
      { multiline: true },
    );
    expect(hit?.text).toBe(
      "Figure 4: Full-width results across all datasets and baselines, with the strongest baseline in bold.",
    );
    expect(hit?.boxes).toHaveLength(2);
    const [wide, ragged] = hit?.boxes ?? [];
    expect((wide?.x ?? 0) + (wide?.width ?? 0)).toBeGreaterThanOrEqual(532);
    expect((ragged?.x ?? 0) + (ragged?.width ?? 0)).toBeLessThan(340);
  });

  it("keeps a single-line caption single when body text follows a paragraph gap", () => {
    const chunks = [
      { str: "Body line one.", x: 72, y: 500, width: 100 },
      { str: "Body line two.", x: 72, y: 488, width: 100 },
      { str: "Body line three.", x: 72, y: 476, width: 100 },
      { str: "Table 1: Dataset statistics.", x: 72, y: 440, width: 150 },
      { str: "Body resumes after the table.", x: 72, y: 410, width: 150 },
      { str: "And continues at the usual pitch.", x: 72, y: 398, width: 150 },
    ];
    const hit = locatorLinesAtPoint(
      chunks,
      { x: 72 + 15, y: 450 - 6 },
      PAGE_WIDTH,
      { multiline: true },
    );
    expect(hit?.text).toBe("Table 1: Dataset statistics.");
  });

  it("returns null for a point far below the column's last line", () => {
    expect(
      locatorLinesAtPoint(BODY_CHUNKS, { x: 100, y: 200 }, PAGE_WIDTH, {
        multiline: true,
      }),
    ).toBeNull();
  });
});
