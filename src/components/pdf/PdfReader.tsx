"use client";

import {
  Highlighter,
  MousePointer2,
  PenLine,
  Save,
  Type as TypeIcon,
} from "lucide-react";
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
  editable?: boolean;
}

interface Preview {
  pageNumber: number;
}

type EditMode = "select" | "highlight" | "text" | "draw";

interface EditorTypes {
  NONE: number;
  HIGHLIGHT: number;
  FREETEXT: number;
  INK: number;
}

interface MutableAnnotationStorage {
  onSetModified: (() => void) | null;
  onResetModified: (() => void) | null;
  resetModified(): void;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

export function PdfReader({ src, title, editable = false }: PdfReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfViewerRef = useRef<PDFViewer | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const etagRef = useRef<string | null>(null);
  const editorTypesRef = useRef<EditorTypes | null>(null);
  const dirtyRef = useRef(false);
  const previewRef = useRef<Preview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [status, setStatus] = useState("Loading paper…");
  const [zoom, setZoom] = useState(100);
  const [editMode, setEditMode] = useState<EditMode>("select");
  const [editorReady, setEditorReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    if (!container || !viewerElement) return;

    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let viewerCleanup: (() => void) | null = null;
    const abortController = new AbortController();

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
          annotationEditorMode: editable
            ? pdfjs.AnnotationEditorType.NONE
            : pdfjs.AnnotationEditorType.DISABLE,
          annotationEditorHighlightColors:
            "Yellow=#fff066,Green=#8ee3a1,Blue=#8dc8ff,Pink=#ff9cce",
          enableSelectionRendering: true,
        });
        pdfViewerRef.current = pdfViewer;
        editorTypesRef.current = pdfjs.AnnotationEditorType;
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
        const onAnnotationEditorReady = () => setEditorReady(true);
        eventBus.on("pagesinit", onPagesInit);
        eventBus.on("pagechanging", onPageChanging);
        eventBus.on("scalechanging", onScaleChanging);
        eventBus.on("annotationeditoruimanager", onAnnotationEditorReady);

