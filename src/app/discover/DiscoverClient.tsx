"use client";

import { useEffect, useState } from "react";
import styles from "./discover.module.css";
import { submitCapture } from "@/lib/capture/browser/submit";
import { AddToLibraryButton } from "@/components/library/AddToLibraryButton";

/**
 * Two independent sources of what to read next:
 *  - "Cited in your library": deterministic, server-derived from the papers'
 *    bibliographies. Fetched on mount and rendered even when no AI agent is
 *    configured (the /api/v1/discover route may 409; this section must not
 *    care).
 *  - AI suggestions: ask the agent for papers worth adding, grounded in the
 *    current library. "Add to papernook" hands the suggested URL to the
 *    normal /add capture pipeline (same as AddPaperBox), which downloads,
 *    analyzes, and files it — and surfaces the error if the agent suggested
 *    a dead link.
 */

interface Suggestion {
  title: string;
  authors: string[];
  year: number | null;
  url: string;
  why: string;
}

interface ReadingListCiter {
  topic: string;
  slug: string;
  title: string;
}

interface ReadingListItem {
  key: string;
  title: string;
  entryText: string;
  citedBy: ReadingListCiter[];
  count: number;
}

type ReadingListState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; items: ReadingListItem[] };

interface DiscoverClientProps {
  captureToken: string;
  topics: string[];
}

function CitedWorks() {
  const [state, setState] = useState<ReadingListState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/reading-list", {
          credentials: "include",
        });
        if (!res.ok) throw new Error(`reading list failed (${res.status})`);
        const data = (await res.json()) as { items: ReadingListItem[] };
        if (!cancelled) setState({ status: "ready", items: data.items });
      } catch {
        if (!cancelled) setState({ status: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="Cited in your library">
      <h2 className={styles.sectionTitle}>Cited in your library</h2>
      {state.status === "loading" && (
        <p className={styles.empty}>Looking through your papers’ references…</p>
      )}
      {state.status === "failed" && (
        <p className={styles.empty}>Couldn’t load cited works right now.</p>
      )}
      {state.status === "ready" && state.items.length === 0 && (
        <p className={styles.empty}>
          No cited works yet — works your papers cite but your library lacks
          will appear here.
        </p>
      )}
      {state.status === "ready" && state.items.length > 0 && (
        <ul className={styles.cards}>
          {state.items.map((item) => (
            <li key={item.key} className={styles.card}>
              <h3 className={styles.cardTitle}>{item.title}</h3>
              <p className={styles.entryText}>{item.entryText}</p>
              <p className={styles.cardMeta}>
                Cited by {item.count === 1 ? "1 paper" : `${item.count} papers`}
                {": "}
                {item.citedBy.map((citer, index) => (
                  <span key={`${citer.topic}/${citer.slug}`}>
                    {index > 0 && ", "}
                    <a
                      className={styles.citedByLink}
                      href={`/paper/${citer.topic}/${citer.slug}`}
                    >
                      {citer.title}
                    </a>
                  </span>
                ))}
              </p>
              <div className={styles.cardActions}>
                <AddToLibraryButton resolveQuery={item.entryText} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
      <CitedWorks />

      <h2 className={styles.sectionTitle}>Ask your agent</h2>
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
