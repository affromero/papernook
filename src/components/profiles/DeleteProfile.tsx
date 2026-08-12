"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./DeleteProfile.module.css";

export function DeleteProfile({ username }: { username: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function erase(): Promise<void> {
    if (confirmation !== username || busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/v1/profiles/${username}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ confirmation }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(body.error ?? "Could not delete the profile.");
      setBusy(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        className={styles.open}
        onClick={() => setOpen(true)}
      >
        Delete my profile and data
      </button>
    );
  }

  return (
    <div className={styles.confirm} role="group" aria-label="Delete profile">
      <p>
        This permanently removes your profile, capture token, Zotero connection,
        chats, pasted chat images, pending captures, and owned share links.
        Confirmed papers and shared annotations remain, without your profile
        attribution.
      </p>
      <label htmlFor="delete-profile-confirmation">
        Type <code>{username}</code> to confirm
      </label>
      <input
        id="delete-profile-confirmation"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        autoComplete="off"
      />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cancel}
          onClick={() => {
            setOpen(false);
            setConfirmation("");
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.erase}
          onClick={() => void erase()}
          disabled={busy || confirmation !== username}
        >
          {busy ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </div>
  );
}
