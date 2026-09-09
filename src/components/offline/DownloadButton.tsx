"use client";

import { useEffect, useId, useState } from "react";
import { CircleCheck, Download, RefreshCw } from "lucide-react";
import { downloadOffline } from "@/lib/offline/download";
import {
  listOffline,
  offlineError,
  subscribeOffline,
} from "@/lib/offline/storage";
import styles from "./Offline.module.css";

export async function ensureOfflineReader(): Promise<void> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext)
    throw new Error(
      "Offline reading requires HTTPS or localhost and a browser with service worker support.",
    );
  await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  const registration = await new Promise<ServiceWorkerRegistration>(
    (resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Offline reader installation timed out. Check your connection and try again.",
            ),
          ),
        90_000,
      );
      navigator.serviceWorker.ready.then(
        (ready) => {
          clearTimeout(timer);
          resolve(ready);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    },
  );
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(
        new Error("The offline reader is not ready. Reload and try again."),
      );
    }, 10_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      if (event.data?.ready) resolve();
      else reject(new Error("The offline reader is not completely installed."));
    };
    registration.active?.postMessage({ type: "OFFLINE_READY" }, [
      channel.port2,
    ]);
  });
}

export function DownloadButton({ snapshotUrl }: { snapshotUrl: string }) {
  const descriptionId = useId();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void listOffline()
        .then((items) => {
          if (active)
            setSaved(
              items.some((item) => item.manifest.snapshotUrl === snapshotUrl),
            );
        })
        .catch(() => {});
    };
    refresh();
    const unsubscribe = subscribeOffline(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [snapshotUrl]);
  async function download() {
    setBusy(true);
    setError(null);
    try {
      await ensureOfflineReader();
      await navigator.storage?.persist?.();
      await downloadOffline(snapshotUrl);
      setSaved(true);
    } catch (cause) {
      setError(offlineError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.download} data-saved={saved}>
      <div className={styles.downloadDescription} hidden={!saved}>
        <p id={descriptionId} role="status">
          {saved && (
            <>
              <CircleCheck aria-hidden="true" />
              Saved on this device
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        aria-describedby={saved ? descriptionId : undefined}
        onClick={() => void download()}
      >
        {saved ? (
          <RefreshCw aria-hidden="true" />
        ) : (
          <Download aria-hidden="true" />
        )}
        {busy
          ? saved
            ? "Updating…"
            : "Saving…"
          : saved
            ? "Update copy"
            : "Save for offline"}
      </button>
      {saved && <a href="/offline/index.html">Open downloads</a>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
