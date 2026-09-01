/**
 * Where a reader left off in a paper: the page and zoom the viewer restores
 * the next time the same paper opens. Stored per paper in the browser's
 * localStorage under `readingPositionKey`, so it never touches the shared
 * library and survives a document remount or a fresh tab.
 */
export interface ReadingPosition {
  /** 1-based page number. */
  page: number;
  /** pdf.js `currentScale`; 1 is 100%. */
  scale: number;
}

/**
 * pdf.js's own `MIN_SCALE` / `MAX_SCALE`: every zoom the toolbar, wheel, or
 * pinch can reach lies inside this window.
 */
export const MIN_READING_SCALE = 0.1;
export const MAX_READING_SCALE = 25;

export function readingPositionKey(topic: string, slug: string): string {
  return `papernook:reading-position:${topic}/${slug}`;
}

/**
 * Turns a stored value back into a position, or null when it is missing,
 * malformed, or names a page the viewer cannot show (a non-integer or a
 * page below 1). A finite zoom outside the viewer's range is clamped rather
 * than rejected, so a foreign or hand-edited value degrades to the nearest
 * displayable zoom instead of forgetting the page along with it. Callers
 * still clamp the page to the document's page count, since the PDF may
 * have been re-expanded or replaced since the position was written.
 */
export function parseReadingPosition(
  raw: string | null | undefined,
): ReadingPosition | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { page, scale } = value as Record<string, unknown>;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
    return null;
  }
  if (typeof scale !== "number" || !Number.isFinite(scale)) return null;
  return {
    page,
    scale: Math.min(MAX_READING_SCALE, Math.max(MIN_READING_SCALE, scale)),
  };
}

export function serializeReadingPosition(position: ReadingPosition): string {
  return JSON.stringify({ page: position.page, scale: position.scale });
}
