"use client";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  AnnotationEditorUIManager,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
} from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import {
  resolvePdfDestination,
  type ResolvedPdfDestination,
} from "@/lib/pdf/destinations";
import { normalizeEtag } from "@/lib/pdf/etag";
import {
  createPdfAutosave,
  type PdfAutosaveCoordinator,
} from "@/lib/pdf/autosave";
import type { Bibliography } from "@/lib/pdf/bibliography";
import {
  newerReadingPosition,
  scaleTransfers,
  parseReadingPosition,
  readingPositionFromUnknown,
  serializeReadingPosition,
  type ReadingPosition,
} from "@/lib/pdf/view/reading-position";
import type { ViewerEventBus } from "./useCitationHotspots";

const READING_POSITION_WRITE_DELAY_MS = 500;

export interface PdfReaderEditState {
  dirty: boolean;
  saving: boolean;
}

export type EditMode = "select" | "highlight" | "text" | "draw";

export interface EditorTypes {
  NONE: number;
  HIGHLIGHT: number;
  FREETEXT: number;
  INK: number;
}

interface MutableAnnotationStorage {
  onSetModified: (() => void) | null;
  onResetModified: (() => void) | null;
  resetModified(): void;
  /** Content hash over real annotation edits; "" when nothing would save. */
  readonly serializable: { hash: string };
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

// localStorage throws in private browsing on some engines and when site
// data is blocked; a remembered position is a convenience, never worth a
// broken reader, so both directions swallow storage failures.
function readStoredReadingPosition(key: string): ReadingPosition | null {
  try {
    return parseReadingPosition(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStoredReadingPosition(key: string, position: ReadingPosition) {
  try {
    window.localStorage.setItem(key, serializeReadingPosition(position));
  } catch {
    // Nothing to recover: the next visit simply starts at page 1.
  }
}

function uiManagerFromEvent(event: unknown): AnnotationEditorUIManager | null {
  if (
    event &&
    typeof event === "object" &&
    "uiManager" in event &&
    event.uiManager &&
    typeof event.uiManager === "object"
  ) {
    return event.uiManager as AnnotationEditorUIManager;
  }
  return null;
}

interface UsePdfDocumentOptions {
  src: string;
  editable: boolean;
  /**
   * localStorage key under which the last page and zoom are remembered and
   * restored on the next open. Omitted on surfaces (share links, the
   * viewer) that should always start from the top.
   */
  positionKey?: string;
  /**
   * Session-authed route (`/api/v1/papers/<topic>/<slug>/position`) that
   * mirrors the reading position per profile, so a paper resumes where the
   * same reader left it on another device. Omitted on logged-out surfaces
   * (share links, the viewer).
   */
  positionEndpoint?: string;
  onEditStateChange?(state: PdfReaderEditState): void;
  /**
   * Receives the destination of an internal link clicked while
   * `hoverPreviewRequestedRef` is set, instead of the viewer scrolling to it.
   */
  onHoverPreview(target: ResolvedPdfDestination): void;
}

export interface PdfDocumentHandle {
  containerRef: RefObject<HTMLDivElement | null>;
  viewerRef: RefObject<HTMLDivElement | null>;
  pdfViewerRef: RefObject<PDFViewer | null>;
  etagRef: RefObject<string | null>;
  editorTypesRef: RefObject<EditorTypes | null>;
  autosaveRef: RefObject<PdfAutosaveCoordinator | null>;
  /** pdf.js editor manager, published once the annotation layer is ready. */
  uiManagerRef: RefObject<AnnotationEditorUIManager | null>;
  pendingPenRef: RefObject<boolean>;
  dirtyRef: RefObject<boolean>;
  savingRef: RefObject<boolean>;
  /** Page and scale to re-apply on the next `pagesinit` (document remount). */
  restoreViewRef: RefObject<{ page: number; scale: number } | null>;
  /**
   * Marks the current view as chosen by the reader. The toolbar's page and
   * zoom buttons live outside the scroll container whose input listeners
   * feed `userMovedRef`, so the reader calls this from those handlers;
   * without it, toolbar-only navigation would never persist a position and
   * a late-arriving server position could yank the view away.
   */
  noteUserMove(): void;
  /**
   * Set by the reader while it synthesises a link click for a hover
   * preview; the link service then routes the destination to
   * `onHoverPreview`.
   */
  hoverPreviewRequestedRef: RefObject<boolean>;
  /** Latest bibliography scan; reset whenever the document remounts. */
  bibliographyRef: RefObject<Bibliography | null>;
  pdfDocument: PDFDocumentProxy | null;
  viewerBus: ViewerEventBus | null;
  pageNumber: number;
  pageCount: number;
  status: string;
  zoom: number;
  editMode: EditMode;
  setEditMode: Dispatch<SetStateAction<EditMode>>;
  editorReady: boolean;
  dirty: boolean;
  saving: boolean;
  saveStatus: string;
  setSaveStatus: Dispatch<SetStateAction<string>>;
  remoteUpdate: boolean;
  pencilMode: boolean;
  setPencilMode: Dispatch<SetStateAction<boolean>>;
  /** Bumping this remounts the document (after `restoreViewRef` is set). */
  setDocumentGeneration: Dispatch<SetStateAction<number>>;
}

/**
 * Owns the pdf.js viewer lifecycle for one `src`: dynamic import, viewer and
 * link-service construction, event-bus subscriptions, the streaming
 * document load, and (when editable) annotation dirty tracking plus the
 * autosave coordinator that PUTs the saved PDF back with if-match.
 */
export function usePdfDocument({
  src,
  editable,
  positionKey,
  positionEndpoint,
  onEditStateChange,
  onHoverPreview,
}: UsePdfDocumentOptions): PdfDocumentHandle {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const pdfViewerRef = useRef<PDFViewer | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const etagRef = useRef<string | null>(null);
  const editorTypesRef = useRef<EditorTypes | null>(null);
  const autosaveRef = useRef<PdfAutosaveCoordinator | null>(null);
  const uiManagerRef = useRef<AnnotationEditorUIManager | null>(null);
  const pendingPenRef = useRef(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const restoreViewRef = useRef<{ page: number; scale: number } | null>(null);
  // True once the reader wheels, taps, or keys inside the current document,
  // or presses a toolbar page/zoom button (via `noteUserMove`); a server
  // position that arrives after that must not yank the view away. Only real
  // input sets it — programmatic restores fire the same
  // pagechanging/scalechanging events a person does.
  const userMovedRef = useRef(false);
  const hoverPreviewRequestedRef = useRef(false);
  const bibliographyRef = useRef<Bibliography | null>(null);
  const onEditStateChangeRef = useRef(onEditStateChange);
  const onHoverPreviewRef = useRef(onHoverPreview);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [viewerBus, setViewerBus] = useState<ViewerEventBus | null>(null);
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
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const [pencilMode, setPencilMode] = useState(false);

  useEffect(() => {
    onEditStateChangeRef.current = onEditStateChange;
  }, [onEditStateChange]);

  useEffect(() => {
    onHoverPreviewRef.current = onHoverPreview;
  }, [onHoverPreview]);

  const noteUserMove = () => {
    userMovedRef.current = true;
  };

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    if (!container || !viewerElement) return;

    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let viewerCleanup: (() => void) | null = null;
    let positionWriteTimer: ReturnType<typeof setTimeout> | null = null;
    let remotePosition: ReadingPosition | null = null;
    const abortController = new AbortController();

    userMovedRef.current = false;
    const markUserMoved = () => {
      userMovedRef.current = true;
    };
    container.addEventListener("wheel", markUserMoved, {
      signal: abortController.signal,
      passive: true,
    });
    container.addEventListener("pointerdown", markUserMoved, {
      signal: abortController.signal,
    });
    container.addEventListener("keydown", markUserMoved, {
      signal: abortController.signal,
    });

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
        linkService.goToDestination = async (destination) => {
          if (!hoverPreviewRequestedRef.current)
            return originalGoToDestination(destination);
          const document = documentRef.current;
          if (!document) return;
          const target = await resolvePdfDestination(document, destination);
          if (!target) {
            await originalGoToDestination(destination);
            return;
          }
          onHoverPreviewRef.current(target);
        };
        setViewerBus(eventBus);

        // Page and zoom are written together, so a stored position is
        // always a pair the viewer actually showed. Debounced: the wheel and
        // pinch fire scalechanging dozens of times a second.
        const flushReadingPosition = () => {
          positionWriteTimer = null;
          // Only a position the reader chose by hand may be stamped and
          // persisted. pagesinit restores and applyRemotePosition fire the
          // same pagechanging/scalechanging events real moves do; stamping
          // those with a fresh Date.now() would clobber the server copy on
          // every open and let a restamped local copy beat a genuinely
          // newer remote in newerReadingPosition.
          if (!userMovedRef.current) return;
          if (
            (!positionKey && !positionEndpoint) ||
            pdfViewer.pagesCount === 0
          ) {
            return;
          }
          const position: ReadingPosition = {
            page: pdfViewer.currentPageNumber,
            scale: pdfViewer.currentScale,
            updatedAt: Date.now(),
            viewport: container.clientWidth,
          };
          if (positionKey) writeStoredReadingPosition(positionKey, position);
          if (positionEndpoint) {
            // Deliberately NOT on the effect's abort signal: the final
            // flush fires from teardown or pagehide, exactly when the
            // signal aborts; keepalive lets the PUT outlive the page.
            void fetch(positionEndpoint, {
              method: "PUT",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: serializeReadingPosition(position),
              keepalive: true,
            }).catch(() => {
              // A dropped write only costs cross-device freshness; the
              // next debounced move re-PUTs.
            });
          }
        };
        const scheduleReadingPositionWrite = () => {
          if (!positionKey && !positionEndpoint) return;
          if (positionWriteTimer !== null) clearTimeout(positionWriteTimer);
          positionWriteTimer = setTimeout(
            flushReadingPosition,
            READING_POSITION_WRITE_DELAY_MS,
          );
        };
        let pagesInitDone = false;
        // True once pagesinit re-applied a live mid-session view (a silent
        // version-poll or margin-notes remount). That view is where the
        // reader is actively reading, so it outranks any server copy — but
        // unlike a hand move it must NOT count as userMoved: stamping it
        // with a fresh Date.now() would let an idle tab clobber the server
        // position another device keeps advancing.
        let restoredLiveView = false;
        // Applies a late-arriving server position, but only while nothing
        // has a stronger claim: a pending remount restore (consumed or
        // not), a move the reader already made by hand, or a local copy
        // written more recently. Safe to run more than once (the effect
        // re-runs on documentGeneration bumps, so the fetch may resolve
        // twice): re-applying the same winner just re-sets the same page
        // and zoom.
        const applyRemotePosition = () => {
          if (!remotePosition || !pagesInitDone) return;
          if (restoreViewRef.current || restoredLiveView) return;
          if (userMovedRef.current) return;
          const local = positionKey
            ? readStoredReadingPosition(positionKey)
            : null;
          if (newerReadingPosition(local, remotePosition) !== remotePosition) {
            return;
          }
          if (scaleTransfers(remotePosition, container.clientWidth)) {
            pdfViewer.currentScale = remotePosition.scale;
          } else {
            pdfViewer.currentScaleValue = "page-width";
          }
          pdfViewer.currentPageNumber = Math.min(
            remotePosition.page,
            pdfViewer.pagesCount,
          );
          if (positionKey) {
            writeStoredReadingPosition(positionKey, remotePosition);
          }
        };
        if (positionEndpoint) {
          // Races the document load; whichever side finishes last
          // reconciles (pagesinit below, or applyRemotePosition here).
          void fetch(positionEndpoint, {
            credentials: "same-origin",
            cache: "no-store",
            signal: abortController.signal,
          })
            .then(async (response) => {
              if (!response.ok) return;
              const payload: unknown = await response.json();
              const position =
                payload && typeof payload === "object" && "position" in payload
                  ? readingPositionFromUnknown(payload.position)
                  : null;
              if (!position || disposed) return;
              remotePosition = position;
              applyRemotePosition();
            })
            .catch(() => {
              // Resuming from localStorage alone is fine; the next move
              // re-PUTs and heals the server copy.
            });
        }
        const onPagesInit = () => {
          pagesInitDone = true;
          const restore = restoreViewRef.current;
          restoreViewRef.current = null;
          if (restore) restoredLiveView = true;
          const stored = positionKey
            ? readStoredReadingPosition(positionKey)
            : null;
          const resume = newerReadingPosition(stored, remotePosition);
          if (restore) {
            // Same-session remount: the surface is unchanged, restore
            // the exact view.
            pdfViewer.currentScale = restore.scale;
            pdfViewer.currentPageNumber = Math.min(
              restore.page,
              pdfViewer.pagesCount,
            );
          } else if (resume) {
            // A remembered zoom only makes sense on a comparable surface;
            // the page transfers regardless.
            if (scaleTransfers(resume, container.clientWidth)) {
              pdfViewer.currentScale = resume.scale;
            } else {
              pdfViewer.currentScaleValue = "page-width";
            }
            pdfViewer.currentPageNumber = Math.min(
              resume.page,
              pdfViewer.pagesCount,
            );
            if (positionKey && resume === remotePosition) {
              writeStoredReadingPosition(positionKey, remotePosition);
            }
          } else {
            pdfViewer.currentScaleValue = "page-width";
          }
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
            scheduleReadingPositionWrite();
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
            scheduleReadingPositionWrite();
          }
        };
        const onAnnotationEditorReady = (event: unknown) => {
          uiManagerRef.current = uiManagerFromEvent(event);
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
        // Double-clicking an annotation that came from the saved PDF makes
        // pdf.js dispatch this event instead of switching modes itself; the
        // embedding viewer must apply it or saved highlights stay read-only.
        const onSwitchAnnotationEditorMode = (event: unknown) => {
          if (
            !editable ||
            !event ||
            typeof event !== "object" ||
            !("mode" in event) ||
            typeof event.mode !== "number"
          ) {
            return;
          }
          pdfViewer.annotationEditorMode = event as { mode: number };
          const toolByType: [EditMode, number][] = [
            ["select", pdfjs.AnnotationEditorType.NONE],
            ["highlight", pdfjs.AnnotationEditorType.HIGHLIGHT],
            ["text", pdfjs.AnnotationEditorType.FREETEXT],
            ["draw", pdfjs.AnnotationEditorType.INK],
          ];
          const tool = toolByType.find(([, type]) => type === event.mode)?.[0];
          if (tool) setEditMode(tool);
        };
        eventBus.on("pagesinit", onPagesInit);
        eventBus.on("pagechanging", onPageChanging);
        eventBus.on("scalechanging", onScaleChanging);
        eventBus.on("annotationeditoruimanager", onAnnotationEditorReady);
        eventBus.on("switchannotationeditormode", onSwitchAnnotationEditorMode);
        // A hard reload, tab close, or bfcache eviction skips React's effect
        // cleanup, so a move made inside the debounce window would be lost
        // without this.
        window.addEventListener(
          "pagehide",
          () => {
            if (positionWriteTimer === null) return;
            clearTimeout(positionWriteTimer);
            flushReadingPosition();
          },
          { signal: abortController.signal },
        );

        // The document is left to pdf.js so it can stream: awaiting a full
        // arrayBuffer() here would hold the first page hostage to the last
        // byte of a 20 MB paper. Only an editable PDF needs the save
        // version up front, and one byte is enough to read it off the
        // response headers. GET rather than HEAD, because HEAD applies a
        // recent-write guard that answers 409 mid-save.
        if (editable) {
          const probe = await fetch(src, {
            headers: { range: "bytes=0-0" },
            cache: "no-store",
            credentials: "same-origin",
            signal: abortController.signal,
          });
          if (!probe.ok) {
            throw new Error(`PDF request failed with ${probe.status}.`);
          }
          const etag = normalizeEtag(probe.headers.get("etag"));
          if (!etag) {
            throw new Error("The PDF did not include a save version.");
          }
          etagRef.current = etag;
        }
        // Auto-fetch stays on, so the rest of the file keeps streaming in
        // the background and `saveDocument()` never stalls waiting for
        // chunks. Page 1 arrives early because captured PDFs are linearized.
        // ponytail: two knowingly-unpinned edges. The revision is not pinned
        // across pdf.js's range requests, so a WebDAV overwrite mid-load can
        // mix two revisions into one render — the 30s version poll remounts
        // the document and if-match still guards every save; pin it with
        // `?v=<etag>` + a 412 if that ever bites. And if a paper still paints
        // late, `disableAutoFetch: true` narrows the fetch to the current
        // view at the cost of a slower first save.
        loadingTask = pdfjs.getDocument({
          url: src,
          withCredentials: true,
        });
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
          // Entering an editor mode registers the PDF's existing annotations
          // in the storage, which flips its modified latch without any real
          // edit. Only a moved content hash may dirty the reader — otherwise
          // every Highlight/Draw toggle uploads the whole PDF and churns the
          // save version other sessions poll against.
          let savedAnnotationsHash = storage.serializable.hash;
          const coordinator = createPdfAutosave({
            delayMs: 1_800,
            save: async () => {
              const expectedEtag = etagRef.current;
              if (!expectedEtag) {
                throw new Error("The PDF has no save version.");
              }
              const focused = containerRef.current?.querySelector(":focus");
              if (focused instanceof HTMLElement) focused.blur();
              const annotationsHash = storage.serializable.hash;
              if (annotationsHash === savedAnnotationsHash) {
                // Edits were undone before the save fired; re-arm the latch
                // so the next real edit reports again, and write nothing.
                storage.resetModified();
                return;
              }
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
              // Prefer the etag echoed in the JSON body: proxies that
              // compress the response (Cloudflare) weaken or drop the
              // header, but never touch the body.
              const bodyEtag =
                payload &&
                typeof payload === "object" &&
                "etag" in payload &&
                typeof payload.etag === "string"
                  ? payload.etag
                  : null;
              const nextEtag = normalizeEtag(
                bodyEtag ?? response.headers.get("etag"),
              );
              if (!nextEtag) {
                throw new Error("The save response had no PDF version.");
              }
              etagRef.current = nextEtag;
              savedAnnotationsHash = annotationsHash;
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
            if (storage.serializable.hash === savedAnnotationsHash) {
              // A mode switch registered untouched annotations, not an
              // edit. The latch must be re-armed or a later real edit
              // would never fire this callback again.
              storage.resetModified();
              return;
            }
            coordinator.markDirty();
          };
          storage.onResetModified = null;
        }
        linkService.setDocument(document);
        pdfViewer.setDocument(document);

        viewerCleanup = () => {
          // Leaving within the debounce window (tap a page, hit back) must
          // not lose the last move; write it now instead of never.
          if (positionWriteTimer !== null) {
            clearTimeout(positionWriteTimer);
            flushReadingPosition();
          }
          eventBus.off("pagesinit", onPagesInit);
          eventBus.off("pagechanging", onPageChanging);
          eventBus.off("scalechanging", onScaleChanging);
          eventBus.off("annotationeditoruimanager", onAnnotationEditorReady);
          eventBus.off(
            "switchannotationeditormode",
            onSwitchAnnotationEditorMode,
          );
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
      setViewerBus(null);
      pdfViewerRef.current = null;
      documentRef.current = null;
      bibliographyRef.current = null;
      etagRef.current = null;
      editorTypesRef.current = null;
      uiManagerRef.current = null;
      autosaveRef.current?.stop();
      autosaveRef.current = null;
      dirtyRef.current = false;
      savingRef.current = false;
      onEditStateChangeRef.current?.({ dirty: false, saving: false });
      pendingPenRef.current = false;
      setEditorReady(false);
      void loadingTask?.destroy();
    };
  }, [editable, positionKey, positionEndpoint, src, documentGeneration]);

  return {
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
    noteUserMove,
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
  };
}