        const response = await fetch(src, {
          cache: "no-store",
          credentials: "same-origin",
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(`PDF request failed with ${response.status}.`);
        }
        const etag = response.headers.get("etag");
        if (editable && !etag) {
          throw new Error("The PDF did not include a save version.");
        }
        const data = new Uint8Array(await response.arrayBuffer());
        etagRef.current = etag;
        loadingTask = pdfjs.getDocument({ data });
        const document = await loadingTask.promise;
        if (disposed) {
          await loadingTask.destroy();
          return;
        }
        documentRef.current = document;
        setPdfDocument(document);
        setPageCount(document.numPages);
        if (editable) {
          const storage =
            document.annotationStorage as unknown as MutableAnnotationStorage;
          storage.onSetModified = () => {
            dirtyRef.current = true;
            setDirty(true);
            setSaveStatus("Unsaved changes");
          };
          storage.onResetModified = () => {
            dirtyRef.current = false;
            setDirty(false);
          };
        }
        linkService.setDocument(document);
        pdfViewer.setDocument(document);

        viewerCleanup = () => {
          eventBus.off("pagesinit", onPagesInit);
          eventBus.off("pagechanging", onPageChanging);
          eventBus.off("scalechanging", onScaleChanging);
          eventBus.off("annotationeditoruimanager", onAnnotationEditorReady);
          if (editable) {
            const storage =
              document.annotationStorage as unknown as MutableAnnotationStorage;
            storage.onSetModified = null;
            storage.onResetModified = null;
          }
          pdfViewer.cleanup();
        };
      } catch (error) {
        if (
          !disposed &&
          (!(error instanceof Error) || error.name !== "AbortError")
        ) {
          setStatus("The paper could not be displayed.");
        }
      }
    })();

    return () => {
      disposed = true;
      abortController.abort();
      viewerCleanup?.();
      pdfViewerRef.current = null;
      documentRef.current = null;
      etagRef.current = null;
      editorTypesRef.current = null;
      dirtyRef.current = false;
      setEditorReady(false);
      void loadingTask?.destroy();
    };
  }, [editable, src]);

  useEffect(() => {
    if (!editable) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [editable]);

  function chooseEditMode(nextMode: EditMode): void {
    const viewer = pdfViewerRef.current;
    const editorTypes = editorTypesRef.current;
    if (!viewer || !editorTypes) return;
    const modes: Record<EditMode, number> = {
      select: editorTypes.NONE,
      highlight: editorTypes.HIGHLIGHT,
      text: editorTypes.FREETEXT,
      draw: editorTypes.INK,
    };
    viewer.annotationEditorMode = { mode: modes[nextMode] };
    setEditMode(nextMode);
    setSaveStatus(
      dirtyRef.current
        ? "Unsaved changes"
        : nextMode === "select"
          ? ""
          : `${nextMode === "draw" ? "Draw" : nextMode} tool active`,
    );
  }

  async function saveAnnotations(): Promise<void> {
    const document = documentRef.current;
    const expectedEtag = etagRef.current;
    if (!document || !expectedEtag || saving || !dirty) return;

    setSaving(true);
    setSaveStatus("Saving annotations…");
    try {
      const bytes = await document.saveDocument();
      const response = await fetch(src, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": "application/pdf",
          "if-match": expectedEtag,
        },
        body: bytes,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          errorMessage(payload, `Save failed with ${response.status}.`),
        );
      }
      const nextEtag = response.headers.get("etag");
      if (!nextEtag) throw new Error("The save response had no PDF version.");
      etagRef.current = nextEtag;
      const storage =
        document.annotationStorage as unknown as MutableAnnotationStorage;
      storage.resetModified();
      dirtyRef.current = false;
      setDirty(false);
      setSaveStatus("Saved in the PDF");
    } catch (error) {
      setSaveStatus(
        error instanceof Error
          ? error.message
          : "Annotations could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

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
        {editable ? (
          <div className={styles.editorTools} aria-label="Annotation tools">
            <EditorButton
              label="Select"
              active={editMode === "select"}
              onClick={() => chooseEditMode("select")}
              disabled={!editorReady}
            >
              <MousePointer2 aria-hidden="true" />
            </EditorButton>
            <EditorButton
              label="Highlight"
              active={editMode === "highlight"}
              onClick={() => chooseEditMode("highlight")}
              disabled={!editorReady}
            >
              <Highlighter aria-hidden="true" />
            </EditorButton>
            <EditorButton
              label="Text"
              active={editMode === "text"}
              onClick={() => chooseEditMode("text")}
              disabled={!editorReady}
            >
              <TypeIcon aria-hidden="true" />
            </EditorButton>
            <EditorButton
              label="Draw"
              active={editMode === "draw"}
              onClick={() => chooseEditMode("draw")}
              disabled={!editorReady}
            >
              <PenLine aria-hidden="true" />
            </EditorButton>
            <button
              className={styles.saveButton}
              type="button"
              onClick={() => void saveAnnotations()}
              disabled={!editorReady || !dirty || saving}
              aria-label="Save annotations in PDF"
              title="Save annotations in PDF"
            >
              <Save aria-hidden="true" />
              <span>{saving ? "Saving…" : "Save"}</span>
            </button>
          </div>
        ) : (
          <span className={styles.hint}>Paper view</span>
        )}
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
      {editable && saveStatus && (
        <div
          className={`${styles.saveStatus} ${dirty ? styles.unsaved : ""}`}
          role="status"
        >
          {saveStatus}
        </div>
      )}
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

interface EditorButtonProps {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick(): void;
  children: React.ReactNode;
}

function EditorButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: EditorButtonProps) {
  return (
    <button
      className={`${styles.editorButton} ${active ? styles.activeTool : ""}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
      <span>{label}</span>
    </button>
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
