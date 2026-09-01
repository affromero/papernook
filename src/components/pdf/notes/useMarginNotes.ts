"use client";

/**
 * Saves chat answers into the paper as FreeText margin notes. A note is
 * written straight into pdf.js's annotationStorage in the shape
 * FreeTextEditor.serialize() produces, which dirties the autosave and gets
 * the worker to append a real FreeText annotation on the next PUT. Once
 * that save lands the document remounts at the same page and zoom so the
 * note renders (and stays editable) as an annotation loaded from the file,
 * never as a second copy re-serialized from storage.
 */

import {
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { AnnotationEditorUIManager, PDFDocumentProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import {
  MARGIN_NOTE_EVENT,
  parseMarginNoteEvent,
  type MarginNoteDetail,
} from "@/lib/chat/paper-ref-events";
import { NOTE_FONT_SIZE, noteRect } from "@/lib/chat/margin-note";
import type { PdfAutosaveCoordinator } from "@/lib/pdf/autosave";
import { locateRef, type LineCache } from "../usePaperRefBridge";
import type { EditMode } from "../usePdfDocument";

/** pdf.js AnnotationEditorType.FREETEXT; the worker switches on it. */
const FREETEXT_ANNOTATION_TYPE = 3;
/** Far above anything the editor's own id counter reaches in a session. */
const FALLBACK_ID_BASE = 9000;
const SAVE_POLL_MS = 250;
const SAVE_POLL_LIMIT = 40;

interface UseMarginNotesOptions {
  pdfDocument: PDFDocumentProxy | null;
  editable: boolean;
  pdfViewerRef: RefObject<PDFViewer | null>;
  uiManagerRef: RefObject<AnnotationEditorUIManager | null>;
  autosaveRef: RefObject<PdfAutosaveCoordinator | null>;
  restoreViewRef: RefObject<{ page: number; scale: number } | null>;
  /** Another session saved first; the coordinator is paused until the
   * reader reloads, so a note written now could never reach the file. */
  remoteUpdate: boolean;
  setEditMode: Dispatch<SetStateAction<EditMode>>;
  setSaveStatus: Dispatch<SetStateAction<string>>;
  setDocumentGeneration: Dispatch<SetStateAction<number>>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the coordinator has nothing left to write. `flush()` is a
 * no-op while another save is in flight; the note's own `markDirty()`
 * bumped the revision past the in-flight one, so the next poll's flush
 * writes it.
 */
async function settleSave(
  autosave: PdfAutosaveCoordinator,
  cancelled: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < SAVE_POLL_LIMIT; attempt++) {
    await autosave.flush();
    if (cancelled()) return false;
    const state = autosave.state();
    if (state.error) return false;
    if (!state.dirty && !state.saving) return true;
    await sleep(SAVE_POLL_MS);
  }
  return false;
}

export function useMarginNotes({
  pdfDocument,
  editable,
  pdfViewerRef,
  uiManagerRef,
  autosaveRef,
  restoreViewRef,
  remoteUpdate,
  setEditMode,
  setSaveStatus,
  setDocumentGeneration,
}: UseMarginNotesOptions): void {
  useEffect(() => {
    // Listen whenever the reader is editable, even before the document is
    // ready or after a remote update paused saving: the chat's "Save as
    // note" button is live the whole time, so a click must always get an
    // answer rather than dispatch into the void.
    if (!editable) return;
    let disposed = false;
    let fallbackIds = 0;
    const lineCache: LineCache = new Map();

    const saveNote = async (detail: MarginNoteDetail) => {
      if (remoteUpdate) {
        setSaveStatus("Reload the latest version before saving a note.");
        return;
      }
      const viewer = pdfViewerRef.current;
      const autosave = autosaveRef.current;
      if (!pdfDocument || !viewer || !autosave) {
        setSaveStatus(
          "The paper is still loading; save the note again in a moment.",
        );
        return;
      }
      let pageNumber = viewer.currentPageNumber;
      let anchorTop: number | null = null;
      if (detail.ref) {
        const target = await locateRef(
          pdfDocument,
          detail.ref,
          lineCache,
          () => disposed,
        );
        if (disposed) return;
        if (target) {
          pageNumber = target.pageNumber;
          anchorTop = target.top;
        }
      }
      const page = await pdfDocument.getPage(pageNumber);
      if (disposed) return;
      const [x0, y0, x1, y1] = page.view;
      const lineCount = detail.text.split("\n").length;
      const id =
        uiManagerRef.current?.getId() ??
        `pdfjs_internal_editor_${FALLBACK_ID_BASE + fallbackIds++}`;
      pdfDocument.annotationStorage.setValue(id, {
        annotationType: FREETEXT_ANNOTATION_TYPE,
        color: [0, 0, 0],
        fontSize: NOTE_FONT_SIZE,
        value: detail.text,
        pageIndex: pageNumber - 1,
        rect: noteRect([x0, y0, x1, y1], lineCount, anchorTop),
        rotation: 0,
        structTreeParentId: null,
        popupRef: null,
      });
      // pdf.js only reports the first edit of a modified cycle through
      // onSetModified; while a save is in flight that latch is already set,
      // so the coordinator has to hear about the note directly or the save
      // would complete without it and the remount below would drop it.
      autosave.markDirty();
      setSaveStatus(`Saving note to page ${pageNumber}…`);
      const saved = await settleSave(autosave, () => disposed);
      if (disposed) return;
      if (!saved) {
        // A failed save already shows the coordinator's own error and keeps
        // the note queued for its retry; only a stalled one needs a word.
        if (!autosave.state().error) {
          setSaveStatus(
            `Still saving the note for page ${pageNumber}; it appears after the next reload.`,
          );
        }
        return;
      }
      restoreViewRef.current = {
        page: pageNumber,
        scale: viewer.currentScale,
      };
      // The rebuilt viewer starts in select mode; keep the toolbar honest.
      setEditMode("select");
      setSaveStatus(`Note saved on page ${pageNumber}`);
      setDocumentGeneration((generation) => generation + 1);
    };

    const onMarginNote = (event: Event) => {
      const detail = parseMarginNoteEvent(
        (event as CustomEvent<unknown>).detail,
      );
      if (!detail) return;
      saveNote(detail).catch((error: unknown) => {
        console.error("papernook: margin note failed", error);
        if (!disposed) setSaveStatus("The note could not be saved.");
      });
    };

    window.addEventListener(MARGIN_NOTE_EVENT, onMarginNote);
    return () => {
      disposed = true;
      window.removeEventListener(MARGIN_NOTE_EVENT, onMarginNote);
    };
  }, [
    pdfDocument,
    editable,
    pdfViewerRef,
    uiManagerRef,
    autosaveRef,
    restoreViewRef,
    remoteUpdate,
    setEditMode,
    setSaveStatus,
    setDocumentGeneration,
  ]);
}
