/** A query-free PDF is intercepted by the browser extension's redirect rules. */
export function originalPdfUrl(source: string): string {
  try {
    const url = new URL(source);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.search &&
      (url.pathname.toLowerCase().endsWith(".pdf") ||
        (url.hostname.toLowerCase().replace(/^www\./, "") === "arxiv.org" &&
          url.pathname.startsWith("/pdf/")))
    ) {
      url.search = "papernook_original=1";
      return url.href;
    }
  } catch {
    // Relative URLs point to Papernook's own PDF endpoint.
  }
  return source;
}

/** Prefer arXiv's paper page to a PDF when opening the original website. */
export function originalWebUrl(source: string): string | null {
  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (
      url.hostname.toLowerCase().replace(/^www\./, "") === "arxiv.org" &&
      url.pathname.startsWith("/pdf/") &&
      !url.search
    ) {
      url.pathname = url.pathname
        .replace(/^\/pdf\//, "/abs/")
        .replace(/\.pdf$/i, "");
      return url.href;
    }
    return originalPdfUrl(source);
  } catch {
    return null;
  }
}
