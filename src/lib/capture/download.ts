import { normalizeUrl, pdfUrlFromHtml } from "./normalize";

/**
 * Polite fetching: descriptive User-Agent (arxiv policy) and a per-host
 * cooldown so bursts of captures never hammer one origin.
 */

const USER_AGENT =
  "papernook/0.1 (self-hosted paper library; +https://github.com/afromero)";
const HOST_COOLDOWN_MS = 3_000;
const MAX_PDF_BYTES = 100 * 1024 * 1024;

const lastFetchByHost = new Map<string, number>();

async function politeFetch(url: string): Promise<Response> {
  const host = new URL(url).hostname;
  const last = lastFetchByHost.get(host) ?? 0;
  const wait = last + HOST_COOLDOWN_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchByHost.set(host, Date.now());
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
}

export class CaptureError extends Error {}

export interface DownloadedPdf {
  bytes: Buffer;
  finalUrl: string;
  arxivId: string | null;
}

function looksLikePdf(response: Response, bytes: Buffer): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/pdf") ||
    bytes.subarray(0, 5).toString("latin1") === "%PDF-"
  );
}

/** Resolve any shared URL to actual PDF bytes (content validated). */
export async function downloadPdf(input: string): Promise<DownloadedPdf> {
  let target;
  try {
    target = normalizeUrl(input);
  } catch {
    throw new CaptureError(`Not a valid URL: ${input}`);
  }

  let pdfUrl = target.url;
  if (!target.expectsPdf) {
    const page = await politeFetch(target.url);
    if (!page.ok) {
      throw new CaptureError(
        `Page fetch failed (${page.status}) for ${target.url}`,
      );
    }
    const contentType = page.headers.get("content-type") ?? "";
    if (contentType.includes("application/pdf")) {
      const bytes = Buffer.from(await page.arrayBuffer());
      return { bytes, finalUrl: target.url, arxivId: target.arxivId };
    }
    const html = await page.text();
    const found = pdfUrlFromHtml(html, page.url || target.url);
    if (!found) {
      throw new CaptureError(
        `No PDF found on that page. Share the PDF link directly, or an arxiv abstract page.`,
      );
    }
    pdfUrl = found;
  }

  const response = await politeFetch(pdfUrl);
  if (!response.ok) {
    throw new CaptureError(
      `PDF fetch failed (${response.status}) for ${pdfUrl}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) {
    throw new CaptureError(
      `PDF too large (${Math.round(bytes.length / 1e6)} MB).`,
    );
  }
  if (!looksLikePdf(response, bytes)) {
    throw new CaptureError(`The fetched file is not a PDF (${pdfUrl}).`);
  }
  return { bytes, finalUrl: pdfUrl, arxivId: target.arxivId };
}
