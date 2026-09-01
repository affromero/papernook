/**
 * Turns a chat answer into something pdf.js can save as a FreeText
 * annotation. The worker builds the appearance stream with the standard
 * Helvetica font in WinAnsiEncoding and bails out of drawing any line it
 * cannot encode, so the text is transliterated to that repertoire; it also
 * draws each line as-is (shrinking the font when a line overflows the
 * rect), so lines are wrapped here rather than by the viewer.
 */

import { findPaperRefs, type PaperRefKind } from "@/lib/pdf/paper-refs";

export const NOTE_FONT_SIZE = 9;
/** pdf.js LINE_FACTOR: the worker lays FreeText lines out at 1.35 × size. */
export const NOTE_LINE_HEIGHT = 1.35 * NOTE_FONT_SIZE;
export const NOTE_WIDTH = 150;
export const NOTE_MARGIN = 12;
export const NOTE_CHARS_PER_LINE = 30;
export const NOTE_MAX_LINES = 40;

const TRANSLITERATIONS: [RegExp, string][] = [
  [/[\u2010-\u2015\u2212]/g, "-"],
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/…/g, "..."],
  [/≤/g, "<="],
  [/≥/g, ">="],
  [/≠/g, "!="],
  [/≈/g, "~"],
  [/→/g, "->"],
  [/←/g, "<-"],
  [/↔/g, "<->"],
  [/⇒/g, "=>"],
  [/•/g, "-"],
  [/[\u00a0\u2000-\u200b\u202f\u3000]/g, " "],
  [/⁄/g, "/"],
  // Soft hyphens survive copy-paste from PDFs but Helvetica's WinAnsi map has
  // no glyph for U+00AD (0xAD is a plain hyphen), which voids the appearance.
  [/\u00ad/g, ""],
];

// WinAnsi covers printable ASCII, Latin-1 (U+00A0..U+00FF) and a handful of
// typographic characters mapped into 0x80..0x9F.
const WINANSI_HIGH = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return WINANSI_HIGH.has(char);
}

function stripMarkdown(markdown: string): string {
  return (
    markdown
      .replace(/\r\n?/g, "\n")
      // Fence markers go, their content stays as plain text.
      .replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, "")
      // Only tag-shaped runs (`<br>`, `</sup>`, `<a href="…">`): inline
      // inequalities such as "a<b and c>d" must survive.
      .replace(
        /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z-]+="[^"\n]*")*\s*\/?>/g,
        "",
      )
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/^[ \t]*[-*+][ \t]+/gm, "- ")
      .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, "$1. ")
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*/g, "$1$2")
      .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_/g, "$1$2")
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "$1")
      .replace(/`([^`\n]*)`/g, "$1")
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
  );
}

/** Plain WinAnsi text: markdown syntax stripped, typography flattened. */
export function marginNoteText(markdown: string): string {
  let text = stripMarkdown(markdown);
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    text = text.replace(pattern, replacement);
  }
  text = Array.from(text)
    .filter((char) => char === "\n" || char === "\t" || isWinAnsi(char))
    .join("")
    .replace(/\t/g, "  ");
  return text
    .split("\n")
    .map((line) => line.replace(/[ ]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapParagraph(paragraph: string, charsPerLine: number): string[] {
  const lines: string[] = [];
  let current = "";
  const push = () => {
    if (current) lines.push(current);
    current = "";
  };
  for (const word of paragraph.split(" ")) {
    let rest = word;
    while (rest.length > charsPerLine) {
      push();
      lines.push(rest.slice(0, charsPerLine));
      rest = rest.slice(charsPerLine);
    }
    if (!rest) continue;
    if (!current) {
      current = rest;
    } else if (current.length + 1 + rest.length <= charsPerLine) {
      current += ` ${rest}`;
    } else {
      push();
      current = rest;
    }
  }
  push();
  return lines;
}

/**
 * Word-wrap into at most `maxLines` lines of at most `charsPerLine`
 * characters; blank lines separate paragraphs. A truncated note ends in an
 * ellipsis so the reader knows to open the chat for the rest.
 */
export function wrapNote(
  text: string,
  charsPerLine = NOTE_CHARS_PER_LINE,
  maxLines = NOTE_MAX_LINES,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    lines.push(...wrapParagraph(paragraph.trim(), charsPerLine));
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? "";
  kept[maxLines - 1] =
    `${last.slice(0, Math.max(0, charsPerLine - 3)).trimEnd()}...`;
  return kept;
}

/**
 * PDF-space rect `[x1, y1, x2, y2]` for a note of `lines` lines hugging the
 * page's right margin. Top-aligned with `anchorTop` (a resolved
 * destination's y) when given, else just below the page's top edge; always
 * kept inside `pageView` (`[x0, y0, x1, y1]`, origin bottom-left).
 */
export function noteRect(
  pageView: readonly [number, number, number, number],
  lines: number,
  anchorTop: number | null = null,
): [number, number, number, number] {
  const [left, bottom, right, top] = pageView;
  const width = Math.min(NOTE_WIDTH, right - left);
  const x2 = right - Math.min(NOTE_MARGIN, (right - left - width) / 2);
  const x1 = x2 - width;
  const height = Math.max(1, lines) * NOTE_LINE_HEIGHT;
  const maxTop = top - NOTE_MARGIN;
  const minBottom = bottom + NOTE_MARGIN;
  let y2 = anchorTop === null ? maxTop : Math.min(anchorTop, maxTop);
  let y1 = y2 - height;
  if (y1 < minBottom) {
    y1 = minBottom;
    y2 = Math.min(maxTop, y1 + height);
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return [round(x1), round(y1), round(x2), round(y2)];
}

/** The first in-paper reference an answer mentions — where the note goes. */
export function firstLocator(
  markdown: string,
): { kind: PaperRefKind; label: string } | null {
  const ref = findPaperRefs(markdown)[0];
  return ref ? { kind: ref.kind, label: ref.label } : null;
}
