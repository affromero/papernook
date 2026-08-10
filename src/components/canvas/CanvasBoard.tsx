"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Tldraw,
  getSnapshot,
  loadSnapshot,
  type Editor,
  type TLAssetStore,
} from "tldraw";
import { reconcileStartupMigration } from "@/lib/canvas/startup";
import { PdfReader, type PdfReaderEditState } from "@/components/pdf/PdfReader";
import { focusFirstPdfPage, syncPdfPages } from "./pdf-pages";
import "tldraw/tldraw.css";
import styles from "./CanvasBoard.module.css";

export interface CanvasBoardProps {
  topic: string;
  slug: string;
  title: string;
  licenseKey: string | null;
  licenseRequired: boolean;
  licenseError: string | null;
  /** Provider capabilities.vision; false hides "Explain selection". */
  visionAvailable: boolean;
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

async function uploadCanvasAsset(
  base: string,
  file: File,
  abortSignal?: AbortSignal,
): Promise<{ src: string }> {
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
}

async function uploadDataAssets(
  editor: Editor,
  base: string,
): Promise<boolean> {
  const pending = editor
    .getAssets()
    .filter((asset) => asset.props.src?.startsWith("data:"))
    .map(async (asset) => {
      const source = asset.props.src;
      if (!source) throw new Error("A canvas image had no data URL.");
      const separator = source.indexOf(",");
      if (separator < 0) {
        throw new Error("A canvas image had an invalid data URL.");
      }
      const metadata = source.slice(5, separator);
      const encoded = source.slice(separator + 1);
      const mimeType = metadata.split(";")[0] || "application/octet-stream";
      const decoded = metadata.includes(";base64")
        ? window.atob(encoded)
        : decodeURIComponent(encoded);
      const bytes = Uint8Array.from(decoded, (character) =>
        character.charCodeAt(0),
      );
      const blob = new Blob([bytes], { type: mimeType });
      const filename =
        "name" in asset.props && asset.props.name
          ? asset.props.name
          : `canvas-asset.${blob.type.split("/")[1] ?? "bin"}`;
      const uploaded = await uploadCanvasAsset(
        base,
        new File([blob], filename, { type: blob.type }),
      );
      return {
        id: asset.id,
        type: asset.type,
        props: { src: uploaded.src },
      };
    });
  if (pending.length === 0) return false;
  editor.updateAssets(await Promise.all(pending));
  return true;
}

async function deleteUnusedCanvasAssets(
  editor: Editor,
  base: string,
  candidates: string[],
): Promise<void> {
  const activeSources = new Set(
    editor
      .getAssets()
      .flatMap((asset) => (asset.props.src ? [asset.props.src] : [])),
  );
  const unused = [
    ...new Set(
      candidates.filter(
        (source) =>
          source.startsWith(`${base}/canvas/assets/`) &&
          !activeSources.has(source),
      ),
    ),
  ];
  await Promise.all(
    unused.map(async (source) => {
      const response = await fetch(source, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("An old PDF canvas image could not be removed.");
      }
    }),
  );
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

export function CanvasBoard({
  topic,
  slug,
  title,
  licenseKey,
  licenseRequired,
  licenseError,
  visionAvailable,
}: CanvasBoardProps) {
  const base = `/api/v1/papers/${topic}/${slug}`;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const editorRef = useRef<Editor | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const etagRef = useRef('"empty"');
  const initializedRef = useRef(false);
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const changeVersionRef = useRef(0);
  const [status, setStatus] = useState("Opening shared canvas…");
  const [saved, setSaved] = useState(true);
  const [ready, setReady] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [canvasUiHidden, setCanvasUiHidden] = useState(false);
  const [annotatingPdf, setAnnotatingPdf] = useState(false);
  const [pdfEditState, setPdfEditState] = useState<PdfReaderEditState>({
    dirty: false,
    saving: false,
  });
  const [licenseRejected, setLicenseRejected] = useState(false);
  const licenseMissing = licenseRequired && !licenseKey;
  const canvasUnavailable = Boolean(
    licenseMissing || licenseError || licenseRejected,
  );

  useEffect(() => {
    const board = boardRef.current;
    if (!board || licenseMissing || licenseError) return;
    const detectGate = () => {
      const rejected = Boolean(
        board.querySelector('[data-testid="tl-license-expired"]'),
      );
      setLicenseRejected(rejected);
      if (rejected) setStatus("Canvas license rejected.");
    };
    detectGate();
    const observer = new MutationObserver(detectGate);
    observer.observe(board, { childList: true, subtree: true });
    const timeout = window.setTimeout(detectGate, 5_500);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [licenseError, licenseKey, licenseMissing]);

  const assetStore = useMemo<TLAssetStore>(
    () => ({
      async upload(_asset, file, abortSignal) {
        return uploadCanvasAsset(base, file, abortSignal);
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

  const refreshPdfPages = useCallback(
    async (force = false) => {
      const editor = editorRef.current;
      if (!editor || conflictRef.current) return;
      if (refreshPromiseRef.current) {
        await refreshPromiseRef.current;
        return;
      }
      const refresh = async () => {
        if (dirtyRef.current) await flushSave(editor, true);
        setStatus("Refreshing PDF in canvas…");
        const result = await syncPdfPages(
          editor,
          `${base}/pdf`,
          async (blob, filename) =>
            (
              await uploadCanvasAsset(
                base,
                new File([blob], filename, { type: blob.type }),
              )
            ).src,
          force,
        );
        if (!result.changed) {
          setStatus("Saved");
          setSaved(true);
          return;
        }
        await uploadDataAssets(editor, base);
        setSaved(false);
        await flushSave(editor);
        await deleteUnusedCanvasAssets(editor, base, result.obsoleteSources);
        if (result.imported) {
          focusFirstPdfPage(editor);
        }
      };
      refreshPromiseRef.current = refresh().finally(() => {
        refreshPromiseRef.current = null;
      });
      await refreshPromiseRef.current;
    },
    [base, flushSave],
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
        let importedPdf = false;
        let obsoletePdfSources: string[] = [];
        etagRef.current = await loadSharedCanvas(editor, canvasUrl);
        if (cancelled) return;
        setStatus("Importing PDF into canvas…");
        etagRef.current = await reconcileStartupMigration({
          etag: etagRef.current,
          migrate: async () => {
            setStatus("Rendering PDF pages…");
            const result = await syncPdfPages(
              editor,
              `${base}/pdf`,
              async (blob, filename) =>
                (
                  await uploadCanvasAsset(
                    base,
                    new File([blob], filename, { type: blob.type }),
                  )
                ).src,
            );
            importedPdf = result.imported;
            obsoletePdfSources = result.obsoleteSources;
            setStatus("Storing PDF pages…");
            const uploadedAssets = await uploadDataAssets(editor, base);
            setStatus("Saving shared canvas…");
            return result.changed || uploadedAssets;
          },
          save: (etag) =>
            saveDocument(getSnapshot(editor.store).document, canvasUrl, etag),
          reload: () => loadSharedCanvas(editor, canvasUrl),
          isConflict: (error) => error instanceof CanvasConflictError,
        });
        if (cancelled) return;
        await deleteUnusedCanvasAssets(editor, base, obsoletePdfSources);
        editor.updateInstanceState({ isFocusMode: false });
        setCanvasUiHidden(false);
        if (importedPdf || !restoreLocalCamera(editor, topic, slug)) {
          focusFirstPdfPage(editor);
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
          () => {
            saveLocalCamera(editor, topic, slug);
            setCanvasUiHidden(editor.getInstanceState().isFocusMode);
          },
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

  useEffect(() => {
    if (!ready || annotatingPdf || canvasUnavailable) return;
    const checkPdf = () => {
      if (document.visibilityState !== "visible") return;
      void refreshPdfPages().catch((error: unknown) => {
        setStatus(
          error instanceof Error
            ? error.message
            : "The PDF could not be refreshed.",
        );
      });
    };
    const interval = window.setInterval(checkPdf, 30_000);
    document.addEventListener("visibilitychange", checkPdf);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkPdf);
    };
  }, [annotatingPdf, canvasUnavailable, ready, refreshPdfPages]);

  const closePdfAnnotator = useCallback(() => {
    setAnnotatingPdf(false);
    setPdfEditState({ dirty: false, saving: false });
    void refreshPdfPages().catch((error: unknown) => {
      setStatus(
        error instanceof Error
          ? error.message
          : "The annotated PDF could not be refreshed.",
      );
    });
  }, [refreshPdfPages]);

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
          {canvasUiHidden && !canvasUnavailable && (
            <button
              type="button"
              onClick={() => {
                editorRef.current?.updateInstanceState({
                  isFocusMode: false,
                });
              }}
            >
              Show canvas tools
            </button>
          )}
          {!canvasUnavailable && (
            <button type="button" onClick={() => setAnnotatingPdf(true)}>
              Annotate PDF
            </button>
          )}
          {!canvasUnavailable && visionAvailable && (
            <button type="button" onClick={() => void explainSelection()}>
              Explain selection
            </button>
          )}
          {conflicted && !canvasUnavailable && (
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
            className={`${styles.status} ${
              saved && !canvasUnavailable ? styles.statusSaved : ""
            }`}
            role="status"
            aria-label="Canvas save status"
          >
            {licenseError
              ? "Configuration error"
              : licenseMissing
                ? "License needed"
                : licenseRejected
                  ? "License rejected"
                  : status}
          </span>
        </div>
      </div>
      <div
        className={`${styles.board} ${
          ready || licenseMissing || licenseError ? "" : styles.boardLoading
        }`}
        aria-busy={!ready && !licenseMissing && !licenseError}
        ref={boardRef}
      >
        {licenseError || licenseMissing ? (
          <LicenseNotice
            title={
              licenseError
                ? "Canvas configuration needs attention"
                : "Canvas needs a tldraw license"
            }
            detail={
              licenseError ??
              "Add a hobby, trial, or commercial key before opening the shared canvas."
            }
          />
        ) : (
          <Tldraw
            assets={assetStore}
            licenseKey={licenseKey ?? undefined}
            onMount={onMount}
          />
        )}
        {!ready && !licenseMissing && !licenseError && (
          <div className={styles.loadingOverlay}>{status}</div>
        )}
        {licenseRejected && (
          <LicenseNotice
            title="This tldraw key was rejected"
            detail="The key may be invalid, expired, or configured for another domain."
          />
        )}
        {annotatingPdf && !canvasUnavailable && (
          <section
            className={styles.pdfAnnotator}
            aria-label={`Annotate ${title}`}
          >
            <div className={styles.pdfAnnotatorHeader}>
              <div>
                <strong>Annotate PDF</strong>
                <span>
                  Highlights, text, and ink save to Reader and every device.
                </span>
              </div>
              <span role="status">
                {pdfEditState.saving
                  ? "Saving…"
                  : pdfEditState.dirty
                    ? "Unsaved changes"
                    : "Synced PDF"}
              </span>
            </div>
            <div className={styles.pdfAnnotatorReader}>
              <PdfReader
                src={`${base}/pdf`}
                title={title}
                editable
                onClose={closePdfAnnotator}
                onEditStateChange={setPdfEditState}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function LicenseNotice({ title, detail }: { title: string; detail: string }) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className={styles.licenseNotice} role="alert">
      <h2 ref={headingRef} tabIndex={-1}>
        {title}
      </h2>
      <p>{detail}</p>
      <div>
        <a href="/settings#canvas">Open Canvas settings</a>
        <a href="https://tldraw.dev/pricing" target="_blank" rel="noreferrer">
          Get a key <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>
  );
}
