#!/usr/bin/env node
/**
 * Regenerate the PdfTextChunk fixtures from their source PDFs:
 *
 *   node extract.mjs <paper.pdf> <out.json> <page> [page…]
 *
 * aaai-pages.json      ← arXiv 2608.07463, pages 1 8 9  (author-year, no
 *                        cite links, two columns, no hanging indent)
 * attention-pages.json ← arXiv 1706.03762, pages 2 10 11 (numbered [n]
 *                        bibliography with hanging indent)
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getDocument } = await import(
  require.resolve("pdfjs-dist/legacy/build/pdf.mjs")
);

const [pdfPath, outPath, ...pageArgs] = process.argv.slice(2);
if (!pdfPath || !outPath || pageArgs.length === 0) {
  console.error(
    "usage: node extract.mjs <paper.pdf> <out.json> <page> [page…]",
  );
  process.exit(1);
}

const doc = await getDocument({ url: pdfPath, useSystemFonts: true }).promise;
const out = [];
for (const arg of pageArgs) {
  const pageNumber = Number.parseInt(arg, 10);
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const chunks = content.items
    .filter((item) => typeof item.str === "string")
    .map((item) => ({
      str: item.str,
      x: Math.round(item.transform[4] * 100) / 100,
      y: Math.round(item.transform[5] * 100) / 100,
      width: Math.round((item.width ?? 0) * 100) / 100,
    }));
  const viewport = page.getViewport({ scale: 1 });
  out.push({ pageNumber, pageWidth: Math.round(viewport.width), chunks });
}
writeFileSync(outPath, JSON.stringify(out));
console.log(
  outPath,
  out.map((page) => `p${page.pageNumber}:${page.chunks.length}`).join(" "),
);
