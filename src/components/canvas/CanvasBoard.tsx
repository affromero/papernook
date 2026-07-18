"use client";

import { useCallback, useRef, useState } from "react";
import {
  Tldraw,
  getSnapshot,
  loadSnapshot,
  AssetRecordType,
  createShapeId,
  type Editor,
  type TLImageShape,
} from "tldraw";
import "tldraw/tldraw.css";
import styles from "./CanvasBoard.module.css";

/**
 * The paper as an infinite canvas: pdf.js renders each page to an image
 * placed as a tldraw shape; around them go notes, links, YouTube embeds,
 * drawings (Apple Pencil works natively), and anything else tldraw offers.
 * State persists as canvas.json in the companion folder. "Explain selection"
 * exports the selected region as a PNG and hands it to the chat panel via a
 * window event.
 */

interface CanvasBoardProps {
  topic: string;
  slug: string;
}

const PAGE_GAP = 48;
const RENDER_SCALE = 1.6;

async function renderPdfPages(
  url: string,
): Promise<{ dataUrl: string; width: number; height: number }[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const doc = await pdfjs.getDocument({ url }).promise;
  const pages: { dataUrl: string; width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    pages.push({
      dataUrl: canvas.toDataURL("image/png"),
      width: viewport.width / RENDER_SCALE,
      height: viewport.height / RENDER_SCALE,
    });
  }
  return pages;
}

function placePages(
  editor: Editor,
  pages: { dataUrl: string; width: number; height: number }[],
): void {
  let y = 0;
  for (const [index, page] of pages.entries()) {
    const assetId = AssetRecordType.createId();
    editor.createAssets([
      {
        id: assetId,
        typeName: "asset",
        type: "image",
        meta: {},
        props: {
          name: `page-${index + 1}.png`,
          src: page.dataUrl,
          w: page.width,
          h: page.height,
          mimeType: "image/png",
          isAnimated: false,
        },
      },
    ]);
    editor.createShape<TLImageShape>({
      id: createShapeId(`page-${index + 1}`),
      type: "image",
      x: 0,
      y,
      isLocked: true,
      props: { assetId, w: page.width, h: page.height },
    });
    y += page.height + PAGE_GAP;
  }
  editor.zoomToFit();
}

export function CanvasBoard({ topic, slug }: CanvasBoardProps) {
  const base = `/api/v1/papers/${topic}/${slug}`;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const onMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      void (async () => {
        const res = await fetch(`${base}/canvas`, { credentials: "include" });
        const data = (await res.json()) as {
          empty?: boolean;
          document?: unknown;
        };
        if (data && !data.empty && data.document) {
          loadSnapshot(editor.store, data as never);
        } else {
          const pages = await renderPdfPages(`${base}/pdf`);
          placePages(editor, pages);
        }
        // Debounced autosave on any change after initial load.
        editor.store.listen(
          () => {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              const snapshot = getSnapshot(editor.store);
              void fetch(`${base}/canvas`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(snapshot),
              });
            }, 1_500);
          },
          { scope: "document", source: "user" },
        );
      })();
    },
    [base],
  );

  async function explainSelection(): Promise<void> {
    const editor = editorRef.current;
    if (!editor) return;
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) {
      setStatus("Select a region or shapes on the canvas first.");
      return;
    }
    const { blob } = await editor.toImage(ids, {
      format: "png",
      background: true,
      padding: 8,
    });
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
    window.dispatchEvent(
      new CustomEvent("papernook:attach", { detail: dataUrl }),
    );
    setStatus("Selection attached to the chat input — ask away.");
  }

  async function expand(mode: "margin" | "page"): Promise<void> {
    const res = await fetch(`${base}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode }),
    });
    const data = (await res.json()) as { error?: string; pages?: number };
    setStatus(
      data.error ??
        `PDF expanded (${data.pages} pages). It syncs to the iPad over WebDAV.`,
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <button type="button" onClick={() => void explainSelection()}>
          Explain selection ↦ chat
        </button>
        <button type="button" onClick={() => void expand("margin")}>
          + margin space (PDF)
        </button>
        <button type="button" onClick={() => void expand("page")}>
          + blank page (PDF)
        </button>
        {status && (
          <span className={styles.status} role="status">
            {status}
          </span>
        )}
      </div>
      <div className={styles.board}>
        <Tldraw onMount={onMount} />
      </div>
    </div>
  );
}
