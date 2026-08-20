"use client";

/**
 * Text-based citation recognition for papers WITHOUT embedded cite links:
 * builds the bibliography index once per document, then decorates every
 * rendered text layer with invisible hotspots over recognized citations.
 * Papers whose citations already carry link annotations are untouched — a
 * hotspot overlapping a link annotation is dropped, and fully-linked papers
 * keep the existing goToDestination interception as their only path.
 */

import { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  buildBibliography,
  matchCitation,
  type BibEntry,
  type Bibliography,
  type BibliographyPage,
} from "@/lib/pdf/bibliography";
import { findCitations } from "@/lib/pdf/citations";
import type { ResolvedPdfDestination } from "@/lib/pdf/destinations";
import { pdfTextChunks, pdfTextItems } from "@/lib/pdf/text-items";
import {
  assembleSegments,
  boxesIntersect,
  mergeRectsIntoLines,
  positionAt,
  type Box,
  type TextLayerSegment,
} from "@/lib/pdf/text-layer-map";
import styles from "./PdfReader.module.css";

export interface CitationTarget {
  destination: ResolvedPdfDestination;
  entryText: string;
  clientX: number;
  clientY: number;
}

export interface ViewerEventBus {
  on(name: string, listener: (event: unknown) => void): void;
  off(name: string, listener: (event: unknown) => void): void;
}

interface UseCitationHotspotsOptions {
  pdfDocument: PDFDocumentProxy | null;
  eventBus: ViewerEventBus | null;
  /** False while an annotation tool is active — hotspots must never steal
   * highlight/ink strokes. */
  enabled: boolean;
  onCitation(target: CitationTarget): void;
  /** Fired once per document when the bibliography scan lands, so the
   * owner can resolve chat-originated citations against it. */
  onBibliography?(bibliography: Bibliography): void;
}

/** Only the trailing pages can hold a bibliography worth scanning. */
const MAX_SCANNED_PAGES = 100;
const HOVER_DELAY_MS = 180;

/** EventBus payloads are untyped; narrow by hand (no `any`). */
function renderedTextLayer(
  event: unknown,
): { pageNumber: number; layer: HTMLElement } | null {
  if (!event || typeof event !== "object") return null;
  const { pageNumber, source } = event as {
    pageNumber?: unknown;
    source?: unknown;
  };
  if (typeof pageNumber !== "number" || !source || typeof source !== "object") {
    return null;
  }
  const textLayer = (source as { textLayer?: unknown }).textLayer;
  if (!textLayer || typeof textLayer !== "object") return null;
  const layer = (textLayer as { div?: unknown }).div;
  return layer instanceof HTMLElement ? { pageNumber, layer } : null;
}

async function scanBibliography(
  pdfDocument: PDFDocumentProxy,
  cancelled: () => boolean,
): Promise<Bibliography | null> {
  const firstPage = Math.max(1, pdfDocument.numPages - MAX_SCANNED_PAGES + 1);
  const pages: BibliographyPage[] = [];
  for (let pageNumber = firstPage; pageNumber <= pdfDocument.numPages;) {
    const page = await pdfDocument.getPage(pageNumber);
    if (cancelled()) return null;
    const items = await pdfTextItems(page);
    if (cancelled()) return null;
    const viewport = page.getViewport({ scale: 1 });
    pages.push({
      pageNumber,
      pageWidth: viewport.width,
      chunks: pdfTextChunks(items),
    });
    pageNumber += 1;
  }
  return buildBibliography(pages);
}

function relativeBox(rect: DOMRect, origin: DOMRect): Box {
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  };
}

