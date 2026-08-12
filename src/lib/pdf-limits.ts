export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/**
 * Ceiling on extracted text held in memory. PDF compression is unbounded, so
 * a small hostile file can expand into gigabytes of pdftotext output. Well
 * past any real paper (a 500-page book is roughly 2 MB of text).
 */
export const MAX_EXTRACTED_TEXT_BYTES = 8 * 1024 * 1024;
