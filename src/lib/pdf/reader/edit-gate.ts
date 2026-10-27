import type { PDFDocumentProxy } from "pdfjs-dist";

/** Coordinate asynchronous edits that reload the reader after they save. */
export interface PdfEditGate {
  commentActive: boolean;
  notesInFlight: number;
  reloadingDocument: PDFDocumentProxy | null;
}
