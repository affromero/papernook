"use client";

import { useEffect, useState } from "react";
import { downloadOffline, formatBytes } from "@/lib/offline/download";
import {
  listOffline,
  offlineError,
  removeOffline,
  subscribeOffline,
} from "@/lib/offline/storage";
import type { OfflineRecord } from "@/lib/offline/types";
import styles from "./Offline.module.css";

export function OfflineStorage() {
  const [items, setItems] = useState<OfflineRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void listOffline()
        .then((value) => {
          if (active) setItems(value);
        })
        .catch((cause) => {
          if (active) setError(offlineError(cause));
        });
    };
    refresh();
    const unsubscribe = subscribeOffline(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setItems(await listOffline());
    } catch (cause) {
      setError(offlineError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.storage} id="offline-storage">
      <h2>Offline storage</h2>
      <p>
        {items.length} downloads ·{" "}
        {formatBytes(items.reduce((sum, item) => sum + item.bytes, 0))}
      </p>
      <p>
        Saved in this browser on this device. Removing downloads leaves your
        server library intact. Switching profiles or logging out clears private
        downloads. Your browser may reclaim storage; export PDF or HTML to keep
        independent files.
      </p>
      <a href="/offline/index.html">Open downloaded library</a>
      {error && <p role="alert">{error}</p>}
      <ul>
        {items.map((item) => (
          <li key={item.manifest.key}>
            <div>
              <a
                href={`/offline/index.html?key=${encodeURIComponent(item.manifest.key)}`}
              >
                {item.manifest.title}
              </a>
              <p>
                {item.manifest.kind === "paper" ? "Paper" : "Conversation"} ·{" "}
                {item.manifest.topic} · {formatBytes(item.bytes)}
              </p>
              <p>Saved {new Date(item.downloadedAt).toLocaleString()}</p>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(() => downloadOffline(item.manifest.snapshotUrl))
                }
              >
                Update
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => removeOffline(item.manifest.key))}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={busy || !items.length}
        onClick={() => {
          if (
            window.confirm(
              "Remove all downloads from this device? Server documents will remain.",
            )
          )
            void act(() => removeOffline());
        }}
      >
        Clear all downloads
      </button>
    </section>
  );
}
