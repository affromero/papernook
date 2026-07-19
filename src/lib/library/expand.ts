import { PDFDocument } from "pdf-lib";
import { PdfFileError, rewritePdf } from "./pdf/file";

/**
 * Grow a PDF for Pencil room without touching existing ink:
 *  - "margin": widen every page's MediaBox to the RIGHT only; origin stays
 *    fixed, so existing content and annotation coordinates never shift.
 *  - "page": append one blank page matching the last page's size.
 * The rewrite is atomic (tmp + rename) and refuses to run when the file
 * changed in the last few seconds (the iPad may be mid-save; last write
 * would win and one side would lose ink).
 */

const MARGIN_POINTS = 200;

export class ExpandError extends Error {}

export async function expandPdf(
  topic: string,
  slug: string,
  mode: "margin" | "page",
): Promise<{ pages: number }> {
  let pages = 0;
  try {
    await rewritePdf(topic, slug, async (bytes) => {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });

      if (mode === "margin") {
        for (const page of doc.getPages()) {
          const { x, y, width, height } = page.getMediaBox();
          // Grow to the right only: origin fixed, so ink never shifts.
          page.setMediaBox(x, y, width + MARGIN_POINTS, height);
          const crop = page.getCropBox();
          page.setCropBox(
            crop.x,
            crop.y,
            crop.width + MARGIN_POINTS,
            crop.height,
          );
        }
      } else {
        const existingPages = doc.getPages();
        const last = existingPages[existingPages.length - 1];
        const { width, height } = last?.getSize() ?? {
          width: 595,
          height: 842,
        };
        doc.addPage([width, height]);
      }

      pages = doc.getPageCount();
      return doc.save();
    });
  } catch (error) {
    if (error instanceof PdfFileError) {
      throw new ExpandError(error.message);
    }
    throw error;
  }
  return { pages };
}
