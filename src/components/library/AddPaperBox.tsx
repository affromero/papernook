"use client";

import { useState } from "react";
import styles from "./AddPaperBox.module.css";

/**
 * Zero-setup capture: paste any paper URL and go. Navigates to the same
 * /add pipeline the Shortcut and bookmarklet use, so the confirmation page
 * (topic proposal, tags, accept) is identical everywhere.
 */

interface AddPaperBoxProps {
  captureToken: string;
}

export function AddPaperBox({ captureToken }: AddPaperBoxProps) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  function submit(): void {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    window.location.href = `/add?token=${encodeURIComponent(captureToken)}&url=${encodeURIComponent(trimmed)}`;
  }

  return (
    <div className={styles.root}>
      <input
        className={styles.input}
        type="url"
        inputMode="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste a paper link (arxiv, PDF, publisher page)…"
        aria-label="Paper URL to add"
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <button
        type="button"
        className={styles.button}
        onClick={submit}
        disabled={busy || url.trim().length === 0}
      >
        {busy ? "Fetching & analyzing…" : "Add paper"}
      </button>
    </div>
  );
}
