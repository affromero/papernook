/**
 * pdf.js 6.x's PDFPageProxy.getTextContent() iterates its internal
 * ReadableStream with `for await`, and Safari only gained ReadableStream
 * async iteration in 26.4 — on older Safari that call rejects with a
 * TypeError while rendering (a different pipeline) keeps working. Consuming
 * streamTextContent() through a plain reader works everywhere.
 */

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
