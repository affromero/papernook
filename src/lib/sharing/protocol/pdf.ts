import { pdfEtag } from "../../library/pdf/file";
import { MAX_PDF_BYTES } from "../../pdf-limits";
import { SharingError } from "./values";

export function validateSharedPdf(pdf: Uint8Array, etag: string): void {
  const bytes = Buffer.from(pdf);
  if (
    bytes.byteLength > MAX_PDF_BYTES ||
    pdfEtag(bytes) !== etag ||
    !bytes.subarray(0, 1024).toString("latin1").includes("%PDF-") ||
    !bytes.subarray(-1024).toString("latin1").includes("%%EOF")
  )
    throw new SharingError("The shared PDF is invalid or incomplete.", 422);
}