export function useCitationHotspots({
  pdfDocument,
  eventBus,
  enabled,
  onCitation,
  onBibliography,
}: UseCitationHotspotsOptions): void {
  const onCitationRef = useRef(onCitation);
  const onBibliographyRef = useRef(onBibliography);
  const enabledRef = useRef(enabled);
  const overlaysRef = useRef(new Set<HTMLElement>());

  useEffect(() => {
    onCitationRef.current = onCitation;
    onBibliographyRef.current = onBibliography;
  }, [onCitation, onBibliography]);

  useEffect(() => {
    enabledRef.current = enabled;
    for (const overlay of overlaysRef.current) {
      overlay.classList.toggle(styles.citationOverlayDisabled ?? "", !enabled);
    }
  }, [enabled]);

  useEffect(() => {
    if (!pdfDocument || !eventBus) return;

    let disposed = false;
    let bibliography: Bibliography | null = null;
    let hoverTimer: number | null = null;
    const overlays = overlaysRef.current;
    // Text layers rendered before the bibliography scan finishes get
    // decorated as soon as it lands.
    const pendingLayers = new Map<number, HTMLElement>();

    const clearHoverTimer = () => {
      if (hoverTimer !== null) {
        window.clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    };

    const removeOverlays = () => {
      clearHoverTimer();
      for (const overlay of overlays) overlay.remove();
      overlays.clear();
    };

    const openCitation = (entry: BibEntry, at: MouseEvent) => {
      onCitationRef.current({
        destination: {
          pageNumber: entry.pageNumber,
          kind: "XYZ",
          left: entry.x,
          // Slightly above the entry's first baseline so the crop starts on
          // the entry, matching where hyperref destinations point.
          top: entry.y + 8,
          zoom: null,
        },
        entryText: entry.text,
        clientX: at.clientX,
        clientY: at.clientY,
      });
    };

    const decorate = (pageNumber: number, layer: HTMLElement) => {
      if (!bibliography) {
        pendingLayers.set(pageNumber, layer);
        return;
      }
      const pageContainer = layer.parentElement;
      if (!pageContainer) return;
      const stale = pageContainer.querySelector("[data-citation-overlay]");
      if (stale instanceof HTMLElement) {
        overlays.delete(stale);
        stale.remove();
      }

      const segments: TextLayerSegment[] = [];
      const nodes: (Text | null)[] = [];
      const walker = window.document.createTreeWalker(
        layer,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node instanceof Text) {
          segments.push({ text: node.data, isBreak: false });
          nodes.push(node);
        } else if (node instanceof HTMLBRElement) {
          segments.push({ text: "", isBreak: true });
          nodes.push(null);
        }
      }
      const assembled = assembleSegments(segments);
      if (!assembled.text) return;

      const resolved = findCitations(assembled.text).flatMap((citation) => {
        const entry = matchCitation(bibliography!, citation.key);
        return entry ? [{ citation, entry }] : [];
      });
      if (resolved.length === 0) return;

      const pageRect = pageContainer.getBoundingClientRect();
      const linkBoxes = [
        ...pageContainer.querySelectorAll(".annotationLayer a"),
      ].map((link) => relativeBox(link.getBoundingClientRect(), pageRect));

      const overlay = window.document.createElement("div");
      overlay.dataset.citationOverlay = "";
      overlay.className = `${styles.citationOverlay ?? ""} ${
        enabledRef.current ? "" : (styles.citationOverlayDisabled ?? "")
      }`.trim();

      for (const { citation, entry } of resolved) {
        const start = positionAt(assembled, citation.start, "start");
        const end = positionAt(assembled, citation.end, "end");
        const startNode = start ? nodes[start.segment] : null;
        const endNode = end ? nodes[end.segment] : null;
        if (!start || !end || !startNode || !endNode) continue;
        const range = window.document.createRange();
        range.setStart(startNode, start.offset);
        range.setEnd(endNode, end.offset);
        const boxes = mergeRectsIntoLines(
          [...range.getClientRects()].map((rect) =>
            relativeBox(rect, pageRect),
          ),
        );
        if (boxes.length === 0) continue;
        // An overlapping link annotation means the PDF already handles this
        // citation — never double-trigger.
        if (
          boxes.some((box) =>
            linkBoxes.some((link) => boxesIntersect(box, link)),
          )
        ) {
          continue;
        }
        for (const box of boxes) {
          const hotspot = window.document.createElement("button");
          hotspot.type = "button";
          hotspot.tabIndex = -1;
          hotspot.dataset.citation = "";
          hotspot.className = styles.citationHotspot ?? "";
          hotspot.style.left = `${box.left - 1}px`;
          hotspot.style.top = `${box.top - 1}px`;
          hotspot.style.width = `${box.width + 2}px`;
          hotspot.style.height = `${box.height + 2}px`;
          hotspot.setAttribute(
            "aria-label",
            `Show reference: ${entry.text.slice(0, 80)}`,
          );
          hotspot.addEventListener("click", (event) => {
            openCitation(entry, event);
          });
          hotspot.addEventListener("pointerenter", (event) => {
            if (event.pointerType !== "mouse") return;
            clearHoverTimer();
            hoverTimer = window.setTimeout(() => {
              openCitation(entry, event);
            }, HOVER_DELAY_MS);
          });
          hotspot.addEventListener("pointerleave", clearHoverTimer);
          overlay.append(hotspot);
        }
      }
      if (overlay.childElementCount === 0) return;
      pageContainer.append(overlay);
      overlays.add(overlay);
    };

    const onLayerRendered = (event: unknown) => {
      const rendered = renderedTextLayer(event);
      if (rendered) decorate(rendered.pageNumber, rendered.layer);
    };
    // Pinch zoom takes pdf.js's CSS-transform fast path, which resizes
    // pages WITHOUT re-firing textlayerrendered — overlays would sit over
    // the wrong glyphs, so drop them until the real re-render arrives.
    const onScaleChanging = () => {
      removeOverlays();
    };
    eventBus.on("textlayerrendered", onLayerRendered);
    // The annotation layer renders after the text layer; re-decorating then
    // lets the link-overlap filter see the links it must defer to.
    eventBus.on("annotationlayerrendered", onLayerRendered);
    eventBus.on("scalechanging", onScaleChanging);

    // Deferred to idle: the scan pulls text off up to 100 pages, which with
    // a streaming document means competing with page 1 for both the worker
    // and the bytes still in flight. Text layers rendered before it lands
    // already queue in pendingLayers, so only the timing moves.
    const startScan = () => {
      void scanBibliography(pdfDocument, () => disposed)
        .then((scanned) => {
          if (disposed || !scanned) return;
          bibliography = scanned;
          onBibliographyRef.current?.(scanned);
          const layers = [...pendingLayers];
          pendingLayers.clear();
          for (const [pageNumber, layer] of layers) {
            if (layer.isConnected) decorate(pageNumber, layer);
          }
        })
        .catch((error: unknown) => {
          console.error("papernook: bibliography scan failed", error);
        });
    };
    // A plain timeout, not requestIdleCallback: WebKit still does not
    // implement it (TypeScript's DOM lib types it as always present, which
    // is how it shipped and broke every Safari load), and the only thing
    // this needs is to be off the first-render path.
    const scanHandle = window.setTimeout(startScan, 500);

    return () => {
      disposed = true;
      window.clearTimeout(scanHandle);
      eventBus.off("textlayerrendered", onLayerRendered);
      eventBus.off("annotationlayerrendered", onLayerRendered);
      eventBus.off("scalechanging", onScaleChanging);
      removeOverlays();
    };
  }, [eventBus, pdfDocument]);
}
