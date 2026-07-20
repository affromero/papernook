"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Tldraw,
  getSnapshot,
  loadSnapshot,
  type Editor,
  type TLAssetStore,
  type TLShape,
} from "tldraw";
import { reconcileStartupMigration } from "@/lib/canvas/startup";
import "tldraw/tldraw.css";
import styles from "./CanvasBoard.module.css";

interface CanvasBoardProps {
  topic: string;
  slug: string;
}

const SAVE_DELAY_MS = 1_200;
const LOCAL_SESSION_PREFIX = "papernook:canvas-session";
const CANVAS_VERSION_HEADER = "X-Canvas-Version";

function canvasError(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

function localSessionKey(topic: string, slug: string): string {
  return `${LOCAL_SESSION_PREFIX}:${topic}:${slug}`;
}

function restoreLocalCamera(
  editor: Editor,
  topic: string,
  slug: string,
): boolean {
  try {
    const raw = window.localStorage.getItem(localSessionKey(topic, slug));
    if (!raw) return false;
    const camera: unknown = JSON.parse(raw);
    if (
      !camera ||
      typeof camera !== "object" ||
      !("x" in camera) ||
      typeof camera.x !== "number" ||
      !("y" in camera) ||
      typeof camera.y !== "number" ||
      !("z" in camera) ||
      typeof camera.z !== "number"
    ) {
      return false;
    }
    editor.setCamera({ x: camera.x, y: camera.y, z: camera.z });
    return true;
  } catch {
    return false;
  }
}

function saveLocalCamera(editor: Editor, topic: string, slug: string): void {
  try {
    const camera = editor.getCamera();
    window.localStorage.setItem(
      localSessionKey(topic, slug),
      JSON.stringify({ x: camera.x, y: camera.y, z: camera.z }),
    );
  } catch {
    // Canvas content still saves when local camera persistence is unavailable.
  }
}

async function migrateLegacyCanvas(editor: Editor): Promise<boolean> {
  let changed = false;
  const paperShapes = editor.store
    .allRecords()
    .filter(
      (record): record is TLShape =>
        record.typeName === "shape" && /^shape:page-\d+$/.test(record.id),
    );
  if (paperShapes.length > 0) {
    const pageAssetIds = paperShapes.flatMap((shape) =>
      shape.type === "image" && shape.props.assetId
        ? [shape.props.assetId]
        : [],
    );
    editor.store.remove(paperShapes.map((shape) => shape.id));
    const referencedAssetIds = new Set(
      editor.store
        .allRecords()
        .flatMap((record) =>
          record.typeName === "shape" &&
          "assetId" in record.props &&
          record.props.assetId
            ? [record.props.assetId]
            : [],
        ),
    );
    const unusedPageAssetIds = pageAssetIds.filter(
      (assetId) => !referencedAssetIds.has(assetId),
    );
    if (unusedPageAssetIds.length > 0) {
      editor.deleteAssets(unusedPageAssetIds);
    }
    changed = true;
  }

  for (const asset of editor.getAssets()) {
    const source = asset.props.src;
    if (!source?.startsWith("data:")) continue;
    const blob = await fetch(source).then((response) => response.blob());
    const filename =
      "name" in asset.props && asset.props.name
        ? asset.props.name
        : `canvas-asset.${blob.type.split("/")[1] ?? "bin"}`;
    const uploaded = await editor.uploadAsset(
      asset,
      new File([blob], filename, { type: blob.type }),
    );
    editor.updateAssets([
      { id: asset.id, type: asset.type, props: { src: uploaded.src } },
    ]);
    changed = true;
  }
  return changed;
}

async function saveDocument(
  document: unknown,
  url: string,
  etag: string,
): Promise<string> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      [CANVAS_VERSION_HEADER]: etag,
    },
    credentials: "include",
    body: JSON.stringify({ document }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 409) throw new CanvasConflictError();
    throw new Error(canvasError(payload, "The canvas could not be saved."));
  }
  return response.headers.get(CANVAS_VERSION_HEADER) ?? etag;
}

class CanvasConflictError extends Error {
  constructor() {
    super("Canvas changed on another device.");
    this.name = "CanvasConflictError";
  }
}

async function loadSharedCanvas(editor: Editor, url: string): Promise<string> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(canvasError(payload, "The canvas could not be loaded."));
  }
  if (
    payload &&
    typeof payload === "object" &&
    "document" in payload &&
    payload.document
  ) {
    loadSnapshot(editor.store, { document: payload.document } as never);
  }
  return response.headers.get(CANVAS_VERSION_HEADER) ?? '"empty"';
}

