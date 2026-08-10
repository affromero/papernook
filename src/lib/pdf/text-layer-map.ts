/**
 * Offset bookkeeping between the pdf.js text layer DOM and the flat string
 * citations.ts searches. The text layer renders one span per text item with
 * bare <br> elements at line ends (no whitespace of their own), so the
 * assembled string inserts "\n" for each break — patterns are
 * whitespace-tolerant — while keeping every text segment's offsets DOM-exact
 * for Range construction. Pure so the mapping logic is node-testable.
 */

export interface TextLayerSegment {
  text: string;
  /** A <br> line break: contributes "\n" but hosts no text node. */
  isBreak: boolean;
}

export interface AssembledText {
  text: string;
  /** [start, end) of each input segment in `text`, aligned by index. */
  spans: { start: number; end: number }[];
}

export function assembleSegments(segments: TextLayerSegment[]): AssembledText {
  let text = "";
  const spans: { start: number; end: number }[] = [];
  for (const segment of segments) {
    const piece = segment.isBreak ? "\n" : segment.text;
    spans.push({ start: text.length, end: text.length + piece.length });
    text += piece;
  }
  return { text, spans };
}

export interface SegmentPosition {
  segment: number;
  offset: number;
}

/**
 * Map a string offset back to a text segment and in-segment offset. Break
 * segments host no text node, so a boundary offset resolves into the
 * neighboring text segment: forward for a range start, backward for an end.
 */
export function positionAt(
  assembled: AssembledText,
  offset: number,
  bias: "start" | "end",
): SegmentPosition | null {
  const { spans } = assembled;
  if (bias === "start") {
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index];
      if (!span || span.end <= offset) continue;
      if (offset < span.start) return null;
      return { segment: index, offset: offset - span.start };
    }
    return null;
  }
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (!span || span.start >= offset) continue;
    if (offset > span.end) return null;
    return { segment: index, offset: offset - span.start };
  }
  return null;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Merge glyph rects into one box per rendered line: rects whose vertical
 * centers fall within another's vertical extent join that line's box.
 */
export function mergeRectsIntoLines(rects: Box[]): Box[] {
  const lines: Box[] = [];
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const center = rect.top + rect.height / 2;
    const line = lines.find(
      (candidate) =>
        center >= candidate.top && center <= candidate.top + candidate.height,
    );
    if (!line) {
      lines.push({ ...rect });
      continue;
    }
    const right = Math.max(line.left + line.width, rect.left + rect.width);
    const bottom = Math.max(line.top + line.height, rect.top + rect.height);
    line.left = Math.min(line.left, rect.left);
    line.top = Math.min(line.top, rect.top);
    line.width = right - line.left;
    line.height = bottom - line.top;
  }
  return lines;
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}
