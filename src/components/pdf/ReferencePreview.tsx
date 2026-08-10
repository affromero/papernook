"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { PDFDocumentProxy, PageViewport, RenderTask } from "pdfjs-dist";
import type { ResolvedPdfDestination } from "@/lib/pdf/destinations";
import type { PdfTextChunk } from "@/lib/pdf/bibliography";
import { referenceTextAtPoint } from "@/lib/pdf/reference-text";
import { pdfTextItems } from "@/lib/pdf/text-items";
import styles from "./PdfReader.module.css";

export interface Preview {
  destination: ResolvedPdfDestination;
  horizontal: "left" | "right";
  vertical: "top" | "bottom";
}

interface ReferencePreviewProps {
  document: PDFDocumentProxy;
  preview: Preview;
  /**
   * Look the cited entry up in the library (session-authed API) — only
   * passed by signed-in surfaces, never the public share page.
   */
  libraryLookup?: boolean;
  onClose(): void;
}

interface LibraryMatch {
  topic: string;
  slug: string;
  title: string;
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
  const items = await pdfTextItems(page);
  const chunks: PdfTextChunk[] = [];
  for (const item of items) {
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
  libraryLookup = false,
  onClose,
}: ReferencePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mappingRef = useRef<CropMapping | null>(null);
  const [status, setStatus] = useState("Loading reference…");
  // Keyed by destination so a stale lookup never renders for a new target —
  // no reset-in-effect needed.
  const [libraryMatch, setLibraryMatch] = useState<{
    key: string;
    match: LibraryMatch | null;
  } | null>(null);
  const { destination } = preview;
  const destinationKey = `${destination.pageNumber}:${destination.left}:${destination.top}`;
  const currentMatch =
    libraryMatch?.key === destinationKey ? libraryMatch.match : null;

  // Safari kills window.open issued after an await (outside the click's
  // gesture), so open the tab synchronously and point it at the search once
  // the reference text resolves.
  function searchViaPopup(resolve: () => Promise<string | null>): void {
    const popup = window.open("about:blank", "_blank");
    void resolve()
      .then((reference) => {
        if (!reference) {
          popup?.close();
          return;
        }
        const url = `https://www.google.com/search?q=${encodeURIComponent(reference)}`;
        if (popup) popup.location.href = url;
        else window.open(url, "_blank", "noopener,noreferrer");
      })
      .catch((error: unknown) => {
        popup?.close();
        console.error("papernook: reference search failed", error);
      });
  }

  // The citation's GoTo destination points at the entry's marker, so the
  // header button searches exactly the referenced entry's full text.
  function searchTargetReference(): void {
    const mapping = mappingRef.current;
    const { left, top } = destination;
    if (!mapping || left === null || top === null) return;
    searchViaPopup(async () => {
      const chunks = await pageTextChunks(document, destination.pageNumber);
      return referenceTextAtPoint(
        chunks,
        { x: left + 15, y: top - 6 },
        mapping.pageWidth,
      );
    });
  }

  // Map the click back through the crop into PDF coordinates, find the
  // bibliography entry under it, and web-search that citation.
  function searchClickedReference(event: MouseEvent<HTMLCanvasElement>): void {
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
    searchViaPopup(async () => {
      const chunks = await pageTextChunks(document, destination.pageNumber);
      return referenceTextAtPoint(
        chunks,
        { x: pdfX, y: pdfY },
        mapping.pageWidth,
      );
    });
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

        // Eagerly resolve the cited entry against the library so the header
        // can offer "In your library" (signed-in surfaces only).
        const { left, top } = destination;
        if (libraryLookup && left !== null && top !== null) {
          void (async () => {
            const chunks = await pageTextChunks(
              document,
              destination.pageNumber,
            );
            const reference = referenceTextAtPoint(
              chunks,
              { x: left + 15, y: top - 6 },
              base.width,
            );
            if (!reference || disposed) return;
            const response = await fetch(
              `/api/v1/citations/match?q=${encodeURIComponent(reference)}`,
              { credentials: "same-origin" },
            );
            if (!response.ok || disposed) return;
            const data = (await response.json()) as {
              match: LibraryMatch | null;
            };
            if (!disposed) {
              setLibraryMatch({
                key: `${destination.pageNumber}:${left}:${top}`,
                match: data.match,
              });
            }
          })().catch(() => undefined);
        }
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
  }, [destination, document, libraryLookup]);

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
        {currentMatch && (
          <a
            className={styles.previewLibrary}
            href={`/paper/${currentMatch.topic}/${currentMatch.slug}`}
            title={currentMatch.title}
          >
            In your library
          </a>
        )}
        <button
          className={styles.previewOpen}
          type="button"
          onClick={searchTargetReference}
          aria-label="Search this reference on the web"
          title="Search this reference on the web"
        >
          🔍
        </button>
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
          onClick={searchClickedReference}
          title="Click a reference to search it on the web"
        />
        {status && <p className={styles.previewStatus}>{status}</p>}
      </div>
    </aside>
  );
}
