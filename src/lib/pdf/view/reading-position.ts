/**
 * Where a reader left off in a paper: the page and zoom the viewer restores
 * the next time the same paper opens. Stored per paper in the browser's
 * localStorage under `readingPositionKey` and, on signed-in surfaces,
 * mirrored per profile on the server so a position follows the reader
 * across devices. `updatedAt` decides which copy wins.
 */
export interface ReadingPosition {
  /** 1-based page number. */
  page: number;
  /** pdf.js `currentScale`; 1 is 100%. */
  scale: number;
  /** Epoch ms of the move that produced this position; 0 when unknown. */
  updatedAt: number;
}

/**
 * pdf.js's own `MIN_SCALE` / `MAX_SCALE`: every zoom the toolbar, wheel, or
 * pinch can reach lies inside this window.
 */
export const MIN_READING_SCALE = 0.1;
export const MAX_READING_SCALE = 25;

/**
 * The username keeps profiles on a shared browser apart: the server copy is
 * per profile, so the local mirror must be too, or one reader's synced spot
 * would seed another's.
 */
export function readingPositionKey(
  topic: string,
  slug: string,
  username: string,
): string {
  return `papernook:reading-position:${username}:${topic}/${slug}`;
}

/**
 * Turns an already-parsed value into a position, or null when it is not one
 * the viewer can show (a non-integer or below-1 page). A finite zoom
 * outside the viewer's range is clamped rather than rejected, so a foreign
 * or hand-edited value degrades to the nearest displayable zoom instead of
 * forgetting the page along with it. A missing or malformed `updatedAt`
 * degrades to 0 (older than every real timestamp), so positions written
 * before timestamps existed still restore but always lose a freshness
 * race. Callers still clamp the page to the document's page count, since
 * the PDF may have been re-expanded or replaced since it was written.
 */
export function readingPositionFromUnknown(
  value: unknown,
): ReadingPosition | null {
  if (!value || typeof value !== "object") return null;
  const { page, scale, updatedAt } = value as Record<string, unknown>;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
    return null;
  }
  if (typeof scale !== "number" || !Number.isFinite(scale)) return null;
  return {
    page,
    scale: Math.min(MAX_READING_SCALE, Math.max(MIN_READING_SCALE, scale)),
    updatedAt:
      typeof updatedAt === "number" &&
      Number.isFinite(updatedAt) &&
      updatedAt > 0
        ? updatedAt
        : 0,
  };
}

/** `readingPositionFromUnknown` over a stored JSON string. */
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
  return readingPositionFromUnknown(value);
}

export function serializeReadingPosition(position: ReadingPosition): string {
  return JSON.stringify({
    page: position.page,
    scale: position.scale,
    updatedAt: position.updatedAt,
  });
}

/**
 * The more recently written of two positions; a tie (both copies from the
 * same move, or both timestampless) keeps the first argument, so callers
 * pass the copy they would rather trust — the local one — first.
 */
export function newerReadingPosition(
  a: ReadingPosition | null,
  b: ReadingPosition | null,
): ReadingPosition | null {
  if (!a) return b;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}
