"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./AdminMembers.module.css";

/** Admin-only member list with complete profile erasure. */

interface Member {
  username: string;
  displayName: string;
  isAdmin: boolean;
}

interface PendingErasure {
  username: string;
  status: "pending" | "waiting" | "failed";
}

export function AdminMembers({ members }: { members: Member[] }) {
  const [visible, setVisible] = useState(members);
  const [removing, setRemoving] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingErasure[]>([]);
  const [workerRunning, setWorkerRunning] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current += 1;
      mutation.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const admittedEpoch = epoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(): Promise<void> {
      if (controller.signal.aborted || admittedEpoch !== epoch.current) return;
      try {
        const response = await fetch("/api/v1/profiles", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted || admittedEpoch !== epoch.current)
          return;
        if (response.status === 401 || response.status === 403) {
          setAuthorized(false);
          setPending([]);
          setVisible([]);
          return;
        }
        if (!response.ok)
          throw new Error(
            "Cleanup status could not be refreshed. The displayed status may be out of date.",
          );
        const body = (await response.json()) as {
          owner?: boolean;
          profiles: Member[];
          erasures?: { workerRunning: boolean; profiles: PendingErasure[] };
        };
        if (controller.signal.aborted || admittedEpoch !== epoch.current)
          return;
        if (!body.owner || !body.erasures) {
          setAuthorized(false);
          setPending([]);
          setVisible([]);
          return;
        }
        setAuthorized(true);
        setVisible(body.profiles);
        setPending(body.erasures.profiles);
        setWorkerRunning(body.erasures.workerRunning);
        setStatusError(null);
      } catch {
        if (controller.signal.aborted || admittedEpoch !== epoch.current)
          return;
        setStatusError(
          "Cleanup status could not be refreshed. The displayed status may be out of date.",
        );
      }
      if (!controller.signal.aborted && admittedEpoch === epoch.current)
        timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  async function remove(username: string): Promise<void> {
    if (!authorized || mutation.current) return;
    if (
      !window.confirm(
        `Completely remove ${username}? Their profile, chats, captures, and owned share links will be erased. Shared confirmed papers remain.`,
      )
    ) {
      return;
    }
    setError(null);
    const admittedEpoch = ++epoch.current;
    const controller = new AbortController();
    mutation.current = controller;
    setRemoving(true);
    try {
      const res = await fetch(`/api/v1/profiles/${username}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ confirmation: username }),
      });
      if (controller.signal.aborted || admittedEpoch !== epoch.current) return;
      if (res.status === 401 || res.status === 403) {
        setError(
          "The server did not authorize removal. Verify your account before trying again.",
        );
        setAuthorized(false);
        setPending([]);
        setVisible([]);
        return;
      }
      if (res.ok) {
        setVisible((entries) =>
          entries.filter((entry) => entry.username !== username),
        );
        setPending((entries) => [
          ...entries.filter((entry) => entry.username !== username),
          { username, status: "pending" },
        ]);
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (controller.signal.aborted || admittedEpoch !== epoch.current)
          return;
        setError(body.error ?? "Could not remove the profile.");
      }
    } catch {
      if (controller.signal.aborted || admittedEpoch !== epoch.current) return;
      setError(
        "Could not confirm profile removal. Refresh the page before trying again.",
      );
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted && admittedEpoch === epoch.current) {
        epoch.current += 1;
        setRemoving(false);
        setRefresh((value) => value + 1);
      }
    }
  }

  if (!authorized) return <p>Owner access is required to manage members.</p>;
  return (
    <div>
      <ul className={styles.list}>
        {visible.map((m) => (
          <li key={m.username} className={styles.row}>
            <span>
              {m.displayName}{" "}
              {m.displayName.trim().toLocaleLowerCase() !==
                m.username.toLocaleLowerCase() && (
                <code>{m.username}</code>
              )}{" "}
              {m.isAdmin && <strong>(admin)</strong>}
            </span>
            {!m.isAdmin && (
              <button
                type="button"
                className={styles.remove}
                disabled={removing}
                onClick={() => void remove(m.username)}
              >
                Remove completely
              </button>
            )}
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <div aria-live="polite">
          <h4>Pending erasure</h4>
          <p>
            Access is revoked. Private file cleanup continues in the background.
          </p>
          <ul className={styles.list}>
            {pending.map((entry) => (
              <li key={entry.username} className={styles.row}>
                <span>{entry.username}</span>
                <span>
                  {entry.status === "failed"
                    ? "Cleanup needs attention. Automatic retries continue."
                    : entry.status === "waiting"
                      ? "Waiting for active work to finish."
                      : "Cleanup queued."}
                </span>
              </li>
            ))}
          </ul>
          {!workerRunning && (
            <p className={styles.error}>
              The cleanup worker is not running in this server process. Check
              the local access migration and server logs.
            </p>
          )}
        </div>
      )}
      {statusError && (
        <p className={styles.error} role="alert">
          {statusError}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
