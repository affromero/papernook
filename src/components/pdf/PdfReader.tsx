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
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ResolvedPdfDestination } from "@/lib/pdf/destinations";
import { resolvePdfDocumentTitle } from "@/lib/pdf/title";
import { usePdfVersionPoll } from "./usePdfVersionPoll";
import "pdfjs-dist/web/pdf_viewer.css";
import styles from "./PdfReader.module.css";
import { ReferencePreview, type Preview } from "./ReferencePreview";
import { PREVIEW_GAP, placePreview } from "./placePreview";
import {
  BIBLIOGRAPHY_EVENT,
  requestChatPrompt,
} from "@/lib/chat/paper-ref-events";
import { selectionPrompt } from "./selection/selectionAsk";
import { useTextSelectionAsk } from "./selection/useTextSelectionAsk";
import { useCitationHotspots } from "./useCitationHotspots";
import { usePaperRefBridge } from "./usePaperRefBridge";
import {
  usePdfDocument,
  type EditMode,
  type PdfReaderEditState,
} from "./usePdfDocument";
import { useMarginNotes } from "./notes/useMarginNotes";
import { usePinchZoom } from "./usePinchZoom";
import { useSaveOnLeave } from "./useSaveOnLeave";

export type { PdfReaderEditState } from "./usePdfDocument";

/**
 * The bibliography route reads at most 1MB of body; keep the cache PUT
 * under that with headroom so it is never silently rejected.
 */
const BIBLIOGRAPHY_PUT_MAX_BYTES = 900 * 1024;

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
  /** Let reference previews query the library (signed-in surfaces only). */
  libraryLookup?: boolean;
  /** Let reference previews hand prompts to a mounted chat composer. */
  chatPrompts?: boolean;
  /**
   * localStorage key that remembers the last page and zoom for this paper
   * (see `readingPositionKey`); omit to always open at the top.
   */
  positionKey?: string;
  /**
   * PUT the scanned bibliography here once per document open
   * (`/api/v1/papers/<topic>/<slug>/bibliography`), so readerless surfaces
   * (the canvas chat) and the library graph can use it. Only the paper page
   * passes this; viewer/share/canvas readers stay silent.
   */
  bibliographyEndpoint?: string;
}

