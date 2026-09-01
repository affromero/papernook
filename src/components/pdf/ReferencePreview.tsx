"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { PDFDocumentProxy, PageViewport, RenderTask } from "pdfjs-dist";
import type { ResolvedPdfDestination } from "@/lib/pdf/destinations";
import type { PdfTextChunk } from "@/lib/pdf/bibliography";
import type { PaperRefKind } from "@/lib/pdf/paper-refs";
import {
  locatorLinesAtPoint,
  referenceEntryAtPoint,
  referenceTextAtPoint,
  type ReferenceEntry,
} from "@/lib/pdf/reference-text";
import { pdfTextChunks, pdfTextItems } from "@/lib/pdf/text-items";
import { requestChatPrompt } from "@/lib/chat/paper-ref-events";
import {
  captureInboxHref,
  startCapture,
  useCapture,
} from "@/components/library/useCapture";
import styles from "./PdfReader.module.css";

export interface Preview {
  destination: ResolvedPdfDestination;
  /** Known entry text (text-recognized citations); link-annotation
   * citations derive it from the destination point instead. */
  entryText?: string;
  /** Set for in-paper locators ("Section 2", "Figure 3"): the preview frames
   * the heading or caption instead of a bibliography entry, and the
   * library/web-search affordances (bibliography-only) stay hidden. */
  ref?: { kind: PaperRefKind; label: string };
  horizontal: "left" | "right";
  /** Offset from the viewer's top edge, in px. */
  top: number;
}

interface ReferencePreviewProps {
  document: PDFDocumentProxy;
  preview: Preview;
  /**
   * Look the cited entry up in the library (session-authed API) — only
   * passed by signed-in surfaces, never the public share page.
   */
  libraryLookup?: boolean;
  /**
   * Offer "Ask": only where a ChatPanel with a live composer is mounted
   * (the paper page with an AI provider), so the prompt never goes nowhere.
   */
  chatPrompts?: boolean;
  onClose(): void;
}

interface LibraryMatch {
  topic: string;
  slug: string;
  title: string;
}

/** Preview canvas CSS box; the crop is rendered to exactly this aspect. */
const PREVIEW_WIDTH = 760;
const PREVIEW_HEIGHT = 285;
/** Fraction of the page width trimmed per side (past the text margins). */
const PREVIEW_MARGIN_TRIM = 0.055;
/** Locator kinds whose target is a wrapped caption rather than a heading. */
const MULTILINE_KINDS = new Set<PaperRefKind>(["figure", "table", "algorithm"]);

/** The chat prompt quotes at most this much of the cited entry. */
const ASK_ENTRY_CHARS = 160;

function locatorTitle(ref: NonNullable<Preview["ref"]>): string {
  return `${ref.kind.charAt(0).toUpperCase()}${ref.kind.slice(1)} ${ref.label}`;
}

/** The text under the destination point: the locator's heading/caption
 * lines for in-paper refs, the bibliography entry for citations. */
function targetAtDestination(
  chunks: PdfTextChunk[],
  destination: ResolvedPdfDestination,
  pageWidth: number,
  ref: Preview["ref"],
): ReferenceEntry | null {
  if (destination.left === null || destination.top === null) return null;
  const point = { x: destination.left + 15, y: destination.top - 6 };
  return ref
    ? locatorLinesAtPoint(chunks, point, pageWidth, {
        multiline: MULTILINE_KINDS.has(ref.kind),
      })
    : referenceEntryAtPoint(chunks, point, pageWidth);
}

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
/**
 * Resolved library matches per reference text: hotspot papers surface many
 * previews per session and the match API is rate-limited (120 per 10 min),
 * so never ask twice for the same entry.
 */
const libraryMatchCache = new WeakMap<
  PDFDocumentProxy,
  Map<string, LibraryMatch | null>
>();

interface CropMapping {
  viewport: PageViewport;
  sourceX: number;
  sourceY: number;
  pageWidth: number;
}

type ResolveState =
  | { status: "idle" }
  | { status: "resolving" }
  | { status: "notFound" }
  | { status: "failed"; error: string }
  | { status: "resolved"; url: string };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Capture progress for a resolved URL; the registry keeps it across
 * remounts. The host is shown throughout: the URL came from the PDF's own
 * bibliography text, so the reader should see where the capture goes. */
