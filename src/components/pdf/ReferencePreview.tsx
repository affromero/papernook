"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { PDFDocumentProxy, PageViewport, RenderTask } from "pdfjs-dist";
import type { ResolvedPdfDestination } from "@/lib/pdf/destinations";
import {
  referenceTextAtPoint,
  type PdfTextChunk,
} from "@/lib/pdf/reference-text";
import styles from "./PdfReader.module.css";

export interface Preview {
  destination: ResolvedPdfDestination;
  horizontal: "left" | "right";
  vertical: "top" | "bottom";
}

interface ReferencePreviewProps {
  document: PDFDocumentProxy;
  preview: Preview;
  /** Same-origin PDF URL with a #page anchor for "open in new tab". */
  pageHref: string;
  onClose(): void;
}

/** Preview canvas CSS box; the crop is rendered to exactly this aspect. */
const PREVIEW_WIDTH = 560;
const PREVIEW_HEIGHT = 210;
/** Fraction of the page width trimmed per side (past the text margins). */
const PREVIEW_MARGIN_TRIM = 0.055;

/**
 * Rendered-page cache: references cluster on the same bibliography pages, so
 * re-hovering must not re-render the whole page (the slow step). Keyed by
 * document identity (WeakMap, so closing a PDF frees its pages) and
 * page@pixelRatio.
 */
const pageCanvasCache = new WeakMap<
  PDFDocumentProxy,
  Map<string, HTMLCanvasElement>
>();
const pageTextCache = new WeakMap<
  PDFDocumentProxy,
  Map<number, PdfTextChunk[]>
>();

interface CropMapping {
  viewport: PageViewport;
  sourceX: number;
  sourceY: number;
  pageWidth: number;
}

function isRawTextItem(
  item: unknown,
): item is { str: string; transform: number[] } {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as { str: unknown }).str === "string" &&
    "transform" in item &&
    Array.isArray((item as { transform: unknown }).transform)
  );
}

async function pageTextChunks(
  document: PDFDocumentProxy,
  pageNumber: number,
): Promise<PdfTextChunk[]> {
  let cache = pageTextCache.get(document);
  if (!cache) {
    cache = new Map();
    pageTextCache.set(document, cache);
  }
  const cached = cache.get(pageNumber);
  if (cached) return cached;
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent();
  const chunks: PdfTextChunk[] = [];
  for (const item of content.items as unknown[]) {
    if (isRawTextItem(item)) {
      chunks.push({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
      });
    }
  }
  cache.set(pageNumber, chunks);
  return chunks;
}

export function ReferencePreview({
  document,
  preview,
  pageHref,
  onClose,
}: ReferencePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mappingRef = useRef<CropMapping | null>(null);
  const [status, setStatus] = useState("Loading reference…");
  const { destination } = preview;

  // Map the click back through the crop into PDF coordinates, find the
  // bibliography entry under it, and web-search that citation.
  async function searchClickedReference(
    event: MouseEvent<HTMLCanvasElement>,
  ): Promise<void> {
    const canvas = canvasRef.current;
    const mapping = mappingRef.current;
    if (!canvas || !mapping) return;
    const rect = canvas.getBoundingClientRect();
    const cropX =
      ((event.clientX - rect.left) / rect.width) * canvas.width +
      mapping.sourceX;
    const cropY =
      ((event.clientY - rect.top) / rect.height) * canvas.height +
      mapping.sourceY;
    const [pdfX, pdfY] = mapping.viewport.convertToPdfPoint(cropX, cropY);
    const chunks = await pageTextChunks(document, destination.pageNumber);
    const reference = referenceTextAtPoint(
      chunks,
      { x: pdfX, y: pdfY },
      mapping.pageWidth,
    );
    if (!reference) return;
    window.open(
      `https://www.google.com/search?q=${encodeURIComponent(reference)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  useEffect(() => {
    let disposed = false;
    let renderTask: RenderTask | null = null;

    void (async () => {
      try {
        const page = await document.getPage(destination.pageNumber);
        if (disposed) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;

        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        // Fit the full text column into the preview width so bibliography
        // lines are never cut horizontally: scale the page such that the
        // margin-trimmed width maps exactly onto the canvas box.
        const base = page.getViewport({ scale: 1 });
        const scale =
          PREVIEW_WIDTH / (base.width * (1 - 2 * PREVIEW_MARGIN_TRIM));
        const cacheKey = `${destination.pageNumber}@${pixelRatio}`;
        let cache = pageCanvasCache.get(document);
        if (!cache) {
          cache = new Map();
          pageCanvasCache.set(document, cache);
        }
        const viewport = page.getViewport({ scale: scale * pixelRatio });
        let source = cache.get(cacheKey);
        if (!source) {
          source = window.document.createElement("canvas");
          source.width = Math.ceil(viewport.width);
          source.height = Math.ceil(viewport.height);
          const sourceContext = source.getContext("2d");
          if (!sourceContext) return;
          renderTask = page.render({
            canvas: source,
            canvasContext: sourceContext,
            viewport,
          });
          await renderTask.promise;
          if (disposed) return;
          cache.set(cacheKey, source);
        }

        const cropWidth = Math.min(
          source.width,
          Math.round(PREVIEW_WIDTH * pixelRatio),
        );
        const cropHeight = Math.min(
          source.height,
          Math.round(PREVIEW_HEIGHT * pixelRatio),
        );
        const point =
          destination.left !== null && destination.top !== null
            ? viewport.convertToViewportPoint(destination.left, destination.top)
            : [source.width / 2, Math.min(source.height / 2, cropHeight / 2)];
        const sourceX = Math.max(
          0,
          Math.min(
            source.width - cropWidth,
            Math.round(base.width * PREVIEW_MARGIN_TRIM * scale * pixelRatio),
          ),
        );
        const sourceY = Math.max(
          0,
          Math.min(source.height - cropHeight, point[1] - cropHeight / 3),
        );
        canvas.width = cropWidth;
        canvas.height = cropHeight;
        context.drawImage(
          source,
          sourceX,
          sourceY,
          cropWidth,
          cropHeight,
          0,
          0,
          cropWidth,
          cropHeight,
        );
        mappingRef.current = {
          viewport,
          sourceX,
          sourceY,
          pageWidth: base.width,
        };
        setStatus("");
      } catch (error) {
        if (
          !disposed &&
          (!(error instanceof Error) ||
            error.name !== "RenderingCancelledException")
        ) {
          setStatus("This reference preview could not be rendered.");
        }
      }
    })();

    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [destination, document]);

  return (
    <aside
      className={`${styles.preview} ${
        preview.horizontal === "left" ? styles.previewLeft : styles.previewRight
      } ${
        preview.vertical === "top" ? styles.previewTop : styles.previewBottom
      }`}
      data-reference-preview=""
      aria-label={`Reference preview, page ${destination.pageNumber}`}
    >
      <div className={styles.previewHeader}>
        <span className={styles.previewEyebrow}>
          Reference · page {destination.pageNumber}
        </span>
        <a
          className={styles.previewOpen}
          href={pageHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open page ${destination.pageNumber} in a new tab`}
          title="Open in new tab"
        >
          ↗
        </a>
        <button
          className={styles.close}
          type="button"
          onClick={onClose}
          aria-label="Close reference preview"
        >
          ×
        </button>
      </div>
      <div className={styles.previewPage}>
        <canvas
          ref={canvasRef}
          onClick={(event) => void searchClickedReference(event)}
          title="Click a reference to search it on the web"
        />
        {status && <p className={styles.previewStatus}>{status}</p>}
      </div>
    </aside>
  );
}
