"use client";

/**
 * PDF side of the chat → PDF reference bridge: listens for the
 * `papernook:paper-ref` window events ChatPanel dispatches, resolves them
 * against the open document, and hands the result back to PdfReader —
 * preview (hover/citations) or navigation (ref clicks).
 *
 * In-paper refs resolve by trying hyperref destination-name candidates in
 * order via resolvePdfDestination (getDestination per name; pdf.js's own
 * docs warn against eagerly fetching the whole destination tree).
 * Citations resolve against the bibliography the hotspot scan published.
 * Event payloads originate from AI-authored chat content and are
 * validated before use.
 */

import { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PAPER_REF_EVENT,
  parsePaperRefEvent,
} from "@/lib/chat/paper-ref-events";
import {
  matchCitation,
  pageLines,
  type Bibliography,
  type TextLine,
} from "@/lib/pdf/bibliography";
import {
  resolvePdfDestination,
  type ResolvedPdfDestination,
} from "@/lib/pdf/destinations";
import {
  captionPattern,
  destinationCandidates,
  type PaperRef,
} from "@/lib/pdf/paper-refs";
import { pdfTextChunks, pdfTextItems } from "@/lib/pdf/text-items";

interface UsePaperRefBridgeOptions {
  pdfDocument: PDFDocumentProxy | null;
  /** False while an annotation tool is active — a chat click must never
   * scroll the page under an in-progress stroke. */
  enabled: boolean;
  bibliography(): Bibliography | null;
  onNavigate(target: ResolvedPdfDestination): void;
  onPreview(target: ResolvedPdfDestination, entryText: string | null): void;
}

async function resolveRef(
  pdfDocument: PDFDocumentProxy,
  ref: Pick<PaperRef, "kind" | "label">,
): Promise<ResolvedPdfDestination | null> {
  for (const candidate of destinationCandidates(ref)) {
    const target = await resolvePdfDestination(pdfDocument, candidate);
    if (target) return target;
  }
  return null;
}

/** Promise-per-page so concurrent lookups never extract a page twice. */
type LineCache = Map<number, Promise<TextLine[]>>;

function pageTextLines(
  pdfDocument: PDFDocumentProxy,
  pageNumber: number,
  cache: LineCache,
): Promise<TextLine[]> {
  let lines = cache.get(pageNumber);
  if (!lines) {
    lines = (async () => {
      const page = await pdfDocument.getPage(pageNumber);
      const items = await pdfTextItems(page);
      const viewport = page.getViewport({ scale: 1 });
      return pageLines({
        pageNumber,
        pageWidth: viewport.width,
        chunks: pdfTextChunks(items),
      });
    })();
    cache.set(pageNumber, lines);
  }
  return lines;
}

/**
 * Fallback for PDFs without named destinations: find the ref's caption
 * (or heading) line in page text. First line-start match wins — captions
 * are the only place "Figure 3:" starts a line.
 */
async function findCaption(
  pdfDocument: PDFDocumentProxy,
  ref: Pick<PaperRef, "kind" | "label">,
  cache: LineCache,
  cancelled: () => boolean,
): Promise<ResolvedPdfDestination | null> {
  const pattern = captionPattern(ref);
  if (!pattern) return null;
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    if (cancelled()) return null;
    const lines = await pageTextLines(pdfDocument, pageNumber, cache);
    const hit = lines.find((line) => pattern.test(line.text));
    if (hit) {
      return {
        pageNumber,
        kind: "XYZ",
        left: hit.x,
        // Slightly above the line's baseline, like hyperref destinations.
        top: hit.y + 8,
        zoom: null,
      };
    }
  }
  return null;
}

export function usePaperRefBridge({
  pdfDocument,
  enabled,
  bibliography,
  onNavigate,
  onPreview,
}: UsePaperRefBridgeOptions): void {
  const optionsRef = useRef({ enabled, bibliography, onNavigate, onPreview });
  useEffect(() => {
    optionsRef.current = { enabled, bibliography, onNavigate, onPreview };
  });

  useEffect(() => {
    if (!pdfDocument) return;
    let disposed = false;
    // Effect-scoped: a document change re-runs the effect, dropping the
    // stale cache with it.
    const lineCache: LineCache = new Map();

    const onPaperRef = (event: Event) => {
      if (!optionsRef.current.enabled) return;
      const detail = parsePaperRefEvent((event as CustomEvent<unknown>).detail);
      if (!detail) return;

      if ("citation" in detail) {
        const scanned = optionsRef.current.bibliography();
        const entry = scanned && matchCitation(scanned, detail.citation);
        if (!entry) return;
        optionsRef.current.onPreview(
          {
            pageNumber: entry.pageNumber,
            kind: "XYZ",
            left: entry.x,
            // Slightly above the entry's first baseline, matching where
            // hyperref destinations point (see useCitationHotspots).
            top: entry.y + 8,
            zoom: null,
          },
          entry.text,
        );
        return;
      }

      void resolveRef(pdfDocument, detail.ref)
        .then(
          (target) =>
            target ??
            findCaption(pdfDocument, detail.ref, lineCache, () => disposed),
        )
        .then((target) => {
          if (disposed || !target) return;
          if (detail.action === "goto") {
            optionsRef.current.onNavigate(target);
          } else {
            optionsRef.current.onPreview(target, null);
          }
        })
        .catch((error: unknown) => {
          console.error("papernook: paper-ref resolution failed", error);
        });
    };

    window.addEventListener(PAPER_REF_EVENT, onPaperRef);
    return () => {
      disposed = true;
      window.removeEventListener(PAPER_REF_EVENT, onPaperRef);
    };
  }, [pdfDocument]);
}
