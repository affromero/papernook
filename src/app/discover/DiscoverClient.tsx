"use client";

import { useState } from "react";
import styles from "./discover.module.css";
import { submitCapture } from "@/lib/capture/browser/submit";

/**
 * Ask the agent for papers worth adding, grounded in the current library.
 * "Add to papernook" hands the suggested URL to the normal /add capture
 * pipeline (same as AddPaperBox), which downloads, analyzes, and files it —
 * and surfaces the error if the agent suggested a dead link.
 */

interface Suggestion {
  title: string;
  authors: string[];
  year: number | null;
  url: string;
  why: string;
}

interface DiscoverClientProps {
  captureToken: string;
  topics: string[];
}

export function DiscoverClient({ captureToken, topics }: DiscoverClientProps) {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);

  async function discover(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/discover", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(topic ? { topic } : {}),
      });
      const data = (await res.json()) as {
        suggestions?: Suggestion[];
        error?: string;
      };
      if (!res.ok || !data.suggestions) {
        throw new Error(data.error ?? `Discovery failed (${res.status}).`);
      }
      setSuggestions(data.suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function addToLibrary(url: string): void {
    submitCapture("/add", captureToken, url);
  }

  return (
    <section className={styles.body}>
      <div className={styles.controls}>
        <select
          className={styles.topicSelect}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          aria-label="Focus discovery on a topic"
          disabled={busy}
        >
          <option value="">Whole library</option>
          {topics.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.goButton}
          onClick={() => void discover()}
          disabled={busy}
        >
          {busy ? "Asking your agent…" : "Find related work"}
        </button>
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {suggestions?.length === 0 && (
        <p className={styles.empty}>The agent had nothing new to suggest.</p>
      )}

      {suggestions && suggestions.length > 0 && (
        <ul className={styles.cards}>
          {suggestions.map((s) => (
            <li key={s.url} className={styles.card}>
              <h3 className={styles.cardTitle}>{s.title}</h3>
              <p className={styles.cardMeta}>
                {s.authors.join(", ")}
                {s.year ? ` · ${s.year}` : ""}
              </p>
              <p className={styles.cardWhy}>{s.why}</p>
              <div className={styles.cardActions}>
                <a
                  className={styles.sourceLink}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Source ↗
                </a>
                <button
                  type="button"
                  className={styles.addButton}
                  onClick={() => addToLibrary(s.url)}
                >
                  Add to papernook
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
