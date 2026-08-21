/**
 * pdf.js 6.x's PDFPageProxy.getTextContent() iterates its internal
 * ReadableStream with `for await`, and Safari only gained ReadableStream
 * async iteration in 26.4 — on older Safari that call rejects with a
 * TypeError while rendering (a different pipeline) keeps working. Consuming
 * streamTextContent() through a plain reader works everywhere.
 */

import type { PdfTextChunk } from "./bibliography";

interface TextStreamReader {
  read(): Promise<{ value?: { items: unknown[] }; done: boolean }>;
  releaseLock(): void;
}

export interface TextStreamPage {
  streamTextContent(): { getReader(): TextStreamReader };
}

export async function pdfTextItems(page: TextStreamPage): Promise<unknown[]> {
  const reader = page.streamTextContent().getReader();
  const items: unknown[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }
  return items;
}

function isRawTextItem(
  item: unknown,
): item is { str: string; transform: number[]; width?: number } {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as { str: unknown }).str === "string" &&
    "transform" in item &&
    Array.isArray((item as { transform: unknown }).transform)
  );
}

/** Positioned text chunks from raw getTextContent items. */
export function pdfTextChunks(items: unknown[]): PdfTextChunk[] {
  const chunks: PdfTextChunk[] = [];
  for (const item of items) {
    if (!isRawTextItem(item)) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    if (typeof x !== "number" || typeof y !== "number") continue;
    chunks.push({ str: item.str, x, y, width: item.width });
  }
  return chunks;
}
