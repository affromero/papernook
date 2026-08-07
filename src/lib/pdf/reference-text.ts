/**
 * Map a click inside the reference-preview crop back to the bibliography
 * entry under it, so the viewer can web-search the citation. Pure text-layout
 * logic: entries start at "[n]" markers; the clicked entry spans from its
 * marker down to the next marker in the same column.
 */

export interface PdfTextChunk {
  str: string;
  x: number;
  y: number;
}

const ENTRY_MARKER = /^\s*\[\d+\]/;

export function referenceTextAtPoint(
  chunks: PdfTextChunk[],
  click: { x: number; y: number },
  pageWidth: number,
): string | null {
  const columnWidth = pageWidth * 0.55;
  const markers = chunks.filter(
    (chunk) =>
      ENTRY_MARKER.test(chunk.str) &&
      click.x >= chunk.x - 10 &&
      click.x - chunk.x < columnWidth,
  );
  const startsAbove = markers.filter((marker) => marker.y >= click.y - 3);
  if (startsAbove.length === 0) return null;
  // Nearest marker above the click is the entry's first line (PDF y grows up).
  const start = startsAbove.reduce((a, b) => (a.y <= b.y ? a : b));
  const below = markers.filter((marker) => marker.y < start.y);
  const bottom = below.length
    ? Math.max(...below.map((marker) => marker.y))
    : start.y - 200;

  const byLine = new Map<number, PdfTextChunk[]>();
  for (const chunk of chunks) {
    if (!chunk.str.trim()) continue;
    if (chunk.x < start.x - 10 || chunk.x - start.x >= columnWidth) continue;
    if (chunk.y > start.y + 3 || chunk.y <= bottom + 3) continue;
    const key = Math.round(chunk.y / 3);
    byLine.set(key, [...(byLine.get(key) ?? []), chunk]);
  }
  const text = [...byLine.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, line]) =>
      line
        .sort((a, b) => a.x - b.x)
        .map((chunk) => chunk.str)
        .join(" "),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(ENTRY_MARKER, "")
    .trim();
  return text.length >= 12 ? text.slice(0, 300) : null;
}
