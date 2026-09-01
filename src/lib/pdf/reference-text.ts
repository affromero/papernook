/**
 * Map a point on a page back to the text under it, for the reference
 * preview's highlight and crop framing.
 *
 * - `referenceEntryAtPoint`: the bibliography entry under a click or a
 *   citation's GoTo destination, so the viewer can web-search it. Entry
 *   boundaries come from bibliography.ts — the one canonical segmentation —
 *   so this works for numbered ([n] / n.) and author-year bibliographies
 *   alike.
 * - `locatorLinesAtPoint`: the heading or caption an in-paper locator
 *   ("Section 2", "Figure 3") resolves to — one line, or the caption's
 *   following lines while they keep the caption's pitch.
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

  const hit = lineIndexAtPoint(
    lines,
    click,
    (line) =>
      click.x >= line.x - 10 &&
      click.x - line.x < pageWidth * COLUMN_WIDTH_FACTOR,
  );
  if (hit < 0) return null;

  let chosen = -1;
  for (let index = 0; index < starts.length; index += 1) {
    const startIndex = starts[index];
    if (startIndex === undefined || startIndex > hit) break;
    chosen = index;
  }
  if (chosen < 0) return null;
  const chosenIndex = starts[chosen];
  const start = chosenIndex === undefined ? undefined : lines[chosenIndex];
  if (chosenIndex === undefined || !start) return null;

  const nextIndex = nextStartInColumn(lines, starts, chosen, start);

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
  const right = columnRightEdge(lines, start);
  return {
    text: text.slice(0, 300),
    boxes: lineBoxes(
      entryLines.map((line) => ({
        line,
        chunks: chunksOnLine(chunks, line, right),
        right,
      })),
    ),
  };
}

/** Caption continuation: a line gap past this multiple of the caption's own
 * pitch is a paragraph break, not a wrapped caption line. */
const CONTINUATION_GAP_FACTOR = 1.4;
const MAX_LOCATOR_LINES = 12;
/** Wrapped caption lines share the caption's left edge; a table's rows or a
 * listing's indented body under a caption start elsewhere. */
const CONTINUATION_X_TOLERANCE = 3;
/** Chunks on one line further apart than this are table cells, not words:
 * a justified word gap stays under ~7pt while `\tabcolsep` alone is 12pt. */
const TABULAR_GAP = 10;
/** A line whose text runs closer than this to the next column's base has no
 * gutter, so it is a full-width (`figure*`) caption spanning both columns. */
const GUTTER_MIN = 10;

/**
 * The heading or caption line an in-paper locator's destination points at.
 * hyperref anchors sections and captions at the top of their first line and
 * at the float's LEFT edge, so the hit is the first baseline at/below the
 * point in the point's column — membership by column, not by line start,
 * because a one-line caption is centred while its anchor sits at the column
 * base. With `multiline` (figure, table and algorithm captions wrap),
 * following lines in the same column join while consecutive baseline gaps
 * stay within CONTINUATION_GAP_FACTOR of the first gap (which itself must
 * not already be a paragraph break relative to the column's typical pitch),
 * they keep the caption's left edge, and they do not look like table rows.
 * A caption line that runs into the gutter is a full-width caption, and its
 * chunks past the gutter join the line instead of counting as the next
 * column.
 */
export function locatorLinesAtPoint(
  chunks: PdfTextChunk[],
  point: { x: number; y: number },
  pageWidth: number,
  options: { multiline: boolean },
): ReferenceEntry | null {
  const lines = pageLines({ pageNumber: 1, pageWidth, chunks });
  const column = columnAtX(lines, point.x);
  const hit = lineIndexAtPoint(lines, point, (line) => line.column === column);
  const first = lines[hit];
  if (hit < 0 || !first) return null;
  const right = columnRightEdge(lines, first);

  const selected: TextLine[] = [first];
  if (options.multiline) {
    const pitch = columnPitch(lines, first);
    let previous = first;
    let limit: number | null = null;
    for (
      let index = hit + 1;
      index < lines.length && selected.length < MAX_LOCATOR_LINES;
      index += 1
    ) {
      const line = lines[index];
      if (!line || line.column !== first.column) break;
      const gap = previous.y - line.y;
      if (gap <= 0) break;
      if (limit === null) {
        if (pitch !== null && gap > pitch * CONTINUATION_GAP_FACTOR) break;
        limit = gap * CONTINUATION_GAP_FACTOR;
      } else if (gap > limit) {
        break;
      }
      if (Math.abs(line.x - first.x) > CONTINUATION_X_TOLERANCE) break;
      if (looksTabular(chunksOnLine(chunks, line, right))) break;
      selected.push(line);
      previous = line;
    }
  }

  const rows = selected.map((line) => {
    const own = chunksOnLine(chunks, line, right);
    const spansGutter =
      right !== Number.POSITIVE_INFINITY &&
      own.some((chunk) => chunkRight(chunk) >= right - GUTTER_MIN);
    return spansGutter
      ? {
          line,
          chunks: chunksOnLine(chunks, line, Number.POSITIVE_INFINITY),
          right: Number.POSITIVE_INFINITY,
        }
      : { line, chunks: own, right };
  });
  const text = rows
    .map((row) => row.chunks.map((chunk) => chunk.str).join(" "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return { text: text.slice(0, 300), boxes: lineBoxes(rows) };
}

/**
 * Index of the line the point sits on: the first baseline at or below it
 * that `onLine` accepts (the bibliography path checks the point against the
 * line's start; locators check column membership). Anchoring on the line
 * rather than on the nearest entry start above matters for hyperref GoTo
 * destinations, which point at the TOP of an entry's first line — a point
 * that falls in the gap under the PREVIOUS entry's last baseline and used to
 * resolve one entry high. Points far below the last line of a column belong
 * to nothing.
 */
function lineIndexAtPoint(
  lines: TextLine[],
  click: { x: number; y: number },
  onLine: (line: TextLine) => boolean,
): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.y > click.y + 3) continue;
    if (!onLine(line)) continue;
    return click.y - line.y > 40 ? -1 : index;
  }
  return -1;
}

