/**
 * Paper-title resolution for PDFs whose metadata is missing or junk (export
 * hashes, filenames). Falls back to the classic heuristic: the largest-font
 * text run near the top of page 1 is the title.
 */

import { pdfTextItems, type TextStreamPage } from "./text-items";

export interface TitleChunk {
  str: string;
  x: number;
  y: number;
  size: number;
}

interface PdfTitlePage extends TextStreamPage {
  view: number[];
}

export interface PdfTitleDocument {
  getMetadata(): Promise<{ info: unknown }>;
  getPage(pageNumber: number): Promise<PdfTitlePage>;
}

interface RawTextItem {
  str: string;
  transform: number[];
}

function isTextItem(item: unknown): item is RawTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as { str: unknown }).str === "string" &&
    "transform" in item &&
    Array.isArray((item as { transform: unknown }).transform)
  );
}

/** Reject metadata "titles" that are really filenames or export hashes. */
export function isLikelyRealTitle(value: string): boolean {
  const title = value.trim();
  if (title.length < 8 || title.length > 300) return false;
  if (/\.(pdf|tex|dvi|docx?)$/i.test(title)) return false;
  if (!/\s/.test(title)) return false;
  return true;
}

/**
 * Largest-font run in the top 45% of page 1, read in line order. Returns null
 * when nothing title-shaped is there (scanned pages, cover sheets).
 */
export function titleFromFirstPageText(
  chunks: TitleChunk[],
  pageHeight: number,
): string | null {
  const top = chunks.filter(
    (chunk) =>
      chunk.str.trim() && chunk.size > 0 && chunk.y > pageHeight * 0.55,
  );
  if (top.length === 0) return null;
  const maxSize = Math.max(...top.map((chunk) => chunk.size));
  const titleChunks = top.filter((chunk) => chunk.size >= maxSize - 0.5);
  const byLine = new Map<number, TitleChunk[]>();
  for (const chunk of titleChunks) {
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
    .trim();
  return isLikelyRealTitle(text) ? text : null;
}

/** Embedded Title metadata when it looks real, else the page-1 heuristic. */
export async function resolvePdfDocumentTitle(
  document: PdfTitleDocument,
): Promise<string | null> {
  try {
    const { info } = await document.getMetadata();
    const embedded =
      info && typeof info === "object" && "Title" in info ? info.Title : null;
    if (typeof embedded === "string" && isLikelyRealTitle(embedded)) {
      return embedded.trim();
    }
  } catch {
    // fall through to the text heuristic
  }
  try {
    const page = await document.getPage(1);
    const items = await pdfTextItems(page);
    const chunks = items.filter(isTextItem).map((item) => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      size: Math.hypot(item.transform[2], item.transform[3]),
    }));
    return titleFromFirstPageText(chunks, page.view[3] - page.view[1]);
  } catch (error) {
    console.error("papernook: page-1 title heuristic failed", error);
    return null;
  }
}
