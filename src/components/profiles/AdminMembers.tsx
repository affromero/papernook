"use client";

import { useState } from "react";
import styles from "./AdminMembers.module.css";

/** Admin-only member list with removal (chats and tokens go with it). */

interface Member {
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export function AdminMembers({ members }: { members: Member[] }) {
  const [gone, setGone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function remove(username: string): Promise<void> {
    setError(null);
    const res = await fetch(`/api/v1/profiles/${username}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      setGone((g) => [...g, username]);
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not remove the profile.");
    }
  }

  const visible = members.filter((m) => !gone.includes(m.username));
  return (
    <div>
      <ul className={styles.list}>
        {visible.map((m) => (
          <li key={m.username} className={styles.row}>
            <span>
              {m.displayName} <code>{m.username}</code>{" "}
              {m.isAdmin && <strong>(admin)</strong>}
            </span>
            {!m.isAdmin && (
              <button
                type="button"
                className={styles.remove}
                onClick={() => void remove(m.username)}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
