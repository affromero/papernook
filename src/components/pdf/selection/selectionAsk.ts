/**
 * Pure helpers behind "Ask about selection": the chat prompt built from a
 * text-layer selection and the placement of the floating button beside it.
 */

/** Longest passage quoted into the chat; longer selections are cut. */
export const SELECTION_MAX_CHARS = 1500;

/** Rendered footprint of the button (padding + label), for clamping. */
export const ASK_BUTTON_WIDTH = 176;
export const ASK_BUTTON_HEIGHT = 34;
/** Clearance between the selection and the button, and from the edges. */
export const ASK_GAP = 8;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Quote the selected passage and ask the chat to explain it. pdf.js text
 * layers break lines into spans, so the raw selection carries stray
 * newlines and runs of spaces; collapse them before quoting.
 */
export function selectionPrompt(text: string, page: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const quoted =
    collapsed.length > SELECTION_MAX_CHARS
      ? `${collapsed.slice(0, SELECTION_MAX_CHARS).trimEnd()}…`
      : collapsed;
  return `> ${quoted}\n\n(p. ${page}) Explain this passage.`;
}

/**
 * Place the button centred under the selection, above it when the stage
 * has no room below, and always inside the stage box. Coordinates are
 * relative to the stage, which positions the button absolutely.
 */
export function placeSelectionAsk(
  rangeRect: Box,
  stageRect: Box,
): { top: number; left: number } {
  const selectionTop = rangeRect.top - stageRect.top;
  const selectionBottom = selectionTop + rangeRect.height;
  const below = selectionBottom + ASK_GAP;
  const fitsBelow = below + ASK_BUTTON_HEIGHT + ASK_GAP <= stageRect.height;
  const above = selectionTop - ASK_GAP - ASK_BUTTON_HEIGHT;
  const maxTop = Math.max(
    ASK_GAP,
    stageRect.height - ASK_BUTTON_HEIGHT - ASK_GAP,
  );
  const top = Math.min(maxTop, Math.max(ASK_GAP, fitsBelow ? below : above));

  const centre = rangeRect.left - stageRect.left + rangeRect.width / 2;
  const maxLeft = Math.max(
    ASK_GAP,
    stageRect.width - ASK_BUTTON_WIDTH - ASK_GAP,
  );
  const left = Math.min(
    maxLeft,
    Math.max(ASK_GAP, centre - ASK_BUTTON_WIDTH / 2),
  );
  return { top, left };
}
