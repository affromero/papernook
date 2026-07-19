export interface PdfDestinationDocument {
  numPages: number;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

export type PdfDestination = string | unknown[];

function isPageReference(value: unknown): value is {
  num: number;
  gen: number;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.num === "number" && typeof candidate.gen === "number";
}

/**
 * Resolve a PDF link destination without changing the reader's current page.
 * PDF destination arrays store direct page indexes as zero-based numbers.
 */
export async function resolvePdfDestinationPage(
  document: PdfDestinationDocument,
  destination: PdfDestination,
): Promise<number | null> {
  const explicit =
    typeof destination === "string"
      ? await document.getDestination(destination)
      : destination;
  if (!explicit || explicit.length === 0) return null;

  const pageReference = explicit[0];
  let pageNumber: number;
  if (Number.isInteger(pageReference)) {
    pageNumber = (pageReference as number) + 1;
  } else if (isPageReference(pageReference)) {
    try {
      pageNumber = (await document.getPageIndex(pageReference)) + 1;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  return pageNumber >= 1 && pageNumber <= document.numPages ? pageNumber : null;
}
