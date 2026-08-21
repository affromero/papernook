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

/** A highlightable box in PDF coordinates (origin bottom-left). */
export interface EntryLineBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReferenceEntry {
  text: string;
  /** One box per line of the entry, for highlighting it in a preview. */
  boxes: EntryLineBox[];
}

export function referenceTextAtPoint(
  chunks: PdfTextChunk[],
  click: { x: number; y: number },
  pageWidth: number,
): string | null {
  return referenceEntryAtPoint(chunks, click, pageWidth)?.text ?? null;
}

export function referenceEntryAtPoint(
  chunks: PdfTextChunk[],
  click: { x: number; y: number },
  pageWidth: number,
): ReferenceEntry | null {
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
  if (text.length < 12) return null;
  return {
    text: text.slice(0, 300),
    boxes: lineBoxes(entryLines, chunks, pageWidth),
  };
}

/**
 * Boxes covering each line of the entry. Line height comes from the entry's
 * own pitch (font sizes are not in the line model) and the right edge from
 * the chunks sitting on that line, so a ragged last line stays ragged.
 */
function lineBoxes(
  entryLines: TextLine[],
  chunks: PdfTextChunk[],
  pageWidth: number,
): EntryLineBox[] {
  const gaps: number[] = [];
  for (let i = 1; i < entryLines.length; i += 1) {
    const previous = entryLines[i - 1];
    const line = entryLines[i];
    if (previous && line) gaps.push(previous.y - line.y);
  }
  const pitch = gaps.length ? Math.min(...gaps) : 11;
  return entryLines.flatMap((line) => {
    const onLine = chunks.filter(
      (chunk) =>
        Math.abs(chunk.y - line.y) <= 2.5 &&
        chunk.x >= line.x - 1 &&
        chunk.x - line.x < pageWidth * COLUMN_WIDTH_FACTOR &&
        chunk.str.trim().length > 0,
    );
    if (onLine.length === 0) return [];
    const right = Math.max(
      ...onLine.map((chunk) => chunk.x + (chunk.width ?? chunk.str.length * 4)),
    );
    return [
      {
        x: line.x - 1,
        y: line.y - pitch * 0.25,
        width: right - line.x + 2,
        height: pitch,
      },
    ];
  });
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
