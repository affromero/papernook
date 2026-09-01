import { describe, expect, it } from "vitest";
import {
  NOTE_LINE_HEIGHT,
  NOTE_WIDTH,
  firstLocator,
  marginNoteText,
  noteRect,
  wrapNote,
} from "@/lib/chat/margin-note";

// Everything pdf.js's Helvetica/WinAnsi appearance builder can encode.
function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0xff) ||
    "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".includes(char)
  );
}

describe("marginNoteText", () => {
  it("strips markdown down to the words a reader would jot in a margin", () => {
    const text = marginNoteText(
      [
        "## Key idea",
        "",
        "The paper **splats** *Gaussians* with a `tile` rasterizer ([code](https://x.y/z)).",
        "",
        "- first point",
        "- second point",
        "",
        "```python",
        "x = 1",
        "```",
        "> quoted line",
      ].join("\n"),
    );
    expect(text).toBe(
      [
        "Key idea",
        "",
        "The paper splats Gaussians with a tile rasterizer (code).",
        "",
        "- first point",
        "- second point",
        "",
        "x = 1",
        "",
        "quoted line",
      ].join("\n"),
    );
  });

  it("flattens typography and drops what WinAnsi cannot encode", () => {
    const text = marginNoteText(
      "Loss ≤ 0.5 — “fast” → con\u00adverges… α-blend uses x ≥ y and café naïve",
    );
    expect(text).toBe(
      'Loss <= 0.5 - "fast" -> converges... -blend uses x >= y and café naïve',
    );
    expect(Array.from(text).every(isWinAnsi)).toBe(true);
    expect(text).not.toContain("\u00ad");
  });

  it("removes HTML tags but keeps inline inequalities", () => {
    expect(
      marginNoteText('x<sup>2</sup><br/>see <a href="https://x.y">it</a>'),
    ).toBe("x2see it");
    expect(marginNoteText("holds if a<b and c>d, and x < y > z")).toBe(
      "holds if a<b and c>d, and x < y > z",
    );
  });
});

describe("wrapNote", () => {
  it("wraps on words within the column and keeps paragraph breaks", () => {
    const lines = wrapNote(
      "The quick brown fox jumps over the lazy dog again\n\nSecond paragraph",
      20,
      10,
    );
    expect(lines).toEqual([
      "The quick brown fox",
      "jumps over the lazy",
      "dog again",
      "",
      "Second paragraph",
    ]);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
  });

  it("splits words longer than a line instead of overflowing it", () => {
    expect(
      wrapNote("see https://example.org/a/very/long/path", 12, 10),
    ).toEqual(["see", "https://exam", "ple.org/a/ve", "ry/long/path"]);
  });

  it("caps the line count and ends a truncated note with an ellipsis", () => {
    const lines = wrapNote("word ".repeat(200).trim(), 30, 5);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toMatch(/\.\.\.$/);
    expect(lines.every((line) => line.length <= 30)).toBe(true);
  });
});

describe("noteRect", () => {
  const letter: [number, number, number, number] = [0, 0, 612, 792];

  it("hugs the right margin below the top edge and sizes to the lines", () => {
    const [x1, y1, x2, y2] = noteRect(letter, 4);
    expect(x2 - x1).toBe(NOTE_WIDTH);
    expect(x2).toBeLessThan(612);
    expect(x2).toBeGreaterThan(612 - 30);
    expect(y2).toBeLessThan(792);
    expect(y2 - y1).toBeCloseTo(4 * NOTE_LINE_HEIGHT, 1);
  });

  it("top-aligns with a destination and stays inside the page", () => {
    const [, y1, , y2] = noteRect(letter, 3, 400);
    expect(y2).toBe(400);
    expect(y1).toBeCloseTo(400 - 3 * NOTE_LINE_HEIGHT, 1);

    const [, low1, , low2] = noteRect(letter, 10, 40);
    expect(low1).toBeGreaterThanOrEqual(0);
    expect(low2).toBeGreaterThan(low1);
    expect(low2).toBeLessThanOrEqual(792);

    const [, tall1, , tall2] = noteRect(letter, 500);
    expect(tall1).toBeGreaterThanOrEqual(0);
    expect(tall2).toBeLessThanOrEqual(792);
  });

  it("respects a page whose origin is not at zero", () => {
    const [x1, y1, x2, y2] = noteRect([20, 30, 500, 700], 2);
    expect(x1).toBeGreaterThanOrEqual(20);
    expect(x2).toBeLessThanOrEqual(500);
    expect(y1).toBeGreaterThanOrEqual(30);
    expect(y2).toBeLessThanOrEqual(700);
  });
});

describe("firstLocator", () => {
  it("picks the first in-paper reference an answer mentions", () => {
    expect(
      firstLocator("As Figure 3 and Section 2.1 show, the loss drops."),
    ).toEqual({ kind: "figure", label: "3" });
    expect(firstLocator("No locators here, see [12].")).toBeNull();
  });
});