/** The column whose base (leftmost line start) is the rightmost one at or
 * left of x, with a little slack for anchors sitting in the margin. */
function columnAtX(lines: TextLine[], x: number): number {
  const bases = new Map<number, number>();
  for (const line of lines) {
    const base = bases.get(line.column);
    if (base === undefined || line.x < base) bases.set(line.column, line.x);
  }
  let column = 0;
  for (const [index, base] of [...bases].sort((a, b) => a[0] - b[0])) {
    if (x >= base - 10) column = index;
  }
  return column;
}

/** Table rows read as cells separated by gaps no word spacing produces. */
function looksTabular(onLine: PdfTextChunk[]): boolean {
  for (let index = 1; index < onLine.length; index += 1) {
    const previous = onLine[index - 1];
    const chunk = onLine[index];
    if (!previous || !chunk || previous.width === undefined) continue;
    if (chunk.x - chunkRight(previous) > TABULAR_GAP) return true;
  }
  return false;
}

function chunkRight(chunk: PdfTextChunk): number {
  return chunk.x + (chunk.width ?? chunk.str.length * 4);
}

/** The visible chunks sitting on a line, left to right, up to `right`. */
function chunksOnLine(
  chunks: PdfTextChunk[],
  line: TextLine,
  right: number,
): PdfTextChunk[] {
  return chunks
    .filter(
      (chunk) =>
        Math.abs(chunk.y - line.y) <= 2.5 &&
        chunk.x >= line.x - 1 &&
        chunk.x < right &&
        chunk.str.trim().length > 0,
    )
    .sort((a, b) => a.x - b.x);
}

/**
 * The next column's left edge: chunks past it sit at the same y as the
 * entry but belong to the neighbouring column, and letting them widen a
 * box paints the highlight straight across the gutter.
 */
function columnRightEdge(lines: TextLine[], start: TextLine): number {
  return Math.min(
    ...lines
      .filter(
        (line) =>
          line.pageNumber === start.pageNumber && line.column > start.column,
      )
      .map((line) => line.x),
    Number.POSITIVE_INFINITY,
  );
}

/** Median baseline gap of the line's column — the column's body pitch. */
function columnPitch(lines: TextLine[], reference: TextLine): number | null {
  const column = lines.filter(
    (line) =>
      line.column === reference.column &&
      line.pageNumber === reference.pageNumber,
  );
  const gaps: number[] = [];
  for (let index = 1; index < column.length; index += 1) {
    const previous = column[index - 1];
    const line = column[index];
    if (previous && line && previous.y - line.y > 0) {
      gaps.push(previous.y - line.y);
    }
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? null;
}

interface LineRow {
  line: TextLine;
  chunks: PdfTextChunk[];
  /** Clip for the box's right edge (the next column's base, or none). */
  right: number;
}

/**
 * Boxes covering each line. Line height comes from the lines' own pitch
 * (font sizes are not in the line model) and the right edge from the chunks
 * sitting on that line, so a ragged last line stays ragged.
 */
function lineBoxes(rows: LineRow[]): EntryLineBox[] {
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const previous = rows[i - 1];
    const row = rows[i];
    if (previous && row) gaps.push(previous.line.y - row.line.y);
  }
  const pitch = gaps.length ? Math.min(...gaps) : 11;
  return rows.flatMap(({ line, chunks, right }) => {
    if (chunks.length === 0) return [];
    const edge = Math.max(
      ...chunks.map((chunk) => Math.min(chunkRight(chunk), right)),
    );
    return [
      {
        x: line.x - 1,
        y: line.y - pitch * 0.25,
        width: edge - line.x + 2,
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