export function PdfReader({
  src,
  title,
  originalHref,
  editable = false,
  onClose,
  onEditStateChange,
  onDocumentTitle,
  libraryLookup = false,
  chatPrompts = false,
  positionKey,
  bibliographyEndpoint,
}: PdfReaderProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const referenceAnchorRef = useRef<Pick<Preview, "horizontal" | "top"> | null>(
    null,
  );
  const onDocumentTitleRef = useRef(onDocumentTitle);
  const previewRef = useRef<Preview | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverLinkRef = useRef<HTMLAnchorElement | null>(null);
  // One PUT per loaded document: a reload (documentGeneration bump, new
  // src) yields a new proxy and re-publishes; re-renders never re-PUT.
  const bibliographyPutRef = useRef<PDFDocumentProxy | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const {
    containerRef,
    viewerRef,
    pdfViewerRef,
    etagRef,
    editorTypesRef,
    autosaveRef,
    uiManagerRef,
    pendingPenRef,
    dirtyRef,
    savingRef,
    restoreViewRef,
    hoverPreviewRequestedRef,
    bibliographyRef,
    pdfDocument,
    viewerBus,
    pageNumber,
    pageCount,
    status,
    zoom,
    editMode,
    setEditMode,
    editorReady,
    dirty,
    saving,
    saveStatus,
    setSaveStatus,
    remoteUpdate,
    pencilMode,
    setPencilMode,
    setDocumentGeneration,
  } = usePdfDocument({
    src,
    editable,
    positionKey,
    onEditStateChange,
    onHoverPreview: (target) => showReferencePreview(target, null, null),
  });

  useEffect(() => {
    onDocumentTitleRef.current = onDocumentTitle;
  }, [onDocumentTitle]);

  // Separate from the load effect so any resolution failure is isolated and
  // loud instead of vanishing inside the loader's error handling.
  useEffect(() => {
    if (!pdfDocument || !onDocumentTitleRef.current) return;
    let cancelled = false;
    resolvePdfDocumentTitle(pdfDocument)
      .then((resolved) => {
        if (!cancelled && resolved) onDocumentTitleRef.current?.(resolved);
      })
      .catch((error: unknown) => {
        console.error("papernook: document title resolution failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

  useSaveOnLeave(editable, dirtyRef, autosaveRef);

  useMarginNotes({
    pdfDocument,
    editable,
    pdfViewerRef,
    uiManagerRef,
    autosaveRef,
    restoreViewRef,
    remoteUpdate,
    setEditMode,
    setSaveStatus,
    setDocumentGeneration,
  });

  usePinchZoom(stageRef, pdfViewerRef, pencilMode);

  // Read-only readers have no edit mode, yet their text layer is just as
  // selectable; only the ink/highlight tools of an editable reader hide it.
  const { selection, clear: clearSelectionAsk } = useTextSelectionAsk(
    stageRef,
    chatPrompts && (!editable || editMode === "select"),
  );

  function askAboutSelection(): void {
    if (!selection) return;
    requestChatPrompt(selectionPrompt(selection.text, selection.page));
    window.getSelection()?.removeAllRanges();
    clearSelectionAsk();
  }

  usePdfVersionPoll({
    enabled: editable && !!pdfDocument && !remoteUpdate,
    src,
    etagRef,
    savingRef,
    dirtyRef,
    onRemoteUpdate: () => {
      // Nothing unsaved here, so another session's annotations can be
      // picked up silently: remount the document at the same page and
      // zoom instead of interrupting with a reload banner.
      const viewer = pdfViewerRef.current;
      if (viewer) {
        restoreViewRef.current = {
          page: viewer.currentPageNumber,
          scale: viewer.currentScale,
        };
      }
      setEditMode("select");
      setSaveStatus("Updated with annotations saved in another session.");
      setDocumentGeneration((generation) => generation + 1);
    },
  });

  function chooseEditMode(nextMode: EditMode): void {
    const viewer = pdfViewerRef.current;
    const editorTypes = editorTypesRef.current;
    if (!viewer || !editorTypes) return;
    cancelHoverPreview();
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
    referenceAnchorRef.current = placePreview(
      event,
      event.currentTarget.getBoundingClientRect(),
    );
  }

  function scheduleHoverPreview(event: PointerEvent<HTMLDivElement>): void {
    if (editable && editMode !== "select") return;
    if (event.pointerType !== "mouse") return;
    const target = event.target;
    const link = target instanceof Element ? target.closest("a") : null;
    // pdf.js marks GoTo annotations with data-internal-link on the section
    // wrapping the anchor; external links never carry it.
    if (!link || !link.closest("[data-internal-link]")) return;
    if (link === hoverLinkRef.current) return;
    cancelHoverPreview();
    hoverLinkRef.current = link as HTMLAnchorElement;
    const anchor = placePreview(
      event,
      event.currentTarget.getBoundingClientRect(),
    );
    hoverTimerRef.current = window.setTimeout(() => {
      referenceAnchorRef.current = anchor;
      const link = hoverLinkRef.current;
      if (!link) return;
      hoverPreviewRequestedRef.current = true;
      try {
        link.click();
      } finally {
        hoverPreviewRequestedRef.current = false;
      }
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

  function showReferencePreview(
    target: ResolvedPdfDestination,
    entryText: string | null,
    at: { clientX: number; clientY: number } | null,
    ref?: Preview["ref"],
  ): void {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    // Prefer the trigger, then the captured pointer, then keyboard focus.
    let point = at;
    if (!point && !referenceAnchorRef.current) {
      const link =
        window.document.activeElement instanceof HTMLElement
          ? window.document.activeElement.closest("a")
          : null;
      const linkRect = link?.getBoundingClientRect();
      if (linkRect) {
        point = {
          clientX: linkRect.left + linkRect.width / 2,
          clientY: linkRect.top + linkRect.height / 2,
        };
      }
    }
    const anchor: Pick<Preview, "horizontal" | "top"> = point
      ? placePreview(point, rect)
      : (referenceAnchorRef.current ?? {
          horizontal: "right",
          top: PREVIEW_GAP,
        });
    const nextPreview = {
      destination: target,
      ...(entryText === null ? {} : { entryText }),
      ...(ref ? { ref } : {}),
      ...anchor,
    };
    previewRef.current = nextPreview;
    setPreview(nextPreview);
  }

  useCitationHotspots({
    pdfDocument,
    eventBus: viewerBus,
    enabled: !editable || editMode === "select",
    onCitation: (target) =>
      showReferencePreview(target.destination, target.entryText, target),
    onBibliography: (bibliography) => {
      bibliographyRef.current = bibliography;
      window.dispatchEvent(
        new CustomEvent(BIBLIOGRAPHY_EVENT, { detail: bibliography }),
      );
      if (
        !bibliographyEndpoint ||
        !pdfDocument ||
        bibliographyPutRef.current === pdfDocument
      ) {
        return;
      }
      bibliographyPutRef.current = pdfDocument;
      // Fire-and-forget cache write; the store schema bounds entry text
      // and entry count tighter than the in-memory scan. The serialized
      // body must also fit the route's bounded JSON reader (1MB) or the
      // PUT 400s silently, so trim trailing entries until it fits.
      let entries = bibliography.entries.slice(0, 2000).map((entry) => ({
        ...entry,
        text: entry.text.slice(0, 400),
        surname: entry.surname?.slice(0, 200) ?? null,
      }));
      let body = JSON.stringify({ style: bibliography.style, entries });
      while (
        entries.length > 0 &&
        new TextEncoder().encode(body).length > BIBLIOGRAPHY_PUT_MAX_BYTES
      ) {
        entries = entries.slice(0, Math.floor(entries.length * 0.9));
        body = JSON.stringify({ style: bibliography.style, entries });
      }
      if (entries.length === 0) return;
      void fetch(bibliographyEndpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body,
      }).catch(() => undefined);
    },
  });

  usePaperRefBridge({
    pdfDocument,
    enabled: !editable || editMode === "select",
    bibliography: () => bibliographyRef.current,
    onNavigate: (target) => {
      closePreview();
      pdfViewerRef.current?.scrollPageIntoView({
        pageNumber: target.pageNumber,
        ...(target.kind === "XYZ"
          ? {
              // Keep the reader's scale, matching ignoreDestinationZoom.
              destArray: [null, { name: "XYZ" }, target.left, target.top, null],
            }
          : {}),
      });
    },
    onPreview: (target, entryText, ref) => {
      // Chat events have no pointer position; use the chat-adjacent corner.
      const stage = stageRef.current?.getBoundingClientRect();
      showReferencePreview(
        target,
        entryText,
        stage ? { clientX: stage.right, clientY: stage.bottom } : null,
        ref ?? undefined,
      );
    },
  });

  useEffect(() => {
    if (!preview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePreview();
    };
    // Outside clicks dismiss; another citation then opens its own preview.
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
        {selection && (
          <button
            data-selection-ask
            className={styles.selectionAsk}
            style={
              {
                "--ask-top": `${selection.top}px`,
                "--ask-left": `${selection.left}px`,
              } as CSSProperties
            }
            type="button"
            // Cancelling pointerdown keeps the text selection alive until
            // click fires; a plain press would collapse it and unmount us.
            onPointerDown={(event) => event.preventDefault()}
            onClick={askAboutSelection}
          >
            Ask about selection
          </button>
        )}
        {preview && pdfDocument && (
          <ReferencePreview
            document={pdfDocument}
            preview={preview}
            libraryLookup={libraryLookup}
            chatPrompts={chatPrompts}
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
