"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ChatMessage } from "./ChatMessages";
import styles from "./ChatPanel.module.css";

export interface ComposerHistoryRefs {
  dialogRef: RefObject<HTMLDialogElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  resultsRef: RefObject<HTMLDivElement | null>;
}

interface UseComposerHistoryOptions extends ComposerHistoryRefs {
  messages: ChatMessage[];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export interface ComposerHistory {
  /** Sent user messages, newest first. */
  sentHistory: string[];
  filteredHistory: string[];
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  selection: number;
  setSelection: Dispatch<SetStateAction<number>>;
  /**
   * Handles Ctrl+R (open search) and ArrowUp/ArrowDown recall. Returns true
   * when the key was consumed so the composer can `preventDefault`.
   */
  onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  /** Forget the recall cursor; call when the user edits the draft. */
  resetNavigation(): void;
  /** Forget the recall cursor and close the search dialog. */
  reset(): void;
  closeSearch(restoreDraft: boolean): void;
  selectMessage(message: string): void;
}

/**
 * Shell-style recall for the chat composer: ArrowUp/ArrowDown walk through
 * previously sent messages, Ctrl+R opens a filterable search dialog.
 */
export function useComposerHistory({
  messages,
  input,
  setInput,
  inputRef,
  dialogRef,
  searchRef,
  resultsRef,
}: UseComposerHistoryOptions): ComposerHistory {
  const [index, setIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const draftRef = useRef("");
  const pickerDraftRef = useRef("");

  const sentHistory = messages.reduce<string[]>((history, message) => {
    if (message.role === "user") history.unshift(message.content);
    return history;
  }, []);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredHistory = normalizedQuery
    ? sentHistory.filter((message) =>
        message.toLocaleLowerCase().includes(normalizedQuery),
      )
    : sentHistory;

  useEffect(() => {
    if (!dialogRef.current?.open) return;
    resultsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [dialogRef, resultsRef, query, selection]);

  function focusComposerAtEnd(): void {
    window.requestAnimationFrame(() => {
      const textarea = inputRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }

  function resetNavigation(): void {
    setIndex(null);
    draftRef.current = "";
  }

  function closeSearch(restoreDraft: boolean): void {
    if (restoreDraft) setInput(pickerDraftRef.current);
    dialogRef.current?.close();
    setQuery("");
    setSelection(0);
    pickerDraftRef.current = "";
    focusComposerAtEnd();
  }

  function reset(): void {
    resetNavigation();
    if (dialogRef.current?.open) dialogRef.current.close();
    setQuery("");
    setSelection(0);
    pickerDraftRef.current = "";
  }

  function recall(nextIndex: number): void {
    const message = sentHistory[nextIndex];
    if (message === undefined) return;
    setIndex(nextIndex);
    setInput(message);
    focusComposerAtEnd();
  }

  function navigate(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    ) {
      return false;
    }

    if (index === null) {
      if (event.key === "ArrowDown" || sentHistory.length === 0) return false;
      const textarea = event.currentTarget;
      const selectionIsCollapsed =
        textarea.selectionStart === textarea.selectionEnd;
      const isAtHistoryBoundary =
        input.length === 0 ||
        (selectionIsCollapsed && textarea.selectionStart === 0);
      if (!isAtHistoryBoundary) return false;
      draftRef.current = input;
      recall(0);
      return true;
    }

    if (event.key === "ArrowUp") {
      recall(Math.min(index + 1, sentHistory.length - 1));
      return true;
    }

    if (index > 0) {
      recall(index - 1);
    } else {
      setIndex(null);
      setInput(draftRef.current);
      focusComposerAtEnd();
    }
    return true;
  }

  function openSearch(): void {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    pickerDraftRef.current = input;
    setQuery("");
    setSelection(0);
    dialog.showModal();
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }

  function selectMessage(message: string): void {
    resetNavigation();
    setInput(message);
    closeSearch(false);
  }

  function onComposerKeyDown(
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): boolean {
    if (
      event.key.toLocaleLowerCase() === "r" &&
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      openSearch();
      return true;
    }
    return navigate(event);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelection((current) =>
        Math.min(current + 1, Math.max(filteredHistory.length - 1, 0)),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelection((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const message = filteredHistory[selection];
      if (message !== undefined) selectMessage(message);
    }
  }

  return {
    sentHistory,
    filteredHistory,
    query,
    setQuery,
    selection,
    setSelection,
    onComposerKeyDown,
    onSearchKeyDown,
    resetNavigation,
    reset,
    closeSearch,
    selectMessage,
  };
}

export function HistorySearchDialog({
  history,
  dialogRef,
  searchRef,
  resultsRef,
}: ComposerHistoryRefs & { history: ComposerHistory }) {
  const titleId = useId();
  return (
    <dialog
      ref={dialogRef}
      className={styles.historyDialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        history.closeSearch(true);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) history.closeSearch(true);
      }}
    >
      <div className={styles.historyDialogInner}>
        <header className={styles.historyHeader}>
          <div>
            <p className={styles.historyShortcut}>Ctrl R</p>
            <h2 id={titleId}>Search sent messages</h2>
          </div>
          <button
            type="button"
            className={styles.historyClose}
            aria-label="Close message history"
            onClick={() => history.closeSearch(true)}
          >
            ×
          </button>
        </header>
        <input
          ref={searchRef}
          className={styles.historySearch}
          type="search"
          value={history.query}
          onChange={(event) => {
            history.setQuery(event.target.value);
            history.setSelection(0);
          }}
          onKeyDown={history.onSearchKeyDown}
          placeholder="Type to filter this chat…"
          aria-label="Filter sent messages"
          aria-controls={`${titleId}-results`}
          aria-activedescendant={
            history.filteredHistory.length > 0
              ? `${titleId}-result-${history.selection}`
              : undefined
          }
        />
        <div
          ref={resultsRef}
          id={`${titleId}-results`}
          className={styles.historyResults}
          role="listbox"
          aria-label="Sent messages"
        >
          {history.filteredHistory.length > 0 ? (
            history.filteredHistory.map((message, index) => (
              <button
                type="button"
                className={`${styles.historyResult} ${index === history.selection ? styles.historyResultSelected : ""}`}
                id={`${titleId}-result-${index}`}
                key={`${index}-${message}`}
                role="option"
                aria-selected={index === history.selection}
                onMouseEnter={() => history.setSelection(index)}
                onClick={() => history.selectMessage(message)}
              >
                {message}
              </button>
            ))
          ) : (
            <p className={styles.historyEmpty}>
              {history.sentHistory.length === 0
                ? "No sent messages in this chat yet."
                : "No sent messages match that search."}
            </p>
          )}
        </div>
        <p className={styles.historyHint}>
          ↑↓ choose · Enter restore · Esc cancel
        </p>
      </div>
    </dialog>
  );
}
