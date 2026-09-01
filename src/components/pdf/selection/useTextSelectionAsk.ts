"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import styles from "../PdfReader.module.css";
import { placeSelectionAsk } from "./selectionAsk";

export interface SelectionAsk {
  text: string;
  page: number;
  top: number;
  left: number;
}

/** Quiet period after the last selection change before measuring it. */
const SELECTION_SETTLE_MS = 160;

/**
 * Track a text-layer selection inside the reader stage and where to float
 * an "Ask about selection" button for it. Measured when a pointer drag
 * that started in the stage ends (wherever it ends) and, for selections
 * made without a pointer drag (shift+arrow keys, touch handles), once the
 * selection has stopped changing. Cleared when the selection collapses,
 * the stage scrolls, Escape is pressed, or the hook goes inactive.
 * Citation hotspots win over selection: a pointerup on one leaves
 * whatever was showing untouched.
 */
export function useTextSelectionAsk(
  stageRef: RefObject<HTMLDivElement | null>,
  active: boolean,
): { selection: SelectionAsk | null; clear(): void } {
  const [selection, setSelection] = useState<SelectionAsk | null>(null);
  const clear = useCallback(() => setSelection(null), []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !active) {
      setSelection(null);
      return;
    }
    let dragging = false;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const cancelSettle = () => {
      if (settle !== null) clearTimeout(settle);
      settle = null;
    };
    const measure = () => setSelection(readSelection(stage));
    const onPointerDown = (event: PointerEvent) => {
      dragging = event.target instanceof Node && stage.contains(event.target);
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      const target = event.target;
      if (target instanceof Element) {
        // The floating button itself (PdfReader marks it) never re-measures.
        if (target.closest("[data-selection-ask]")) return;
        if (target.closest(`.${styles.citationHotspot}`)) return;
      }
      cancelSettle();
      measure();
    };
    const onPointerCancel = () => {
      dragging = false;
    };
    const onSelectionChange = () => {
      const live = window.getSelection();
      if (!live || live.isCollapsed) {
        cancelSettle();
        setSelection(null);
        return;
      }
      // Mid-drag the selection grows on every move; wait for the pointer
      // to lift instead of flashing the button under the cursor.
      if (dragging) return;
      cancelSettle();
      settle = setTimeout(() => {
        settle = null;
        measure();
      }, SELECTION_SETTLE_MS);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape alone leaves the DOM selection live; drop it so nothing
      // measures it again.
      window.getSelection()?.removeAllRanges();
      cancelSettle();
      setSelection(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    stage.addEventListener("scroll", clear, true);
    window.document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("keydown", onEscape);
    return () => {
      cancelSettle();
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      stage.removeEventListener("scroll", clear, true);
      window.document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("keydown", onEscape);
      setSelection(null);
    };
  }, [active, clear, stageRef]);

  return { selection, clear };
}

function readSelection(stage: HTMLDivElement): SelectionAsk | null {
  const live = window.getSelection();
  if (!live || live.isCollapsed || live.rangeCount === 0) return null;
  const anchor = live.anchorNode;
  const anchorElement =
    anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  if (!anchorElement || !stage.contains(anchorElement)) return null;
  // pdf.js renders selectable text only inside .textLayer; anything else
  // (toolbar labels, preview copy) is not a passage of the paper.
  if (!anchorElement.closest(".textLayer")) return null;
  const pageElement = anchorElement.closest<HTMLElement>(".page");
  const page = Number(pageElement?.dataset.pageNumber);
  if (!Number.isInteger(page) || page < 1) return null;
  const text = live.toString().trim();
  if (!text) return null;
  const rect = live.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    text,
    page,
    ...placeSelectionAsk(rect, stage.getBoundingClientRect()),
  };
}
