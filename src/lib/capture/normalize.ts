/**
 * Turn "whatever the share sheet sent" into a fetchable PDF URL.
 *  - arxiv /abs/, /pdf/, versioned IDs → canonical /pdf/ URL + arxiv id
 *  - HTML pages → caller fetches the page and extracts citation_pdf_url
 *  - direct PDFs pass through
 */

export interface NormalizedTarget {
  /** URL expected to serve the PDF (or the page to inspect). */
  url: string;
  /** True when `url` should already be a PDF; false = inspect HTML first. */
  expectsPdf: boolean;
  arxivId: string | null;
}

const ARXIV_RE =
  /^https?:\/\/(?:www\.)?arxiv\.org\/(abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?\/?$/i;

export function normalizeUrl(input: string): NormalizedTarget {
  const trimmed = input.trim();
  const url = new URL(trimmed); // throws on garbage; caller handles

  const arxiv = trimmed.match(ARXIV_RE);
  if (arxiv) {
    const id = `${arxiv[2]}${arxiv[3] ?? ""}`;
    return {
      url: `https://arxiv.org/pdf/${id}`,
      expectsPdf: true,
      arxivId: id,
    };
  }

  if (url.pathname.toLowerCase().endsWith(".pdf")) {
    return { url: trimmed, expectsPdf: true, arxivId: null };
  }

  // openreview pdf links use /pdf?id=...
  if (url.hostname.endsWith("openreview.net") && url.pathname === "/forum") {
    const id = url.searchParams.get("id");
    if (id) {
      return {
        url: `https://openreview.net/pdf?id=${id}`,
        expectsPdf: true,
        arxivId: null,
      };
    }
  }

  return { url: trimmed, expectsPdf: false, arxivId: null };
}

/**
 * Find the PDF link inside an HTML page: `citation_pdf_url` meta first
 * (Google Scholar convention, used by most publishers), then the first
 * anchor ending in .pdf. Returns an absolute URL or null.
 */
export function pdfUrlFromHtml(html: string, baseUrl: string): string | null {
  const meta = html.match(
    /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i,
  );
  const metaReversed = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i,
  );
  const candidate = meta?.[1] ?? metaReversed?.[1];
  if (candidate) {
    try {
      return new URL(candidate, baseUrl).toString();
    } catch {
      return null;
    }
  }
  const anchor = html.match(/<a[^>]+href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i);
  if (anchor?.[1]) {
    try {
      return new URL(anchor[1], baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}
