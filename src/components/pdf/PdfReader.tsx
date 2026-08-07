"use client";

import {
  Highlighter,
  Maximize2,
  Minimize2,
  MousePointer2,
  PenLine,
  Save,
  Type as TypeIcon,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { resolvePdfDestination } from "@/lib/pdf/destinations";
import { resolvePdfDocumentTitle } from "@/lib/pdf/title";
import {
  createPdfAutosave,
  type PdfAutosaveCoordinator,
} from "@/lib/pdf/autosave";
import "pdfjs-dist/web/pdf_viewer.css";
import styles from "./PdfReader.module.css";
import { ReferencePreview, type Preview } from "./ReferencePreview";

export interface PdfReaderEditState {
  dirty: boolean;
  saving: boolean;
}

interface PdfReaderProps {
  src: string;
  title: string;
  /** Where "open original" points when src is a proxy URL (viewer mode). */
  originalHref?: string;
  editable?: boolean;
  onClose?(): void;
  onEditStateChange?(state: PdfReaderEditState): void;
  /** Fired with the PDF's embedded Title metadata when it has one. */
  onDocumentTitle?(title: string): void;
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
}

class PdfSaveConflictError extends Error {}

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

export function PdfReader({
  src,
  title,
  originalHref,
  editable = false,
  onClose,
  onEditStateChange,
  onDocumentTitle,
}: PdfReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfViewerRef = useRef<PDFViewer | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const etagRef = useRef<string | null>(null);
  const editorTypesRef = useRef<EditorTypes | null>(null);
  const autosaveRef = useRef<PdfAutosaveCoordinator | null>(null);
  const pendingPenRef = useRef(false);
  const pinchDistanceRef = useRef<number | null>(null);
  const referenceAnchorRef = useRef<Pick<
    Preview,
    "horizontal" | "vertical"
  > | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const onEditStateChangeRef = useRef(onEditStateChange);
  const onDocumentTitleRef = useRef(onDocumentTitle);
  const previewRef = useRef<Preview | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverLinkRef = useRef<HTMLAnchorElement | null>(null);
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
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const [pencilMode, setPencilMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    onEditStateChangeRef.current = onEditStateChange;
  }, [onEditStateChange]);

  useEffect(() => {
    onDocumentTitleRef.current = onDocumentTitle;
  }, [onDocumentTitle]);

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
          const target = await resolvePdfDestination(document, destination);
          if (!target) {
            await originalGoToDestination(destination);
            return;
          }
          const focusedLink =
            window.document.activeElement instanceof HTMLElement
              ? window.document.activeElement.closest("a")
              : null;
          const focusedRect = focusedLink?.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const anchor = referenceAnchorRef.current ?? {
            horizontal:
              focusedRect &&
              focusedRect.left + focusedRect.width / 2 <
                containerRect.left + containerRect.width / 2
                ? "left"
                : "right",
            vertical:
              focusedRect &&
              focusedRect.top + focusedRect.height / 2 <
                containerRect.top + containerRect.height / 2
                ? "top"
                : "bottom",
          };
          const nextPreview = { destination: target, ...anchor };
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
        const onAnnotationEditorReady = () => {
          setEditorReady(true);
          if (pendingPenRef.current) {
            pendingPenRef.current = false;
            setPencilMode(true);
            pdfViewer.annotationEditorMode = {
              mode: pdfjs.AnnotationEditorType.INK,
            };
            setEditMode("draw");
            setSaveStatus(
              "Pencil detected; Draw enabled, touch reserved for pinch zoom",
            );
          }
        };
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
        if (onDocumentTitleRef.current) {
          void resolvePdfDocumentTitle(document)
            .then((resolved) => {
              if (resolved) onDocumentTitleRef.current?.(resolved);
            })
            .catch(() => undefined);
        }
        if (editable) {
          const storage =
            document.annotationStorage as unknown as MutableAnnotationStorage;
          const coordinator = createPdfAutosave({
            delayMs: 1_800,
            save: async () => {
              const expectedEtag = etagRef.current;
              if (!expectedEtag) {
                throw new Error("The PDF has no save version.");
              }
              const focused = containerRef.current?.querySelector(":focus");
              if (focused instanceof HTMLElement) focused.blur();
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
              if (response.status === 409 || response.status === 412) {
                throw new PdfSaveConflictError(
                  errorMessage(
                    payload,
                    "The PDF changed elsewhere. Reload before saving.",
                  ),
                );
              }
              if (!response.ok) {
                throw new Error(
                  errorMessage(payload, `Save failed with ${response.status}.`),
                );
              }
              const nextEtag = response.headers.get("etag");
              if (!nextEtag) {
                throw new Error("The save response had no PDF version.");
              }
              etagRef.current = nextEtag;
            },
            onChange: (next) => {
              dirtyRef.current = next.dirty;
              savingRef.current = next.saving;
              setDirty(next.dirty);
              setSaving(next.saving);
              onEditStateChangeRef.current?.({
                dirty: next.dirty,
                saving: next.saving,
              });
              if (next.saving) {
                setSaveStatus("Saving annotations…");
              } else if (next.error instanceof PdfSaveConflictError) {
                setRemoteUpdate(true);
                setSaveStatus(next.error.message);
                autosaveRef.current?.pause();
              } else if (next.error) {
                setSaveStatus(next.error.message);
              } else if (next.dirty) {
                setSaveStatus("Unsaved changes");
              } else {
                setSaveStatus("Saved");
              }
            },
          });
          autosaveRef.current = coordinator;
          storage.onSetModified = () => {
            coordinator.markDirty();
          };
          storage.onResetModified = null;
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
            autosaveRef.current?.stop();
            autosaveRef.current = null;
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
      autosaveRef.current?.stop();
      autosaveRef.current = null;
      dirtyRef.current = false;
      savingRef.current = false;
      onEditStateChangeRef.current?.({ dirty: false, saving: false });
      pendingPenRef.current = false;
      pinchDistanceRef.current = null;
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

  useEffect(() => {
    if (!editable) return;
    const saveBeforeClientNavigation = (event: MouseEvent) => {
      if (
        !dirtyRef.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      const anchor =
        target instanceof Element
          ? target.closest<HTMLAnchorElement>("a")
          : null;
      if (
        !anchor?.href ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.href === window.location.href
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      void (async () => {
        const autosave = autosaveRef.current;
        await autosave?.flush();
        const state = autosave?.state();
        if (state && !state.dirty && !state.saving && !state.error) {
          window.location.assign(destination.href);
        }
      })();
    };
    document.addEventListener("click", saveBeforeClientNavigation, true);
    return () =>
      document.removeEventListener("click", saveBeforeClientNavigation, true);
  }, [editable]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !pencilMode) return;
    const reserveTouch = (event: TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const touchDistance = (event: TouchEvent): number | null => {
      if (event.touches.length !== 2) return null;
      const first = event.touches[0];
      const second = event.touches[1];
      if (!first || !second) return null;
      return Math.hypot(
        second.clientX - first.clientX,
        second.clientY - first.clientY,
      );
    };
    const beginGesture = (event: TouchEvent) => {
      reserveTouch(event);
      pinchDistanceRef.current = touchDistance(event);
    };
    const updateGesture = (event: TouchEvent) => {
      reserveTouch(event);
      const nextDistance = touchDistance(event);
      const previousDistance = pinchDistanceRef.current;
      if (!nextDistance || !previousDistance) {
        pinchDistanceRef.current = nextDistance;
        return;
      }
      const first = event.touches[0];
      const second = event.touches[1];
      if (!first || !second) return;
      pdfViewerRef.current?.updateScale({
        drawingDelay: 180,
        scaleFactor: nextDistance / previousDistance,
        origin: [
          (first.clientX + second.clientX) / 2,
          (first.clientY + second.clientY) / 2,
        ],
      });
      pinchDistanceRef.current = nextDistance;
    };
    const endGesture = (event: TouchEvent) => {
      reserveTouch(event);
      if (event.touches.length < 2) pinchDistanceRef.current = null;
    };
    const options: AddEventListenerOptions = {
      capture: true,
      passive: false,
    };
    stage.addEventListener("touchstart", beginGesture, options);
    stage.addEventListener("touchmove", updateGesture, options);
    stage.addEventListener("touchend", endGesture, options);
    stage.addEventListener("touchcancel", endGesture, options);
    return () => {
      stage.removeEventListener("touchstart", beginGesture, options);
      stage.removeEventListener("touchmove", updateGesture, options);
      stage.removeEventListener("touchend", endGesture, options);
      stage.removeEventListener("touchcancel", endGesture, options);
    };
  }, [pencilMode]);

  useEffect(() => {
    if (!editable || !pdfDocument) return;

    let disposed = false;
    const checkVersion = async () => {
      if (
        disposed ||
        document.visibilityState !== "visible" ||
        savingRef.current ||
        remoteUpdate
      ) {
        return;
      }
      const baseline = etagRef.current;
      if (!baseline) return;
      try {
        const response = await fetch(src, {
          method: "HEAD",
          cache: "no-store",
          credentials: "same-origin",
        });
        if (disposed || response.status === 409) return;
        if (!response.ok) return;
        const current = response.headers.get("etag");
        if (current && current !== baseline && etagRef.current === baseline) {
          autosaveRef.current?.pause();
          setRemoteUpdate(true);
          setSaveStatus(
            dirtyRef.current
              ? "This PDF changed elsewhere while you have unsaved annotations."
              : "This PDF changed elsewhere. Reload to see the latest version.",
          );
        }
      } catch {
        // Connectivity errors are transient; the next poll checks again.
      }
    };

    const interval = window.setInterval(() => void checkVersion(), 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [editable, pdfDocument, remoteUpdate, src]);

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
    await autosaveRef.current?.flush();
  }

  async function closeReader(): Promise<void> {
    if (dirtyRef.current) {
      await autosaveRef.current?.flush();
    }
    if (!dirtyRef.current && !savingRef.current) onClose?.();
  }

  function captureReferenceAnchor(event: PointerEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("a")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    referenceAnchorRef.current = {
      horizontal:
        event.clientX - bounds.left < bounds.width / 2 ? "left" : "right",
      vertical:
        event.clientY - bounds.top < bounds.height / 2 ? "top" : "bottom",
    };
  }

  // Hovering an internal GoTo link opens the reference preview after a short
  // dwell — clicking still works (and is the only path on touch/pen). The
  // synthetic click() is safe: goToDestination is intercepted above, and
  // external links (no .internalLink class) never hover-trigger.
  function scheduleHoverPreview(event: PointerEvent<HTMLDivElement>): void {
    if (event.pointerType !== "mouse") return;
    const target = event.target;
    const link = target instanceof Element ? target.closest("a") : null;
    // pdf.js marks GoTo annotations with data-internal-link on the section
    // wrapping the anchor; external links never carry it.
    if (!link || !link.closest("[data-internal-link]")) return;
    if (link === hoverLinkRef.current) return;
    cancelHoverPreview();
    hoverLinkRef.current = link as HTMLAnchorElement;
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchor: Pick<Preview, "horizontal" | "vertical"> = {
      horizontal:
        event.clientX - bounds.left < bounds.width / 2 ? "left" : "right",
      vertical:
        event.clientY - bounds.top < bounds.height / 2 ? "top" : "bottom",
    };
    hoverTimerRef.current = window.setTimeout(() => {
      referenceAnchorRef.current = anchor;
      hoverLinkRef.current?.click();
    }, 180);
  }

  function cancelHoverPreview(event?: PointerEvent<HTMLDivElement>): void {
    if (event) {
      const next = event.relatedTarget;
      if (
        next instanceof Element &&
        hoverLinkRef.current &&
        hoverLinkRef.current.contains(next)
      ) {
        return;
      }
    }
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverLinkRef.current = null;
  }

  function enablePencilDrawing(event: PointerEvent<HTMLDivElement>): void {
    captureReferenceAnchor(event);
    if (pencilMode && event.pointerType === "touch") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!editable || event.pointerType !== "pen") return;
    setPencilMode(true);
    if (editMode === "draw") {
      setSaveStatus("Pencil detected; touch reserved for pinch zoom");
      return;
    }
    const viewer = pdfViewerRef.current;
    const editorTypes = editorTypesRef.current;
    if (!viewer || !editorTypes || !editorReady) {
      pendingPenRef.current = true;
      return;
    }
    viewer.annotationEditorMode = { mode: editorTypes.INK };
    setEditMode("draw");
    setSaveStatus(
      "Pencil detected; Draw enabled, touch reserved for pinch zoom",
    );
  }

  function reloadLatest(): void {
    if (
      dirtyRef.current &&
      !window.confirm(
        "Reloading will discard your unsaved browser annotations. Continue?",
      )
    ) {
      return;
    }
    window.location.reload();
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
    // Clicking anywhere outside the popover dismisses it; clicking another
    // citation closes here first, then its own handler opens the new one.
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-reference-preview]")
      )
        return;
      closePreview();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [preview]);

  useEffect(() => {
    if (!fullscreen) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [fullscreen]);

  return (
    <div
      className={`${styles.root} ${saving ? styles.saving : ""} ${
        fullscreen ? styles.fullscreen : ""
      }`}
      aria-label={title}
    >
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
              disabled={!editorReady || !dirty || saving || remoteUpdate}
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
          <button
            type="button"
            onClick={() => setFullscreen((current) => !current)}
            aria-label={
              fullscreen ? "Exit paper fullscreen" : "Paper fullscreen"
            }
            aria-pressed={fullscreen}
            title={fullscreen ? "Exit paper fullscreen" : "Paper fullscreen"}
          >
            {fullscreen ? (
              <Minimize2 aria-hidden="true" />
            ) : (
              <Maximize2 aria-hidden="true" />
            )}
          </button>
          <a
            className={styles.originalLink}
            href={originalHref ?? src}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open original PDF in a new tab"
          >
            ↗
          </a>
          {onClose && (
            <button
              type="button"
              onClick={() => void closeReader()}
              disabled={saving || remoteUpdate}
              aria-label={
                dirty ? "Save annotations and close" : "Close annotator"
              }
              title={dirty ? "Save annotations and close" : "Close annotator"}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {editable && saveStatus && !remoteUpdate && (
        <div
          className={`${styles.saveStatus} ${dirty ? styles.unsaved : ""}`}
          role="status"
        >
          {saveStatus}
        </div>
      )}
      {editable && remoteUpdate && (
        <div className={styles.remoteUpdate} role="alert">
          <span>{saveStatus}</span>
          <button type="button" onClick={reloadLatest}>
            Reload latest
          </button>
        </div>
      )}
      <div
        ref={stageRef}
        className={`${styles.stage} ${pencilMode ? styles.pencilMode : ""}`}
        onPointerDownCapture={enablePencilDrawing}
        onPointerOver={scheduleHoverPreview}
        onPointerOut={cancelHoverPreview}
      >
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
            preview={preview}
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
