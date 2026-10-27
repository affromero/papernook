"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
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
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogOpen = draft !== null;

  useEffect(() => {
    if (!dialogOpen) return;
    textareaRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        commentDirtyRef.current = false;
        onDraftChange(false);
        setDraft(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogOpen, busy, commentDirtyRef, onDraftChange]);

  useEffect(() => {
    let disposed = false;
    async function place(event: MouseEvent) {
      if (!enabled || !pdfDocument || draft) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const pageElement = target.closest<HTMLElement>(
        ".page[data-page-number]",
      );
      const page = Number(pageElement?.dataset.pageNumber);
      if (!pageElement || !page || !viewer.current) return;
      event.preventDefault();
      event.stopPropagation();
      function openDraft(next: Draft) {
        if (disposed) return;
        if (
          editGate.current.notesInFlight ||
          editGate.current.reloadingDocument
        ) {
          onBlocked();
          return;
        }
        commentDirtyRef.current = false;
        onDraftChange(true);
        setDraft(next);
      }
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
        if (!existing) return;
        const text = existing.contentsObj?.str ?? "";
        openDraft({
          page,
          x: 0,
          y: 0,
          id: marker.dataset.annotationId,
          text,
          initialText: text,
        });
        return;
      }
      const rect = pageElement.getBoundingClientRect();
      const viewport = viewer.current.getPageView(page - 1).viewport as {
        convertToPdfPoint(x: number, y: number): [number, number];
      };
      const [x, y] = viewport.convertToPdfPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      openDraft({ page, x, y, text: "", initialText: "" });
    }
    const element = stage.current;
    element?.addEventListener("click", place, true);
    return () => {
      disposed = true;
      element?.removeEventListener("click", place, true);
    };
  }, [
    enabled,
    pdfDocument,
    draft,
    stage,
    viewer,
    editGate,
    commentDirtyRef,
    onDraftChange,
    onBlocked,
  ]);

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
        className={styles.commentTool}
        type="button"
        disabled={busy || dialogOpen || disabled}
        aria-pressed={enabled}
        onClick={() => {
          if (!enabled) onEnable();
          setEnabled(!enabled);
        }}
      >
        Comment
      </button>
      {enabled && <span>Choose a location on the page.</span>}
      {draft && (
        <div
          className={styles.commentDialog}
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
              commentDirtyRef.current = false;
              onDraftChange(false);
              setDraft(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
