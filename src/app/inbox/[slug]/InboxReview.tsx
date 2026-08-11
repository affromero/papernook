"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./inbox.module.css";

interface InboxReviewProps {
  slug: string;
  topics: string[];
  /** Capture analysis' filing proposal; preselected when present. */
  proposedTopic: string | null;
}

function errorMessage(payload: unknown, fallback: string): string {
  return payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
    ? payload.error
    : fallback;
}

export function InboxReview({ slug, topics, proposedTopic }: InboxReviewProps) {
  const router = useRouter();
  const [topic, setTopic] = useState(proposedTopic ?? topics[0] ?? "unsorted");
  const [busy, setBusy] = useState<"accept" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept(): Promise<void> {
    setBusy("accept");
    setError(null);
    const response = await fetch(`/api/v1/inbox/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ topic: topic.trim() }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (
      response.ok &&
      payload &&
      typeof payload === "object" &&
      "href" in payload &&
      typeof payload.href === "string"
    ) {
      router.push(payload.href);
      router.refresh();
      return;
    }
    setError(errorMessage(payload, "The paper could not be filed."));
    setBusy(null);
  }

  async function discard(): Promise<void> {
    if (!window.confirm("Discard this pending capture?")) return;
    setBusy("discard");
    setError(null);
    const response = await fetch(`/api/v1/inbox/${slug}`, {
      method: "DELETE",
      credentials: "include",
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) {
      router.push("/");
      router.refresh();
      return;
    }
    setError(errorMessage(payload, "The paper could not be discarded."));
    setBusy(null);
  }

  return (
    <div className={styles.review}>
      <label htmlFor="inbox-topic">Library topic</label>
      <input
        id="inbox-topic"
        list="library-topics"
        value={topic}
        disabled={busy !== null}
        onChange={(event) => setTopic(event.target.value)}
      />
      <datalist id="library-topics">
        {topics.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      {topics.length > 0 && (
        <div className={styles.topics}>
          {topics.map((item) => (
            <button
              key={item}
              type="button"
              className={
                item === topic.trim() ? styles.topicActive : styles.topic
              }
              disabled={busy !== null}
              onClick={() => setTopic(item)}
            >
              {item}
            </button>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.accept}
          disabled={busy !== null || topic.trim().length === 0}
          onClick={() => void accept()}
        >
          {busy === "accept" ? "Filing…" : "Add to papernook"}
        </button>
        <button
          type="button"
          className={styles.discard}
          disabled={busy !== null}
          onClick={() => void discard()}
        >
          {busy === "discard" ? "Discarding…" : "Discard"}
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
