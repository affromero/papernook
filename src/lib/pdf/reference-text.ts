/**
 * Map a click inside the reference-preview crop back to the bibliography
 * entry under it, so the viewer can web-search the citation. Entry
 * boundaries come from bibliography.ts — the one canonical segmentation —
 * so this works for numbered ([n] / n.) and author-year bibliographies
 * alike.
 */

import {
  COLUMN_WIDTH_FACTOR,
  detectStyle,
  entryStartIndexes,
  pageLines,
  type PdfTextChunk,
  type TextLine,
} from "./bibliography";

const ENTRY_MARKER = /^\s*(?:\[\d+\]|\d{1,3}\.)\s*/;

export function referenceTextAtPoint(
  chunks: PdfTextChunk[],
  click: { x: number; y: number },
  pageWidth: number,
): string | null {
  const lines = pageLines({ pageNumber: 1, pageWidth, chunks });
  if (lines.length === 0) return null;
  const style = detectStyle(lines);
  const starts = entryStartIndexes(lines, style);

  // Nearest entry start above the click within the click's column.
  let chosen = -1;
  for (let index = 0; index < starts.length; index += 1) {
    const startIndex = starts[index];
    const line = startIndex === undefined ? undefined : lines[startIndex];
    if (!line) continue;
    if (click.x < line.x - 10) continue;
    if (click.x - line.x >= pageWidth * COLUMN_WIDTH_FACTOR) continue;
    if (line.y + 3 < click.y) continue;
    chosen = index;
  }
  if (chosen < 0) return null;
  const chosenIndex = starts[chosen];
  const start = chosenIndex === undefined ? undefined : lines[chosenIndex];
  if (chosenIndex === undefined || !start) return null;

  const nextIndex = nextStartInColumn(lines, starts, chosen, start);
  const nextStart = nextIndex === undefined ? undefined : lines[nextIndex];
  const bottom = nextStart ? nextStart.y + 3 : start.y - 200;
  if (click.y <= bottom) return null;

  const entryLines = lines
    .slice(chosenIndex, nextIndex ?? lines.length)
    .filter(
      (line) =>
        line.column === start.column && line.pageNumber === start.pageNumber,
    );
  const text = entryLines
    .map((line) => line.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(ENTRY_MARKER, "")
    .trim();
  return text.length >= 12 ? text.slice(0, 300) : null;
}

function nextStartInColumn(
  lines: TextLine[],
  starts: number[],
  chosen: number,
  start: TextLine,
): number | undefined {
  for (let index = chosen + 1; index < starts.length; index += 1) {
    const startIndex = starts[index];
    const line = startIndex === undefined ? undefined : lines[startIndex];
    if (!line) continue;
    if (line.column === start.column && line.pageNumber === start.pageNumber) {
      return startIndex;
    }
  }
  return undefined;
}
