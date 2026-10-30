"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationAsset } from "@/lib/conversations/content";
import styles from "./ConversationView.module.css";

export function ConversationMedia({
  asset,
  url,
}: {
  asset: ConversationAsset;
  url?: string;
}) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = Boolean(asset.data || asset.url);
  async function load(): Promise<void> {
    if (!url || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Could not load attachment.");
      }
      setSource(URL.createObjectURL(await response.blob()));
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not load attachment.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(
    () => () => {
      if (source) URL.revokeObjectURL(source);
    },
    [source],
  );
  return (
    <span className={styles.media}>
      <strong>{asset.name}</strong>
      {(source || (url && available && !error)) && asset.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source || url}
          alt={asset.name}
          loading="lazy"
          onError={() =>
            setError(
              "This image could not be loaded. Retry or open the original share.",
            )
          }
        />
      )}
      {source && asset.kind === "audio" && (
        <audio src={source} controls preload="none" aria-label={asset.name} />
      )}
      {source && asset.kind === "video" && (
        <video src={source} controls preload="none" aria-label={asset.name}>
          <track kind="captions" />
        </video>
      )}
      {!available ? (
        <span>
          The provider did not include this attachment. Open the original share
          or import an export containing it.
        </span>
      ) : !source &&
        asset.kind !== "file" &&
        (asset.kind !== "image" || error) ? (
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy || !url}
        >
          {busy ? "Loading attachment…" : `Load ${asset.kind}`}
        </button>
      ) : null}
      {available && url && (
        <a href={`${url}?download=true`} download>
          Download {asset.kind}
        </a>
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}

export function RichPreview({
  source,
  kind,
}: {
  source: string;
  kind: "svg-preview" | "html-preview" | "mermaid";
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [error, setError] = useState("");
  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object"
      )
        return;
      const value = event.data as Record<string, unknown>;
      if (
        value.type === "papernook-preview-size" &&
        typeof value.height === "number" &&
        Number.isFinite(value.height)
      )
        setHeight(Math.min(1600, Math.max(200, value.height)));
      if (
        value.type === "papernook-preview-error" &&
        typeof value.message === "string"
      )
        setError(value.message.slice(0, 500));
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [source]);
  return (
    <div className={styles.preview}>
      <iframe
        key={`${kind}:${source}`}
        ref={frame}
        sandbox="allow-scripts"
        loading="lazy"
        height={height}
        title={
          kind === "mermaid"
            ? "Mermaid diagram"
            : kind === "svg-preview"
              ? "SVG diagram"
              : "HTML artifact"
        }
        src={`/vendor/conversations/sandbox.html?v=1#${encodeURIComponent(JSON.stringify({ kind, source }))}`}
      />
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>View source</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </div>
  );
}