export function CanvasBoard({ topic, slug }: CanvasBoardProps) {
  const base = `/api/v1/papers/${topic}/${slug}`;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const editorRef = useRef<Editor | null>(null);
  const etagRef = useRef('"empty"');
  const initializedRef = useRef(false);
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const changeVersionRef = useRef(0);
  const [status, setStatus] = useState("Opening shared canvas…");
  const [saved, setSaved] = useState(true);
  const [ready, setReady] = useState(false);
  const [conflicted, setConflicted] = useState(false);

  const assetStore = useMemo<TLAssetStore>(
    () => ({
      async upload(_asset, file, abortSignal) {
        const response = await fetch(`${base}/canvas/assets`, {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Canvas-Filename": encodeURIComponent(file.name),
          },
          credentials: "include",
          body: file,
          signal: abortSignal,
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            canvasError(payload, "The canvas asset could not be uploaded."),
          );
        }
        if (
          !payload ||
          typeof payload !== "object" ||
          !("src" in payload) ||
          typeof payload.src !== "string"
        ) {
          throw new Error("The canvas asset response was invalid.");
        }
        return { src: payload.src };
      },
      resolve(asset) {
        return asset.props.src;
      },
    }),
    [base],
  );
  const flushSave = useCallback(
    async (editor: Editor, silent = false) => {
      if (conflictRef.current) return;
      const document = getSnapshot(editor.store).document;
      const savedVersion = changeVersionRef.current;
      const save = async () => {
        if (!silent) setStatus("Saving…");
        try {
          etagRef.current = await saveDocument(
            document,
            `${base}/canvas`,
            etagRef.current,
          );
        } catch (error) {
          if (error instanceof CanvasConflictError) {
            conflictRef.current = true;
            setConflicted(true);
            setSaved(false);
            setStatus(
              "Changed on another device. Reload to review the shared version.",
            );
          }
          throw error;
        }
        const fullySaved = changeVersionRef.current === savedVersion;
        dirtyRef.current = !fullySaved;
        if (!silent) {
          setSaved(fullySaved);
          setStatus(fullySaved ? "Saved" : "Unsaved changes");
        }
      };
      saveQueue.current = saveQueue.current.then(save, save);
      await saveQueue.current;
    },
    [base],
  );

  useEffect(() => {
    const warnAboutUnsavedChanges = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnAboutUnsavedChanges);
    return () =>
      window.removeEventListener("beforeunload", warnAboutUnsavedChanges);
  }, []);

  const onMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      let removeDocumentListener: (() => void) | undefined;
      let removeSessionListener: (() => void) | undefined;
      let removeThemeListener: (() => void) | undefined;
      let cancelled = false;

      void (async () => {
        const canvasUrl = `${base}/canvas`;
        etagRef.current = await loadSharedCanvas(editor, canvasUrl);
        if (cancelled) return;
        etagRef.current = await reconcileStartupMigration({
          etag: etagRef.current,
          migrate: () => migrateLegacyCanvas(editor),
          save: (etag) =>
            saveDocument(getSnapshot(editor.store).document, canvasUrl, etag),
          reload: () => loadSharedCanvas(editor, canvasUrl),
          isConflict: (error) => error instanceof CanvasConflictError,
        });
        if (cancelled) return;
        if (!restoreLocalCamera(editor, topic, slug)) {
          editor.zoomToFit({ animation: { duration: 0 } });
        }

        editor.user.updateUserPreferences({
          colorScheme:
            document.documentElement.dataset.theme === "dark"
              ? "dark"
              : "light",
        });
        const onThemeChange = () => {
          editor.user.updateUserPreferences({
            colorScheme:
              document.documentElement.dataset.theme === "dark"
                ? "dark"
                : "light",
          });
        };
        window.addEventListener("papernook:theme-changed", onThemeChange);
        removeThemeListener = () =>
          window.removeEventListener("papernook:theme-changed", onThemeChange);

        initializedRef.current = true;
        setStatus("Saved");

        removeDocumentListener = editor.store.listen(
          () => {
            if (!initializedRef.current) return;
            dirtyRef.current = true;
            changeVersionRef.current += 1;
            setSaved(false);
            setStatus(
              conflictRef.current
                ? "Changed on another device. Reload to review the shared version."
                : "Unsaved changes",
            );
            if (conflictRef.current) return;
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              void flushSave(editor).catch((error: unknown) => {
                setStatus(
                  error instanceof Error
                    ? error.message
                    : "The canvas could not be saved.",
                );
              });
            }, SAVE_DELAY_MS);
          },
          { scope: "document", source: "user" },
        );
        removeSessionListener = editor.store.listen(
          () => saveLocalCamera(editor, topic, slug),
          { scope: "session" },
        );
        setReady(true);
      })().catch((error: unknown) => {
        if (cancelled) return;
        setStatus(
          error instanceof Error
            ? error.message
            : "The canvas could not be loaded.",
        );
      });

      return () => {
        cancelled = true;
        initializedRef.current = false;
        if (saveTimer.current) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        removeDocumentListener?.();
        removeSessionListener?.();
        removeThemeListener?.();
        if (dirtyRef.current) void flushSave(editor, true);
      };
    },
    [base, flushSave, slug, topic],
  );

  async function explainSelection(): Promise<void> {
    const editor = editorRef.current;
    if (!editor) return;
    const ids = editor.getSelectedShapeIds();
    if (ids.length === 0) {
      setStatus("Select something on the canvas first.");
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
    setStatus("Selection attached to chat");
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div>
          <strong>Canvas</strong>
          <span className={styles.hint}>
            The PDF stays synced in Reader. Paste screenshots, links, or videos
            here.
          </span>
        </div>
        <div className={styles.toolbarActions}>
          <button type="button" onClick={() => void explainSelection()}>
            Explain selection
          </button>
          {conflicted && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Reload the shared canvas and discard this device's unsaved changes?",
                  )
                ) {
                  window.location.reload();
                }
              }}
            >
              Reload shared canvas
            </button>
          )}
          <span
            className={`${styles.status} ${saved ? styles.statusSaved : ""}`}
            role="status"
            aria-label="Canvas save status"
          >
            {status}
          </span>
        </div>
      </div>
      <div
        className={`${styles.board} ${ready ? "" : styles.boardLoading}`}
        aria-busy={!ready}
      >
        <Tldraw assets={assetStore} onMount={onMount} />
        {!ready && <div className={styles.loadingOverlay}>{status}</div>}
      </div>
    </div>
  );
}
