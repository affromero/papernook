"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ZoteroCard.module.css";

/**
 * Per-profile Zotero connection: paste a read-access API key; the server
 * verifies it and discovers the user ID. New PDF items pull in automatically
 * every 30 minutes, or on demand with "Sync now".
 */

interface ZoteroState {
  connected: boolean;
  userId: string | null;
  syncing: boolean;
}

export function ZoteroCard() {
  const [state, setState] = useState<ZoteroState | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh(): Promise<ZoteroState | null> {
    const res = await fetch("/api/v1/settings/zotero", {
      credentials: "include",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ZoteroState;
    setState(data);
    return data;
  }

  useEffect(() => {
    void fetch("/api/v1/settings/zotero", { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<ZoteroState>) : null))
      .then((d) => {
        if (d) setState(d);
      });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function watchSync(): void {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void refresh().then((data) => {
        if (data && !data.syncing && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setStatus("Sync finished. New papers are filed in the library.");
        }
      });
    }, 3000);
  }

  async function call(method: "PUT" | "POST" | "DELETE"): Promise<void> {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/v1/settings/zotero", {
      method,
      credentials: "include",
      ...(method === "PUT"
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: apiKey.trim() }),
          }
        : {}),
    });
    const data = (await res.json()) as ZoteroState & { error?: string };
    setBusy(false);
    if (!res.ok) {
      setStatus(data.error ?? "Something went wrong.");
      return;
    }
    setState(data);
    if (method === "PUT") {
      setApiKey("");
      setStatus(`Connected to Zotero library ${data.userId}.`);
    }
    if (method === "DELETE") setStatus("Disconnected.");
    if (method === "POST") {
      setStatus("Sync started…");
      watchSync();
    }
  }

  if (!state) return null;

  if (!state.connected) {
    return (
      <div className={styles.root}>
        <p className={styles.line}>
          Create a key with read access at{" "}
          <a
            href="https://www.zotero.org/settings/keys/new"
            target="_blank"
            rel="noreferrer"
          >
            zotero.org/settings/keys
          </a>{" "}
          and paste it here. New papers with PDFs pull in automatically.
        </p>
        <div className={styles.controls}>
          <input
            className={styles.input}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Zotero API key"
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim()) void call("PUT");
            }}
            disabled={busy}
          />
          <button
            type="button"
            className={styles.save}
            onClick={() => void call("PUT")}
            disabled={busy || !apiKey.trim()}
          >
            Connect
          </button>
        </div>
        {status && <p className={styles.status}>{status}</p>}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <p className={styles.line}>
        Connected to Zotero library <code>{state.userId}</code>. New PDF items
        sync every 30 minutes and are filed automatically — review them from the
        library view.
      </p>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.save}
          onClick={() => void call("POST")}
          disabled={busy || state.syncing}
        >
          {state.syncing ? "Syncing…" : "Sync now"}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void call("DELETE")}
          disabled={busy}
        >
          Disconnect
        </button>
      </div>
      {status && <p className={styles.status}>{status}</p>}
    </div>
  );
}
