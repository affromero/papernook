"use client";

import { useState } from "react";
import styles from "./CitationActions.module.css";

interface CitationActionsProps {
  topic: string;
  slug: string;
}

export function CitationActions({ topic, slug }: CitationActionsProps) {
  const [status, setStatus] = useState<string | null>(null);
  const base = `/api/v1/papers/${topic}/${slug}/citation`;

  async function copyBibliography(
    format: "apa" | "harvard" | "vancouver",
    label: string,
  ): Promise<void> {
    setStatus(null);
    try {
      const response = await fetch(`${base}?format=${format}`, {
        credentials: "include",
      });
      if (!response.ok) {
        setStatus("Could not format this citation.");
        return;
      }
      await navigator.clipboard.writeText(await response.text());
      setStatus(`${label} bibliography entry copied.`);
    } catch {
      setStatus("Could not copy this citation.");
    }
  }

  return (
    <div className={styles.root}>
      <details className={styles.menu}>
        <summary>Cite</summary>
        <div className={styles.panel}>
          <button
            type="button"
            onClick={() => void copyBibliography("apa", "APA")}
          >
            Copy APA
          </button>
          <button
            type="button"
            onClick={() => void copyBibliography("harvard", "Harvard")}
          >
            Copy Harvard
          </button>
          <button
            type="button"
            onClick={() => void copyBibliography("vancouver", "Vancouver")}
          >
            Copy Vancouver
          </button>
          <a href={`${base}?format=csl-json`}>CSL JSON</a>
          <a href={`${base}?format=ris`}>RIS</a>
          <a href={`${base}?format=bibtex`}>BibTeX</a>
        </div>
      </details>
      {status && (
        <span className={styles.status} role="status">
          {status}
        </span>
      )}
    </div>
  );
}
