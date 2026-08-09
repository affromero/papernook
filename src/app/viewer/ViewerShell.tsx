"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PdfReader } from "@/components/pdf/PdfReader";
import styles from "./viewer.module.css";

interface ViewerShellProps {
  /** Original external PDF URL (already validated http/https server-side). */
  src: string;
  title: string;
}

export function ViewerShell({ src, title }: ViewerShellProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Prefer the PDF's embedded Title over the URL-derived filename — tabs and
  // the header then read as the actual paper name.
  const [displayTitle, setDisplayTitle] = useState(title);

  useEffect(() => {
    document.title = `${displayTitle} · papernook`;
  }, [displayTitle]);

  async function addToLibrary(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: src }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const href =
        payload &&
        typeof payload === "object" &&
        "href" in payload &&
        typeof payload.href === "string"
          ? payload.href
          : null;
      if (response.ok && href) {
        router.push(href);
        return;
      }
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : "Capture failed.";
      setError(message);
      setBusy(false);
    } catch {
      setError("Capture failed.");
      setBusy(false);
    }
  }

  return (
    <>
      <header className={styles.bar}>
        <span className={styles.barTitle} title={displayTitle}>
          {displayTitle}
        </span>
        <button
          type="button"
          className={styles.addBtn}
          disabled={busy}
          onClick={() => void addToLibrary()}
        >
          {busy ? "Capturing…" : "+ Add to papernook"}
        </button>
      </header>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <PdfReader
        src={`/api/v1/viewer/pdf?src=${encodeURIComponent(src)}`}
        title={displayTitle}
        originalHref={src}
        onDocumentTitle={setDisplayTitle}
      />
    </>
  );
}
