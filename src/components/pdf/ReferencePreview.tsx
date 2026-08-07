"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { ResolvedPdfDestination } from "@/lib/pdf/destinations";
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

export function ReferencePreview({
  document,
  preview,
  pageHref,
  onClose,
}: ReferencePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("Loading reference…");
  const { destination } = preview;

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
        <canvas ref={canvasRef} />
        {status && <p className={styles.previewStatus}>{status}</p>}
      </div>
    </aside>
  );
}
