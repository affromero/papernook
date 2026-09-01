"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type { BibEntry } from "@/lib/pdf/bibliography";
import { requestChatPrompt } from "@/lib/chat/paper-ref-events";
import { AddToLibraryButton } from "@/components/library/AddToLibraryButton";
import styles from "./CitationPopover.module.css";

/**
 * Anchored popover answering a chat citation on surfaces without a mounted
 * PdfReader (the canvas page): where the reader would frame the cited entry
 * on its bibliography page, this shows the entry's text from the cached
 * bibliography, with the same Ask and Add-to-library affordances as the
 * reader's ReferencePreview. Dismissed by Escape, outside pointer, or ×.
 */

interface CitationPopoverProps {
  entry: BibEntry;
  /** Viewport rect of the activated citation button. */
  anchor: { top: number; bottom: number; left: number; right: number };
  /** A chat composer is live; offer "Ask" (mirrors ReferencePreview). */
  chatPrompts: boolean;
  onClose(): void;
}

/** The chat prompt quotes at most this much of the cited entry. */
const ASK_ENTRY_CHARS = 160;
const POPOVER_WIDTH = 360;
const MARGIN = 12;
/** Estimated max popover height used only to pick above/below placement. */
const FLIP_HEIGHT = 260;
/** The resolve API requires at least this many characters. */
const MIN_RESOLVE_CHARS = 12;

export function CitationPopover({
  entry,
  anchor,
  chatPrompts,
  onClose,
}: CitationPopoverProps) {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    rootRef.current?.focus();
  }, [entry]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Outside pointers dismiss; another citation then opens its own popover.
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-citation-popover]")
      )
        return;
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [onClose]);

  function askAboutCitation(): void {
    const work = `“${
      entry.text.length > ASK_ENTRY_CHARS
        ? `${entry.text.slice(0, ASK_ENTRY_CHARS).trimEnd()}…`
        : entry.text
    }”`;
    requestChatPrompt(
      `About the cited work ${work}: what does this paper take from it and how does it differ?`,
    );
    onClose();
  }

  const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * MARGIN);
  const left = Math.max(
    MARGIN,
    Math.min(anchor.left, window.innerWidth - width - MARGIN),
  );
  const below = anchor.bottom + FLIP_HEIGHT <= window.innerHeight;
  const style = {
    "--citation-popover-left": `${left}px`,
    "--citation-popover-width": `${width}px`,
    "--citation-popover-top": below ? `${anchor.bottom + 8}px` : undefined,
    "--citation-popover-bottom": below
      ? undefined
      : `${window.innerHeight - anchor.top + 8}px`,
  } as CSSProperties;

  return (
    <aside
      ref={rootRef}
      className={`${styles.popover} ${below ? styles.below : styles.above}`}
      style={style}
      data-citation-popover=""
      role="dialog"
      aria-label={`Reference: ${entry.text.slice(0, 80)}`}
      tabIndex={-1}
    >
      <div className={styles.header}>
        <span className={styles.eyebrow}>
          Reference · page {entry.pageNumber}
        </span>
        <button
          className={styles.close}
          type="button"
          onClick={onClose}
          aria-label="Close reference popover"
        >
          ×
        </button>
      </div>
      <p className={styles.entry}>{entry.text}</p>
      <div className={styles.actions}>
        {chatPrompts && (
          <button
            className={styles.action}
            type="button"
            onClick={askAboutCitation}
            title="Ask the chat about this cited work"
          >
            Ask
          </button>
        )}
        {entry.text.length >= MIN_RESOLVE_CHARS && (
          <AddToLibraryButton resolveQuery={entry.text} />
        )}
      </div>
    </aside>
  );
}
