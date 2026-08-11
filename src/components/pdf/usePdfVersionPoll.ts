import { useEffect, useRef, type RefObject } from "react";
import { normalizeEtag } from "@/lib/pdf/etag";

/**
 * Poll the PDF's save version (HEAD every 30s and on tab focus) and report
 * a remote change so the reader can pick it up. Guards make sure this
 * session's own in-flight or just-finished save never reads as remote: skip
 * while saving, skip if the tab went dirty or started saving while the HEAD
 * was in flight, and only fire when the baseline etag is still current.
 */
export function usePdfVersionPoll(options: {
  enabled: boolean;
  src: string;
  etagRef: RefObject<string | null>;
  savingRef: RefObject<boolean>;
  dirtyRef: RefObject<boolean>;
  onRemoteUpdate: () => void;
}): void {
  const { enabled, src, etagRef, savingRef, dirtyRef, onRemoteUpdate } =
    options;
  // Latched so a fresh callback closure each render doesn't re-arm the
  // poll and reset the 30s cadence.
  const onRemoteUpdateRef = useRef(onRemoteUpdate);
  useEffect(() => {
    onRemoteUpdateRef.current = onRemoteUpdate;
  });

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    const checkVersion = async () => {
      if (
        disposed ||
        document.visibilityState !== "visible" ||
        savingRef.current
      ) {
        return;
      }
      const baseline = etagRef.current;
      if (!baseline) return;
      try {
        const response = await fetch(src, {
          method: "HEAD",
          cache: "no-store",
          credentials: "same-origin",
        });
        if (disposed || response.status === 409) return;
        if (!response.ok) return;
        // A save that started or was queued while this HEAD was in flight
        // can make the response reflect our own write before the PUT
        // result lands; skip the round instead of flagging our own save
        // as a remote change. A genuine conflict still surfaces as a 412
        // on that save.
        if (savingRef.current || dirtyRef.current) return;
        const current = normalizeEtag(response.headers.get("etag"));
        if (current && current !== baseline && etagRef.current === baseline) {
          onRemoteUpdateRef.current();
        }
      } catch {
        // Connectivity errors are transient; the next poll checks again.
      }
    };

    const interval = window.setInterval(() => void checkVersion(), 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, src, etagRef, savingRef, dirtyRef]);
}
