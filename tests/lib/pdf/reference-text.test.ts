import { describe, expect, it } from "vitest";
import {
  referenceEntryAtPoint,
  referenceTextAtPoint,
} from "@/lib/pdf/reference-text";

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
