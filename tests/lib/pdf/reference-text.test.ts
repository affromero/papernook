import { describe, expect, it } from "vitest";
import { referenceTextAtPoint } from "@/lib/pdf/reference-text";

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

  it("ignores clicks above every marker and in other columns", () => {
    expect(
      referenceTextAtPoint(CHUNKS, { x: 200, y: 560 }, PAGE_WIDTH),
    ).toBeNull();
    expect(
      referenceTextAtPoint(CHUNKS, { x: 500, y: 456 }, PAGE_WIDTH),
    ).toBeNull();
  });
});
