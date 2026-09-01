import { describe, expect, it } from "vitest";
import {
  ASK_BUTTON_HEIGHT,
  ASK_BUTTON_WIDTH,
  ASK_GAP,
  SELECTION_MAX_CHARS,
  placeSelectionAsk,
  selectionPrompt,
} from "../../../src/components/pdf/selection/selectionAsk";

const stage = { top: 100, left: 50, width: 1000, height: 800 };

function inside(box: { top: number; left: number }): boolean {
  return (
    box.top >= 0 &&
    box.left >= 0 &&
    box.top + ASK_BUTTON_HEIGHT <= stage.height &&
    box.left + ASK_BUTTON_WIDTH <= stage.width
  );
}

describe("selectionPrompt", () => {
  it("quotes the passage on one line and asks about the page", () => {
    const prompt = selectionPrompt(
      "We   propose a\nnovel method\n  for  parsing.",
      7,
    );
    expect(prompt).toBe(
      "> We propose a novel method for parsing.\n\n(p. 7) Explain this passage.",
    );
  });

  it("cuts a long passage at the limit and marks the cut", () => {
    const prompt = selectionPrompt("word ".repeat(1000), 2);
    const quoted = prompt.split("\n\n")[0] ?? "";
    expect(quoted.startsWith("> word word")).toBe(true);
    expect(quoted.endsWith("…")).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(SELECTION_MAX_CHARS + 3);
    expect(prompt.endsWith("(p. 2) Explain this passage.")).toBe(true);
  });
});

describe("placeSelectionAsk", () => {
  it("floats centred just under a selection with room below", () => {
    const range = { top: 300, left: 400, width: 200, height: 20 };
    const placed = placeSelectionAsk(range, stage);
    expect(placed.top).toBe(300 - 100 + 20 + ASK_GAP);
    expect(placed.left).toBe(400 - 50 + 100 - ASK_BUTTON_WIDTH / 2);
    expect(inside(placed)).toBe(true);
  });

  it("flips above a selection at the bottom of the stage", () => {
    const range = { top: 100 + 800 - 25, left: 400, width: 200, height: 20 };
    const placed = placeSelectionAsk(range, stage);
    expect(placed.top + ASK_BUTTON_HEIGHT).toBeLessThan(800 - 25);
    expect(inside(placed)).toBe(true);
  });

  it("stays inside the stage for selections hugging either edge", () => {
    const leftEdge = placeSelectionAsk(
      { top: 200, left: 50, width: 10, height: 20 },
      stage,
    );
    const rightEdge = placeSelectionAsk(
      { top: 200, left: 50 + 995, width: 10, height: 20 },
      stage,
    );
    expect(leftEdge.left).toBe(ASK_GAP);
    expect(rightEdge.left).toBe(1000 - ASK_BUTTON_WIDTH - ASK_GAP);
    expect(inside(leftEdge)).toBe(true);
    expect(inside(rightEdge)).toBe(true);
  });

  it("never leaves a stage too short for either side", () => {
    const short = { ...stage, height: 40 };
    const placed = placeSelectionAsk(
      { top: 100, left: 100, width: 50, height: 20 },
      short,
    );
    expect(placed.top).toBe(ASK_GAP);
  });
});
