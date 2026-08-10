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
import { matchCitation, type Bibliography } from "@/lib/pdf/bibliography";
import {
  resolvePdfDestination,
  type ResolvedPdfDestination,
} from "@/lib/pdf/destinations";
import { destinationCandidates, type PaperRef } from "@/lib/pdf/paper-refs";

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
