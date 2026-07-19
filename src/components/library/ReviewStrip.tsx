"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./ReviewStrip.module.css";

/**
 * Papers a sync auto-filed that await a human glance: keep the AI's topic or
 * re-file into another one. Disappears once nothing is flagged.
 */

interface FlaggedPaper {
  slug: string;
  topic: string;
  title: string;
}

interface ReviewStripProps {
  flagged: FlaggedPaper[];
  topics: string[];
}

export function ReviewStrip({ flagged, topics }: ReviewStripProps) {
  const router = useRouter();
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (flagged.length === 0) return null;

  async function review(paper: FlaggedPaper, moveTo?: string): Promise<void> {
    setBusySlug(paper.slug);
    setError(null);
    const res = await fetch("/api/v1/papers/review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ topic: paper.topic, slug: paper.slug, moveTo }),
    });
    setBusySlug(null);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(data?.error ?? "Could not update the paper.");
      return;
    }
    router.refresh();
  }

  return (
    <section className={styles.root} aria-label="Synced papers to review">
      <h2 className={styles.title}>
        Synced from Zotero · {flagged.length} to review
      </h2>
      <ul className={styles.list}>
        {flagged.map((paper) => (
          <li key={paper.slug} className={styles.row}>
            <span className={styles.name}>
              {paper.title}
              <span className={styles.topic}> → {paper.topic}</span>
            </span>
            <span className={styles.actions}>
              <button
                type="button"
                className={styles.keep}
                onClick={() => void review(paper)}
                disabled={busySlug === paper.slug}
              >
                Keep
              </button>
              <select
                className={styles.select}
                aria-label={`Re-file ${paper.title}`}
                value=""
                onChange={(e) => {
                  if (e.target.value) void review(paper, e.target.value);
                }}
                disabled={busySlug === paper.slug}
              >
                <option value="">Re-file to…</option>
                {topics
                  .filter((t) => t !== paper.topic)
                  .map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
              </select>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}
