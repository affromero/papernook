export interface PdfDestinationDocument {
  numPages: number;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

export type PdfDestination = string | unknown[];

export interface ResolvedPdfDestination {
  pageNumber: number;
  kind: string | null;
  left: number | null;
  top: number | null;
  zoom: number | null;
}

function isPageReference(value: unknown): value is {
  num: number;
  gen: number;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.num === "number" && typeof candidate.gen === "number";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function destinationKind(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

/**
 * Resolve a PDF link destination without changing the reader's current page.
 * PDF destination arrays store direct page indexes as zero-based numbers.
 */
export async function resolvePdfDestination(
  document: PdfDestinationDocument,
  destination: PdfDestination,
): Promise<ResolvedPdfDestination | null> {
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

  if (pageNumber < 1 || pageNumber > document.numPages) return null;

  const kind = destinationKind(explicit[1]);
  return {
    pageNumber,
    kind,
    left: kind === "XYZ" ? finiteNumber(explicit[2]) : null,
    top: kind === "XYZ" ? finiteNumber(explicit[3]) : null,
    zoom: kind === "XYZ" ? finiteNumber(explicit[4]) : null,
  };
}

export async function resolvePdfDestinationPage(
  document: PdfDestinationDocument,
  destination: PdfDestination,
): Promise<number | null> {
  return (
    (await resolvePdfDestination(document, destination))?.pageNumber ?? null
  );
}
