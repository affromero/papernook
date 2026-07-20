"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./ProfilePassword.module.css";

export function ProfilePassword({
  username,
  configured,
}: {
  username: string;
  configured: boolean;
}) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (newPassword.length < 12 || busy) return;
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/v1/profiles/${username}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok) {
      setMessage(body.error ?? "Could not update the password.");
      setBusy(false);
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setMessage("Password saved. Other sessions were signed out.");
    setBusy(false);
    router.refresh();
  }

  return (
    <div className={styles.root}>
      {configured && (
        <label>
          Current profile password
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            maxLength={200}
            autoComplete="current-password"
          />
        </label>
      )}
      <label>
        {configured ? "New profile password" : "Create a profile password"}
        <input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          minLength={12}
          maxLength={200}
          autoComplete="new-password"
        />
      </label>
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || newPassword.length < 12}
      >
        {busy ? "Saving…" : "Save password"}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
