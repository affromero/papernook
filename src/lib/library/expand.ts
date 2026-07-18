import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { getPaper } from "./papers";

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
const RECENT_WRITE_MS = 5_000;

export class ExpandError extends Error {}

export async function expandPdf(
  topic: string,
  slug: string,
  mode: "margin" | "page",
): Promise<{ pages: number }> {
  const paper = getPaper(topic, slug);
  if (!paper) throw new ExpandError(`Unknown paper ${topic}/${slug}`);

  const stat = fs.statSync(paper.pdfPath);
  if (Date.now() - stat.mtimeMs < RECENT_WRITE_MS) {
    throw new ExpandError(
      "The PDF was just modified: an iPad may be saving. Try again in a few seconds.",
    );
  }

  const doc = await PDFDocument.load(fs.readFileSync(paper.pdfPath), {
    updateMetadata: false,
  });

  if (mode === "margin") {
    for (const page of doc.getPages()) {
      const { x, y, width, height } = page.getMediaBox();
      // Grow to the right only: origin (x, y) fixed → no coordinate shift.
      page.setMediaBox(x, y, width + MARGIN_POINTS, height);
      const crop = page.getCropBox();
      page.setCropBox(crop.x, crop.y, crop.width + MARGIN_POINTS, crop.height);
    }
  } else {
    const pages = doc.getPages();
    const last = pages[pages.length - 1];
    const { width, height } = last?.getSize() ?? { width: 595, height: 842 };
    doc.addPage([width, height]);
  }

  const bytes = await doc.save();
  const tmp = `${paper.pdfPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, paper.pdfPath);
  return { pages: doc.getPageCount() };
}
