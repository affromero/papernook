"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./LibraryView.module.css";

interface InboxCardDeleteProps {
  slug: string;
  title: string;
}

function errorMessage(payload: unknown): string {
  return payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
    ? payload.error
    : "The capture could not be deleted.";
}

export function InboxCardDelete({ slug, title }: InboxCardDeleteProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    if (
      !window.confirm(
        `Delete “${title}” from the inbox? This also deletes its downloaded PDF.`,
      )
    ) {
      return;
    }

    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/inbox/${slug}`, {
        method: "DELETE",
        credentials: "include",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) {
        router.refresh();
        return;
      }

      setError(errorMessage(payload));
    } catch {
      setError("The capture could not be deleted. Check your connection.");
    }
    setDeleting(false);
  }

  return (
    <div className={styles.cardDeleteArea}>
      <button
        type="button"
        className={styles.cardDelete}
        disabled={deleting}
        onClick={() => void remove()}
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>
      {error && (
        <span className={styles.cardDeleteError} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
