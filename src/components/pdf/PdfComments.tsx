"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PdfAutosaveCoordinator } from "@/lib/pdf/autosave";
import type { PdfEditGate } from "@/lib/pdf/reader/edit-gate";
import styles from "./PdfReader.module.css";

type Draft = {
  page: number;
  x: number;
  y: number;
  id?: string;
  text: string;
  initialText: string;
};

type Position = { x: number; y: number; width: number; height: number };

function isCommentBlocked(editGate: RefObject<PdfEditGate>): boolean {
  return Boolean(
    editGate.current.notesInFlight || editGate.current.reloadingDocument,
  );
}

export function PdfComments({
  src,
  pdfDocument,
  viewer,
  stage,
  etag,
  autosave,
  refresh,
  onEnable,
  onDraftChange,
  editGate,
  commentDirtyRef,
  onBlocked,
  enabled,
  setEnabled,
  disabled,
  appearance,
}: {
  src: string;
  pdfDocument: PDFDocumentProxy | null;
  viewer: RefObject<PDFViewer | null>;
  stage: RefObject<HTMLDivElement | null>;
  etag: RefObject<string | null>;
  autosave: RefObject<PdfAutosaveCoordinator | null>;
  refresh(): void;
  onEnable(): void;
  onDraftChange(active: boolean): void;
  editGate: RefObject<PdfEditGate>;
  commentDirtyRef: RefObject<boolean>;
  onBlocked(): void;
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  disabled: boolean;
  appearance: "theme" | "light" | "dark";
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [placementError, setPlacementError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const commentButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const dialogOpen = draft !== null;
  const positioned = position !== null;
  const draftPage = draft?.page;
  const draftX = draft?.x;
  const draftY = draft?.y;

  function rememberFocus() {
    restoreFocusRef.current =
      document.activeElement === document.body ||
      Boolean(dialogRef.current?.contains(document.activeElement));
  }

  useEffect(() => {
    if (dialogOpen || disabled || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    commentButtonRef.current?.focus();
  }, [dialogOpen, disabled]);

  const openDraft = useCallback(
    (next: Draft) => {
      if (isCommentBlocked(editGate)) {
        onBlocked();
        return;
      }
      commentDirtyRef.current = false;
      setPlacementError("");
      onDraftChange(true);
      setDraft(next);
    },
    [commentDirtyRef, editGate, onBlocked, onDraftChange],
  );

  function placeOnVisiblePage() {
    const currentViewer = viewer.current;
    const stageElement = stage.current;
    if (!currentViewer || !stageElement) return;
    const page = currentViewer.currentPageNumber;
    const pageElement = stageElement.querySelector<HTMLElement>(
      `.page[data-page-number="${page}"]`,
    );
    const pageView = currentViewer.getPageView(page - 1);
    if (!pageElement || !pageView) {
      setPlacementError("Scroll to a page before placing a comment.");
      return;
    }
    const pageRect = pageElement.getBoundingClientRect();
    const stageRect = stageElement.getBoundingClientRect();
    const visual = window.visualViewport;
    const left = Math.max(
      pageRect.left,
      stageRect.left,
      visual?.offsetLeft ?? 0,
    );
    const top = Math.max(pageRect.top, stageRect.top, visual?.offsetTop ?? 0);
    const right = Math.min(
      pageRect.right,
      stageRect.right,
      (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth),
    );
    const bottom = Math.min(
      pageRect.bottom,
      stageRect.bottom,
      (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight),
    );
    if (left >= right || top >= bottom) {
      setPlacementError("Scroll to a page before placing a comment.");
      return;
    }
    const [x, y] = pageView.viewport.convertToPdfPoint(
      (left + right) / 2 - pageRect.left,
      (top + bottom) / 2 - pageRect.top,
    );
    openDraft({ page, x, y, text: "", initialText: "" });
  }

  useLayoutEffect(() => {
    if (draftPage === undefined || draftX === undefined || draftY === undefined)
      return;
    const page = draftPage;
    const x = draftX;
    const y = draftY;
    const stageElement = stage.current;
    const visual = window.visualViewport;
    const pageElement = stageElement?.querySelector<HTMLElement>(
      `.page[data-page-number="${page}"]`,
    );
    if (!stageElement || !pageElement) return;

    function placeDialog() {
      const pageView = viewer.current?.getPageView(page - 1);
      if (!pageView) return;
      const [pageX, pageY] = pageView.viewport.convertToViewportPoint(x, y);
      const rect = pageElement!.getBoundingClientRect();
      const left = visual?.offsetLeft ?? 0;
      const top = visual?.offsetTop ?? 0;
      const visibleWidth = visual?.width ?? window.innerWidth;
      const visibleHeight = visual?.height ?? window.innerHeight;
      const padding = 8;
      const gap = 12;
      const width = Math.max(1, Math.min(336, visibleWidth - padding * 2));
      const height = Math.max(1, Math.min(260, visibleHeight - padding * 2));
      const anchorX = rect.left + pageX;
      const anchorY = rect.top + pageY;
      const preferredX =
        anchorX + gap + width <= left + visibleWidth - padding
          ? anchorX + gap
          : anchorX - width - gap;
      const preferredY =
        anchorY + gap + height <= top + visibleHeight - padding
          ? anchorY + gap
          : anchorY - height - gap;
      setPosition({
        x: Math.max(
          left + padding,
          Math.min(preferredX, left + visibleWidth - width - padding),
        ),
        y: Math.max(
          top + padding,
          Math.min(preferredY, top + visibleHeight - height - padding),
        ),
        width,
        height,
      });
    }

    placeDialog();
    const observer = new ResizeObserver(placeDialog);
    observer.observe(pageElement);
    window.addEventListener("resize", placeDialog);
    window.addEventListener("scroll", placeDialog, true);
    visual?.addEventListener("resize", placeDialog);
    visual?.addEventListener("scroll", placeDialog);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", placeDialog);
      window.removeEventListener("scroll", placeDialog, true);
      visual?.removeEventListener("resize", placeDialog);
      visual?.removeEventListener("scroll", placeDialog);
    };
  }, [draftPage, draftX, draftY, stage, viewer]);

  useEffect(() => {
    if (!dialogOpen) return;
    textareaRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy) return;
      if (commentDirtyRef.current && !window.confirm("Discard this comment?"))
        return;
      rememberFocus();
      commentDirtyRef.current = false;
      onDraftChange(false);
      setDraft(null);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dialogOpen, positioned, busy, commentDirtyRef, onDraftChange]);

  useEffect(() => {
    let disposed = false;
    async function place(event: MouseEvent) {
      if (!enabled || disabled || !pdfDocument || draft) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const pageElement = target.closest<HTMLElement>(
        ".page[data-page-number]",
      );
      const page = Number(pageElement?.dataset.pageNumber);
      if (!pageElement || !page || !viewer.current) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = pageElement.getBoundingClientRect();
      const viewport = viewer.current.getPageView(page - 1).viewport;
      const [x, y] = viewport.convertToPdfPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      const marker = target.closest<HTMLElement>(
        ".textAnnotation[data-annotation-id]",
      );
      if (marker?.dataset.annotationId) {
        const annotations = await (
          await pdfDocument.getPage(page)
        ).getAnnotations();
        const existing = annotations.find(
          (item: { id: string }) => item.id === marker.dataset.annotationId,
        );
        if (!existing || disposed) return;
        const text = existing.contentsObj?.str ?? "";
        openDraft({
          page,
          x,
          y,
          id: marker.dataset.annotationId,
          text,
          initialText: text,
        });
        return;
      }
      openDraft({ page, x, y, text: "", initialText: "" });
    }
    const element = stage.current;
    element?.addEventListener("click", place, true);
    return () => {
      disposed = true;
      element?.removeEventListener("click", place, true);
    };
  }, [enabled, disabled, pdfDocument, draft, stage, viewer, openDraft]);

  async function save(remove = false) {
    if (!draft || busy) return;
    setError("");
    setBusy(true);
    try {
      await autosave.current?.flush();
      const state = autosave.current?.state();
      if (state?.dirty || state?.saving || state?.error)
        throw new Error("Save existing annotations before editing a comment.");
      if (!etag.current)
        throw new Error(
          "The PDF version is unavailable. Reload and try again.",
        );
      const body = draft.id
        ? remove
          ? { action: "delete", id: draft.id }
          : { action: "edit", id: draft.id, text: draft.text }
        : {
            action: "create",
            page: draft.page,
            x: draft.x,
            y: draft.y,
            text: draft.text,
          };
      const response = await fetch(src.replace(/\/pdf$/, "/comments"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag.current,
        },
        body: JSON.stringify(body),
      });
      const result: { error?: string } = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Could not save the comment.");
      rememberFocus();
      commentDirtyRef.current = false;
      setDraft(null);
      setEnabled(false);
      refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the comment.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={commentButtonRef}
        className={`${styles.editorButton} ${enabled ? styles.activeTool : ""}`}
        type="button"
        disabled={busy || dialogOpen || disabled}
        aria-label="Comment"
        title="Comment"
        aria-pressed={enabled}
        onClick={() => {
          setPlacementError("");
          if (!enabled) onEnable();
          setEnabled(!enabled);
        }}
      >
        <MessageSquare aria-hidden="true" />
        <span>Comment</span>
      </button>
      {enabled && !draft && (
        <button
          className={styles.keyboardPlace}
          type="button"
          disabled={disabled}
          onClick={placeOnVisiblePage}
        >
          Place comment on visible page
        </button>
      )}
      {enabled && placementError && <span role="status">{placementError}</span>}
      {draft &&
        position &&
        createPortal(
          <svg className={styles.commentOverlay}>
            <foreignObject
              x={position.x}
              y={position.y}
              width={position.width}
              height={position.height}
            >
              <div
                ref={dialogRef}
                className={styles.commentDialog}
                data-document-appearance={appearance}
                role="dialog"
                aria-label={draft.id ? "Edit comment" : "Add comment"}
              >
                <label>
                  Comment
                  <textarea
                    ref={textareaRef}
                    value={draft.text}
                    onChange={(event) => {
                      const text = event.target.value;
                      commentDirtyRef.current = text !== draft.initialText;
                      setDraft({ ...draft, text });
                    }}
                    maxLength={10000}
                  />
                </label>
                {error && <p role="alert">{error}</p>}
                <button
                  type="button"
                  disabled={busy || !draft.text.trim()}
                  onClick={() => void save()}
                >
                  Save comment
                </button>
                {draft.id && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void save(true)}
                  >
                    Delete comment
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    rememberFocus();
                    commentDirtyRef.current = false;
                    onDraftChange(false);
                    setDraft(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </foreignObject>
          </svg>,
          document.body,
        )}
    </>
  );
}
