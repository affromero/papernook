import { describe, expect, it } from "vitest";
import {
  PREVIEW_GAP,
  PREVIEW_HEIGHT,
  placePreview,
} from "../../../src/components/pdf/placePreview";

const bounds = { top: 100, left: 0, width: 1000, height: 800 } as DOMRect;

function covers(top: number, y: number): boolean {
  return top <= y && y <= top + PREVIEW_HEIGHT;
}

describe("placePreview", () => {
  it("opens below a line near the top without covering it", () => {
    const { top } = placePreview({ clientX: 10, clientY: 150 }, bounds);
    expect(covers(top, 50)).toBe(false);
    expect(top).toBeGreaterThan(50);
  });

  it("opens above a line in the middle, where below would not fit", () => {
    const y = 500;
    const { top } = placePreview({ clientX: 10, clientY: 100 + y }, bounds);
    expect(covers(top, y)).toBe(false);
    expect(top + PREVIEW_HEIGHT).toBeLessThan(y);
  });

  it("clamps to the viewer top when nothing fits", () => {
    const short = { ...bounds, height: 300 } as DOMRect;
    const { top } = placePreview({ clientX: 10, clientY: 250 }, short);
    expect(top).toBe(PREVIEW_GAP);
  });

  it("picks the side away from the pointer", () => {
    expect(
      placePreview({ clientX: 100, clientY: 150 }, bounds).horizontal,
    ).toBe("left");
    expect(
      placePreview({ clientX: 900, clientY: 150 }, bounds).horizontal,
    ).toBe("right");
  });
});
