import { describe, expect, it } from "vitest";
import {
  assembleSegments,
  boxesIntersect,
  mergeRectsIntoLines,
  positionAt,
} from "@/lib/pdf/text-layer-map";

const SEGMENTS = [
  { text: "(Yang", isBreak: false },
  { text: "", isBreak: true },
  { text: "et al. 2025b)", isBreak: false },
];

describe("assembleSegments", () => {
  it("joins text nodes with newlines at breaks so wrapped cites match", () => {
    const assembled = assembleSegments(SEGMENTS);
    expect(assembled.text).toBe("(Yang\net al. 2025b)");
    expect(assembled.spans).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 6 },
      { start: 6, end: 19 },
    ]);
  });
});

describe("positionAt", () => {
  const assembled = assembleSegments(SEGMENTS);

  it("maps interior offsets to their segment", () => {
    expect(positionAt(assembled, 1, "start")).toEqual({
      segment: 0,
      offset: 1,
    });
    expect(positionAt(assembled, 8, "start")).toEqual({
      segment: 2,
      offset: 2,
    });
  });

  it("biases boundary offsets into a text segment, never the break", () => {
    // Offset 5 is the break; a range start must land on the next text node
    // and a range end on the previous one.
    expect(positionAt(assembled, 6, "start")).toEqual({
      segment: 2,
      offset: 0,
    });
    expect(positionAt(assembled, 5, "end")).toEqual({ segment: 0, offset: 5 });
  });

  it("returns null out of bounds", () => {
    expect(positionAt(assembled, 99, "start")).toBeNull();
    expect(positionAt(assembled, 0, "end")).toBeNull();
  });
});

describe("mergeRectsIntoLines", () => {
  it("merges glyph rects on one line and keeps separate lines apart", () => {
    const merged = mergeRectsIntoLines([
      { left: 10, top: 100, width: 30, height: 12 },
      { left: 42, top: 101, width: 20, height: 11 },
      { left: 10, top: 120, width: 50, height: 12 },
      { left: 0, top: 0, width: 0, height: 12 },
    ]);
    expect(merged).toEqual([
      { left: 10, top: 100, width: 52, height: 12 },
      { left: 10, top: 120, width: 50, height: 12 },
    ]);
  });
});

describe("boxesIntersect", () => {
  it("detects overlap and rejects mere adjacency", () => {
    const box = { left: 0, top: 0, width: 10, height: 10 };
    expect(
      boxesIntersect(box, { left: 5, top: 5, width: 10, height: 10 }),
    ).toBe(true);
    expect(
      boxesIntersect(box, { left: 10, top: 0, width: 10, height: 10 }),
    ).toBe(false);
  });
});
