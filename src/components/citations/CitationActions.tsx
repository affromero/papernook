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

  async function copyApa(): Promise<void> {
    setStatus(null);
    try {
      const response = await fetch(`${base}?format=apa`, {
        credentials: "include",
      });
      if (!response.ok) {
        setStatus("Could not format this citation.");
        return;
      }
      await navigator.clipboard.writeText(await response.text());
      setStatus("APA bibliography entry copied.");
    } catch {
      setStatus("Could not copy this citation.");
    }
  }

  return (
    <div className={styles.root}>
      <details className={styles.menu}>
        <summary>Cite</summary>
        <div className={styles.panel}>
          <button type="button" onClick={() => void copyApa()}>
            Copy APA
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
