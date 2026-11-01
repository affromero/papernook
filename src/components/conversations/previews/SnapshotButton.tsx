"use client";

import { useEffect, useRef, useState } from "react";
import { previewIdentity } from "@/lib/conversations/previews/identity";

interface Pending {
  nonce: string;
  frame: Window;
  resolve(value: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export function SnapshotButton({
  kind,
  source,
  url,
  getFrame,
}: {
  kind: string;
  source: string;
  url: string;
  getFrame(): Window | null | undefined;
}) {
  const pending = useRef<Pending | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    source: string;
    url: string;
    kind: string;
    busy: boolean;
    message: string;
    error: boolean;
  } | null>(null);
  const current =
    state?.source === source && state.url === url && state.kind === kind
      ? state
      : null;
  useEffect(() => {
    function receive(event: MessageEvent<unknown>): void {
      const request = pending.current;
      const data = event.data;
      if (
        !request ||
        event.source !== request.frame ||
        event.origin !== "null" ||
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        data.type !== "papernook-preview-image" ||
        !("nonce" in data) ||
        data.nonce !== request.nonce
      )
        return;
      pending.current = null;
      clearTimeout(request.timer);
      if (
        "image" in data &&
        typeof data.image === "string" &&
        data.image.length <= 2_800_000
      )
        request.resolve(data.image);
      else
        request.reject(
          new Error(
            "error" in data && typeof data.error === "string"
              ? data.error.slice(0, 500)
              : "Preview image is unavailable.",
          ),
        );
    }
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      controller.current?.abort();
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.reject(new Error("Preview changed during capture."));
        pending.current = null;
      }
    };
  }, [kind, source, url]);

  async function save(): Promise<void> {
    if (current?.busy) return;
    const active = new AbortController();
    controller.current = active;
    setState({ source, url, kind, busy: true, message: "", error: false });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const frame = getFrame();
      if (!frame)
        throw new Error("Preview is not ready. Try again after it loads.");
      const image = await new Promise<string>((resolve, reject) => {
        const nonce = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.current = null;
          reject(
            new Error(
              "Preview capture timed out. Its source remains available for export.",
            ),
          );
        }, 12_000);
        pending.current = { frame, nonce, resolve, reject, timer };
        frame.postMessage({ type: "papernook-preview-capture", nonce }, "*");
      });
      if (active.signal.aborted) return;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(previewIdentity(kind, source)),
      );
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      timeout = setTimeout(
        () =>
          active.abort(
            new Error("Saving the preview image timed out. Try again."),
          ),
        12_000,
      );
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash, kind, image }),
        signal: active.signal,
      });
      if (!response.ok) {
        const result: unknown = await response.json();
        throw new Error(
          result &&
            typeof result === "object" &&
            "error" in result &&
            typeof result.error === "string"
            ? result.error
            : "Preview image could not be saved.",
        );
      }
      if (!active.signal.aborted)
        setState({
          source,
          url,
          kind,
          busy: false,
          message: "Image saved for HTML and PDF export.",
          error: false,
        });
    } catch (error) {
      if (controller.current === active)
        setState({
          source,
          url,
          kind,
          busy: false,
          message:
            active.signal.aborted && active.signal.reason instanceof Error
              ? active.signal.reason.message
              : error instanceof Error
                ? error.message
                : "Preview image could not be saved.",
          error: true,
        });
    } finally {
      clearTimeout(timeout);
      if (controller.current === active) controller.current = null;
    }
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => void save()}
        disabled={current?.busy}
      >
        {current?.busy ? "Saving image…" : "Save image for export"}
      </button>
      {current?.message && (
        <p role={current.error ? "alert" : "status"}>{current.message}</p>
      )}
    </div>
  );
}
