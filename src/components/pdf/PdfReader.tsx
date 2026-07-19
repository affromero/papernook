"use client";

import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { resolvePdfDestinationPage } from "@/lib/pdf/destinations";
import "pdfjs-dist/web/pdf_viewer.css";
import styles from "./PdfReader.module.css";

interface PdfReaderProps {
  src: string;
  title: string;
}

interface Preview {
  pageNumber: number;
}

export function PdfReader({ src, title }: PdfReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfViewerRef = useRef<PDFViewer | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [status, setStatus] = useState("Loading paper…");
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    if (!container || !viewerElement) return;

    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let viewerCleanup: (() => void) | null = null;

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const { EventBus, LinkTarget, PDFLinkService, PDFViewer } =
          await import("pdfjs-dist/web/pdf_viewer.mjs");

        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();

        const eventBus = new EventBus();
        const linkService = new PDFLinkService({
          eventBus,
          externalLinkTarget: LinkTarget.BLANK,
          externalLinkRel: "noopener noreferrer nofollow",
          ignoreDestinationZoom: true,
        });
        const pdfViewer = new PDFViewer({
          container,
          viewer: viewerElement,
          eventBus,
          linkService,
          removePageBorders: true,
        });
        pdfViewerRef.current = pdfViewer;
        linkService.setViewer(pdfViewer);

        const originalGoToDestination =
          linkService.goToDestination.bind(linkService);
        const interceptDestination: typeof linkService.goToDestination = async (
          destination,
        ) => {
          const document = documentRef.current;
          if (!document) return;
          const targetPage = await resolvePdfDestinationPage(
            document,
            destination,
          );
          if (!targetPage) {
            await originalGoToDestination(destination);
            return;
          }
          if (previewRef.current?.pageNumber === targetPage) {
            window.open(`${src}#page=${targetPage}`, "_blank", "noopener");
            return;
          }
          const nextPreview = { pageNumber: targetPage };
          previewRef.current = nextPreview;
          setPreview(nextPreview);
        };
        linkService.goToDestination = interceptDestination;

        const onPagesInit = () => {
          pdfViewer.currentScaleValue = "page-width";
          setStatus("");
        };
        const onPageChanging = (event: unknown) => {
          if (
            event &&
            typeof event === "object" &&
            "pageNumber" in event &&
            typeof event.pageNumber === "number"
          ) {
            setPageNumber(event.pageNumber);
          }
        };
        const onScaleChanging = (event: unknown) => {
          if (
            event &&
            typeof event === "object" &&
            "scale" in event &&
            typeof event.scale === "number"
          ) {
            setZoom(Math.round(event.scale * 100));
          }
        };
        eventBus.on("pagesinit", onPagesInit);
        eventBus.on("pagechanging", onPageChanging);
        eventBus.on("scalechanging", onScaleChanging);

        loadingTask = pdfjs.getDocument({ url: src });
        const document = await loadingTask.promise;
        if (disposed) {
          await loadingTask.destroy();
          return;
        }
        documentRef.current = document;
        setPdfDocument(document);
        setPageCount(document.numPages);
        linkService.setDocument(document);
        pdfViewer.setDocument(document);

        viewerCleanup = () => {
          eventBus.off("pagesinit", onPagesInit);
          eventBus.off("pagechanging", onPageChanging);
          eventBus.off("scalechanging", onScaleChanging);
          pdfViewer.cleanup();
        };
      } catch {
        if (!disposed) {
          setStatus("The paper could not be displayed.");
        }
      }
    })();

    return () => {
      disposed = true;
      viewerCleanup?.();
      pdfViewerRef.current = null;
      documentRef.current = null;
      void loadingTask?.destroy();
    };
  }, [src]);

  function closePreview(): void {
    previewRef.current = null;
    setPreview(null);
  }

  useEffect(() => {
    if (!preview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [preview]);

  return (
    <div className={styles.root} aria-label={title}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarGroup}>
          <button
            type="button"
            onClick={() => pdfViewerRef.current?.previousPage()}
            disabled={pageNumber <= 1}
            aria-label="Previous page"
          >
            ←
          </button>
          <span className={styles.pageStatus}>
            Page {pageNumber}
            {pageCount > 0 ? ` of ${pageCount}` : ""}
          </span>
          <button
            type="button"
            onClick={() => pdfViewerRef.current?.nextPage()}
            disabled={pageCount === 0 || pageNumber >= pageCount}
            aria-label="Next page"
          >
            →
          </button>
        </div>
        <span className={styles.hint}>
          Reference links preview without losing your place
        </span>
        <div className={styles.toolbarGroup}>
          <button
            type="button"
            onClick={() => pdfViewerRef.current?.decreaseScale()}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className={styles.zoom}>{zoom}%</span>
          <button
            type="button"
            onClick={() => pdfViewerRef.current?.increaseScale()}
            aria-label="Zoom in"
          >
            +
          </button>
          <a
            className={styles.originalLink}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open original PDF in a new tab"
          >
            ↗
          </a>
        </div>
      </div>
      <div className={styles.stage}>
        <div className={styles.container} ref={containerRef}>
          <div className="pdfViewer" ref={viewerRef} />
          {status && (
            <p className={styles.status} role="status">
              {status}
            </p>
          )}
        </div>
        {preview && pdfDocument && (
          <ReferencePreview
            document={pdfDocument}
            pageNumber={preview.pageNumber}
            src={src}
            onClose={closePreview}
          />
        )}
      </div>
    </div>
  );
}

interface ReferencePreviewProps {
  document: PDFDocumentProxy;
  pageNumber: number;
  src: string;
  onClose(): void;
}

function ReferencePreview({
  document,
  pageNumber,
  src,
  onClose,
}: ReferencePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("Loading reference…");

  useEffect(() => {
    let disposed = false;
    let renderTask: RenderTask | null = null;

    void (async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (disposed) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;

        const unscaled = page.getViewport({ scale: 1 });
        const scale = Math.min(1.35, 620 / unscaled.width);
        const viewport = page.getViewport({ scale });
        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const renderViewport = page.getViewport({ scale: scale * pixelRatio });
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport: renderViewport,
        });
        await renderTask.promise;
        if (!disposed) setStatus("");
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
  }, [document, pageNumber]);

  return (
    <aside
      className={styles.preview}
      aria-label={`Reference preview, page ${pageNumber}`}
    >
      <div className={styles.previewHeader}>
        <div>
          <span className={styles.previewEyebrow}>Reference preview</span>
          <strong>Page {pageNumber}</strong>
        </div>
        <button
          className={styles.close}
          type="button"
          onClick={onClose}
          aria-label="Close reference preview"
        >
          ×
        </button>
      </div>
      <p className={styles.previewHelp}>
        Your reading position is unchanged. Select the same reference again or
        open it separately.
      </p>
      <div className={styles.previewPage}>
        <canvas ref={canvasRef} />
        {status && <p className={styles.previewStatus}>{status}</p>}
      </div>
      <a
        className={styles.openLink}
        href={`${src}#page=${pageNumber}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open page in new tab ↗
      </a>
    </aside>
  );
}
