import type { Preview } from "./ReferencePreview";

/** Rendered height of the preview panel (header + page box). */
export const PREVIEW_HEIGHT = 40 + 285;
/** Clearance between the hovered line and the preview edge. */
export const PREVIEW_GAP = 20;

/**
 * Place the preview beside the pointer without covering the line under it:
 * just below when it fits in the viewer, otherwise just above, clamped to
 * the viewer when neither fits.
 */
export function placePreview(
  point: { clientX: number; clientY: number },
  bounds: DOMRect,
): Pick<Preview, "horizontal" | "top"> {
  const y = point.clientY - bounds.top;
  const below = y + PREVIEW_GAP;
  const above = y - PREVIEW_GAP - PREVIEW_HEIGHT;
  const fitsBelow = below + PREVIEW_HEIGHT + PREVIEW_GAP <= bounds.height;
  const top = fitsBelow ? below : Math.max(PREVIEW_GAP, above);
  return {
    horizontal:
      point.clientX - bounds.left < bounds.width / 2 ? "left" : "right",
    top,
  };
}
