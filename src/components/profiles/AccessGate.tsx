"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./ProfilePicker.module.css";

/**
 * The front-door password prompt for a public instance. No profile names or
 * Add button exist until this passes; on success it reloads into the picker.
 */
export function AccessGate({ configured = true }: { configured?: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Wrong password.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wrong password.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.brand}>papernook</div>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Access password"
      >
        <h1 className={styles.panelTitle}>
          {configured
            ? "Enter the access password"
            : "Public access needs admin setup"}
        </h1>
        <p className={styles.gateHint}>
          {configured
            ? "This is a private paper library. Ask the admin for the access password, or for an invite link."
            : "The admin must set PAPERNOOK_PASSWORD in .env and restart Papernook before anyone can use this public address."}
        </p>
        {configured && (
          <>
            <label className={styles.fieldLabel} htmlFor="gate-password">
              Password
            </label>
            <input
              id="gate-password"
              className={styles.nameInput}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={200}
              autoFocus
              autoComplete="current-password"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.panelActions}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => void submit()}
                disabled={busy || password.length === 0}
              >
                Enter
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