function CaptureProgress({ url }: { url: string }) {
  const { state, start } = useCapture(url);
  const host = hostOf(url);
  if (state.status === "added") {
    return (
      <a
        className={styles.previewLibrary}
        href={captureInboxHref(state.finalSlug)}
        title={url}
      >
        Added from {host} ✓ · review in Inbox
      </a>
    );
  }
  if (state.status === "failed") {
    return (
      <span className={styles.previewActionState} role="alert" title={url}>
        <span
          className={`${styles.previewActionText} ${styles.previewActionFailed}`}
          title={state.error}
        >
          Failed · {state.error}
        </span>
        <button type="button" className={styles.previewAction} onClick={start}>
          Retry
        </button>
      </span>
    );
  }
  return (
    <span className={styles.previewActionState} role="status" title={url}>
      Adding from {host}…
    </span>
  );
}

/**
 * "Add to library" for a cited work: resolve the entry to a URL server-side
 * (arXiv id, DOI, printed link, or an arXiv title search), then hand it to
 * the shared capture registry. Mounted with the destination as its key so
 * a new target starts over.
 */
function AddToLibrary({
  resolveEntry,
}: {
  resolveEntry: () => Promise<string | null>;
}) {
  const [state, setState] = useState<ResolveState>({ status: "idle" });

  async function resolveAndCapture(): Promise<void> {
    setState({ status: "resolving" });
    try {
      // Reading the entry can fail too (the PDF proxy is torn down when
      // the document reloads), so it belongs inside the same try.
      const entry = await resolveEntry();
      // The resolve API requires 12-400 chars.
      if (!entry || entry.length < 12) {
        setState({ status: "notFound" });
        return;
      }
      const response = await fetch(
        `/api/v1/citations/resolve?q=${encodeURIComponent(entry.slice(0, 400))}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) {
        setState({
          status: "failed",
          error:
            response.status === 429
              ? "too many lookups, try again later"
              : `lookup failed (${response.status})`,
        });
        return;
      }
      const data = (await response.json()) as { url: string | null };
      if (!data.url) {
        setState({ status: "notFound" });
        return;
      }
      await startCapture(data.url);
      setState({ status: "resolved", url: data.url });
    } catch {
      setState({ status: "failed", error: "lookup failed" });
    }
  }

  if (state.status === "resolved") return <CaptureProgress url={state.url} />;
  if (state.status === "resolving") {
    return (
      <span className={styles.previewActionState} role="status">
        Resolving…
      </span>
    );
  }
  if (state.status === "notFound") {
    return (
      <span className={styles.previewActionState} role="status">
        Not found online
      </span>
    );
  }
  return (
    <span className={styles.previewActionState}>
      {state.status === "failed" && (
        <span
          className={`${styles.previewActionText} ${styles.previewActionFailed}`}
          role="alert"
          title={state.error}
        >
          Failed · {state.error}
        </span>
      )}
      <button
        type="button"
        className={styles.previewAction}
        onClick={() => void resolveAndCapture()}
      >
        {state.status === "failed" ? "Retry" : "+ Add to library"}
      </button>
    </span>
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
  const chunks = pdfTextChunks(await pdfTextItems(page));
  cache.set(pageNumber, chunks);
  return chunks;
}

export function ReferencePreview({
  document,
  preview,
  libraryLookup = false,
  chatPrompts = false,
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
  const { destination, ref } = preview;
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

  // The cited entry's full text: known up front for text-recognized
  // citations; for link annotations, the entry under the GoTo destination
  // (which points at the entry's marker).
  async function resolveEntry(): Promise<string | null> {
    if (preview.entryText) return preview.entryText;
    const mapping = mappingRef.current;
    const { left, top } = destination;
    if (!mapping || left === null || top === null) return null;
    const chunks = await pageTextChunks(document, destination.pageNumber);
    return referenceTextAtPoint(
      chunks,
      { x: left + 15, y: top - 6 },
      mapping.pageWidth,
    );
  }

  function searchTargetReference(): void {
    searchViaPopup(async () => (await resolveEntry())?.slice(0, 300) ?? null);
  }

  // Hand the chat a prompt about the cited work and get out of its way.
  function askAboutReference(): void {
    void resolveEntry()
      .then((entry) => {
        const work = entry
          ? `“${entry.length > ASK_ENTRY_CHARS ? `${entry.slice(0, ASK_ENTRY_CHARS).trimEnd()}…` : entry}”`
          : `cited on page ${destination.pageNumber}`;
        requestChatPrompt(
          `About the cited work ${work}: what does this paper take from it and how does it differ?`,
        );
      })
      .catch(() => undefined)
      .finally(onClose);
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
        // Resolve the cited entry first: it drives both the highlight and
        // where the crop sits, so a long entry is framed whole instead of
        // hanging off the bottom.
        const entry = targetAtDestination(
          await pageTextChunks(document, destination.pageNumber),
          destination,
          base.width,
          ref,
        );
        if (disposed) return;
        const point =
          destination.left !== null && destination.top !== null
            ? viewport.convertToViewportPoint(destination.left, destination.top)
            : [source.width / 2, Math.min(source.height / 2, cropHeight / 2)];
        const entryHeight = entry
          ? entry.boxes.reduce(
              (total, box) => total + box.height * scale * pixelRatio,
              0,
            )
          : 0;
        const sourceX = Math.max(
          0,
          Math.min(
            source.width - cropWidth,
            Math.round(base.width * PREVIEW_MARGIN_TRIM * scale * pixelRatio),
          ),
        );
        const sourceY = Math.max(
          0,
          Math.min(
            source.height - cropHeight,
            // Center the entry when it fits; otherwise start at its top.
            entryHeight > 0 && entryHeight < cropHeight
              ? point[1] - (cropHeight - entryHeight) / 2
              : point[1] - cropHeight / 3,
          ),
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

        // Mark the cited entry inside the crop — a page of bibliography all
        // looks alike, so without it the reader cannot tell which line the
        // hovered citation points at.
        if (entry) {
          context.save();
          context.globalCompositeOperation = "multiply";
          context.fillStyle = "rgba(255, 226, 92, 0.55)";
          for (const box of entry.boxes) {
            const [x, y] = viewport.convertToViewportPoint(
              box.x,
              box.y + box.height,
            );
            context.fillRect(
              x - sourceX,
              y - sourceY,
              box.width * scale * pixelRatio,
              box.height * scale * pixelRatio,
            );
          }
          context.restore();
        }

        // Eagerly resolve the cited entry against the library so the header
        // can offer "In your library" (signed-in surfaces only; a heading or
        // caption is not a citation, so in-paper locators skip this).
        const { left, top } = destination;
        const entryText = preview.entryText;
        if (
          libraryLookup &&
          !ref &&
          (entryText || (left !== null && top !== null))
        ) {
          void (async () => {
            const reference =
              entryText ??
              referenceTextAtPoint(
                await pageTextChunks(document, destination.pageNumber),
                { x: (left ?? 0) + 15, y: (top ?? 0) - 6 },
                base.width,
              );
            // The match API requires 12-400 chars.
            if (!reference || reference.length < 12 || disposed) return;
            const query = reference.slice(0, 400);
            let cache = libraryMatchCache.get(document);
            if (!cache) {
              cache = new Map();
              libraryMatchCache.set(document, cache);
            }
            let match = cache.get(query);
            if (match === undefined) {
              const response = await fetch(
                `/api/v1/citations/match?q=${encodeURIComponent(query)}`,
                { credentials: "same-origin" },
              );
              if (!response.ok || disposed) return;
              const data = (await response.json()) as {
                match: LibraryMatch | null;
              };
              match = data.match;
              cache.set(query, match);
            }
            if (!disposed) {
              setLibraryMatch({
                key: `${destination.pageNumber}:${left}:${top}`,
                match,
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
  }, [destination, document, libraryLookup, preview.entryText, ref]);

  return (
    <aside
      className={`${styles.preview} ${
        preview.horizontal === "left" ? styles.previewLeft : styles.previewRight
      }`}
      style={{ top: preview.top }}
      data-reference-preview=""
      aria-label={`Reference preview, page ${destination.pageNumber}`}
    >
      <div className={styles.previewHeader}>
        <span className={styles.previewEyebrow}>
          {ref ? locatorTitle(ref) : "Reference"} · page{" "}
          {destination.pageNumber}
        </span>
        {chatPrompts && !ref && (
          <button
            className={styles.previewAction}
            type="button"
            onClick={askAboutReference}
            title="Ask the chat about this cited work"
          >
            Ask
          </button>
        )}
        {currentMatch && (
          <a
            className={styles.previewLibrary}
            href={`/paper/${currentMatch.topic}/${currentMatch.slug}`}
            title={currentMatch.title}
          >
            In your library
          </a>
        )}
        {libraryLookup && !ref && !currentMatch && (
          <AddToLibrary key={destinationKey} resolveEntry={resolveEntry} />
        )}
        {!ref && (
          <button
            className={styles.previewOpen}
            type="button"
            onClick={searchTargetReference}
            aria-label="Search this reference on the web"
            title="Search this reference on the web"
          >
            🔍
          </button>
        )}
        <button
          className={styles.close}
          type="button"
          onClick={onClose}
          aria-label="Close reference preview"
        >
          ×
        </button>
      </div>
      <div
        className={
          ref
            ? `${styles.previewPage} ${styles.previewPageStatic}`
            : styles.previewPage
        }
      >
        <canvas
          ref={canvasRef}
          {...(ref
            ? {}
            : {
                onClick: searchClickedReference,
                title: "Click a reference to search it on the web",
              })}
        />
        {status && <p className={styles.previewStatus}>{status}</p>}
      </div>
    </aside>
  );
}
