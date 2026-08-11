"use client";

import { useEffect, useRef, useState } from "react";
import { PdfReader } from "@/components/pdf/PdfReader";
import styles from "./viewer.module.css";

interface ViewerShellProps {
  /** Original external PDF URL (already validated http/https server-side). */
  src: string;
  title: string;
}

type CaptureState =
  | { phase: "idle" }
  | { phase: "capturing"; slug: string }
  | { phase: "added"; finalSlug: string | null }
  | { phase: "failed"; error: string };

const POLL_MS = 2000;

export function ViewerShell({ src, title }: ViewerShellProps) {
  const [capture, setCapture] = useState<CaptureState>({ phase: "idle" });
  // Prefer the PDF's embedded Title over the URL-derived filename — tabs and
  // the header then read as the actual paper name.
  const [displayTitle, setDisplayTitle] = useState(title);
  const unmounted = useRef(false);

  useEffect(() => {
    document.title = `[nook] ${displayTitle}`;
  }, [displayTitle]);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  async function addToLibrary(): Promise<void> {
    setCapture({ phase: "capturing", slug: "" });
    try {
      const response = await fetch("/api/v1/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: src }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const slug = stringField(payload, "slug");
      if (!response.ok || !slug) {
        setCapture({
          phase: "failed",
          error:
            stringField(payload, "error") ??
            "Capture failed: no response from the server. A slow capture may still finish — check the Inbox before retrying.",
        });
        return;
      }
      setCapture({ phase: "capturing", slug });
      await pollUntilSettled(slug);
    } catch {
      setCapture({ phase: "failed", error: "Capture failed." });
    }
  }

  /** Poll the job marker until done/failed; the viewer never navigates away. */
  async function pollUntilSettled(slug: string): Promise<void> {
    for (;;) {
      await sleep(POLL_MS);
      if (unmounted.current) return;
      let response: Response;
      try {
        response = await fetch(
          `/api/v1/capture?slug=${encodeURIComponent(slug)}`,
          { credentials: "include" },
        );
      } catch {
        // Transient network blip: the capture is still running server-side.
        continue;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setCapture({
          phase: "failed",
          error: stringField(payload, "error") ?? "Capture failed.",
        });
        return;
      }
      const state = stringField(payload, "state");
      if (state === "done") {
        setCapture({
          phase: "added",
          finalSlug: stringField(payload, "finalSlug"),
        });
        return;
      }
      if (state === "failed") {
        setCapture({
          phase: "failed",
          error: stringField(payload, "error") ?? "Capture failed.",
        });
        return;
      }
    }
  }

  const busy = capture.phase === "capturing";
  return (
    <>
      <header className={styles.bar}>
        <span className={styles.barTitle} title={displayTitle}>
          {displayTitle}
        </span>
        {capture.phase === "added" ? (
          <a
            className={styles.added}
            href={
              capture.finalSlug
                ? `/inbox/${encodeURIComponent(capture.finalSlug)}`
                : "/?topic=_inbox"
            }
          >
            Added ✓ — review in Inbox
          </a>
        ) : (
          <button
            type="button"
            className={styles.addBtn}
            disabled={busy}
            onClick={() => void addToLibrary()}
          >
            {busy && <span className={styles.spinner} aria-hidden="true" />}
            {busy ? "Capturing…" : "+ Add to papernook"}
          </button>
        )}
      </header>
      {capture.phase === "failed" && (
        <p className={styles.error} role="alert">
          {capture.error}
        </p>
      )}
      <PdfReader
        src={`/api/v1/viewer/pdf?src=${encodeURIComponent(src)}`}
        title={displayTitle}
        originalHref={src}
        onDocumentTitle={setDisplayTitle}
        libraryLookup
      />
    </>
  );
}

function stringField(payload: unknown, key: string): string | null {
  if (payload && typeof payload === "object" && key in payload) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
