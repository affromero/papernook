"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationAsset } from "@/lib/conversations/content";
import styles from "./ConversationView.module.css";
import type { PreviewKind } from "@/lib/conversations/preview";
import dynamic from "next/dynamic";
import { snapshotBridge } from "@/lib/conversations/formats/mcp";
import { cardMarkdown } from "@/lib/conversations/formats/cards";
import { object, text } from "@/lib/conversations/formats/schema";
import { Markdown } from "@/components/chat/Markdown";
import { SnapshotButton } from "./previews/SnapshotButton";

const DocumentPreview = dynamic(() => import("./documents/DocumentPreview"), {
  ssr: false,
});

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
  const [preview, setPreview] = useState(false);
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
      {available && url && asset.kind === "file" && (
        <button
          type="button"
          onClick={() => setPreview((value) => !value)}
          aria-expanded={preview}
        >
          {preview ? "Close document preview" : "Preview document"}
        </button>
      )}
      {preview && url && (
        <DocumentPreview
          asset={asset}
          url={url}
          onClose={() => setPreview(false)}
        />
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}

export function RichPreview({
  source,
  kind,
  assets,
  assetBase,
  previewExportBase,
}: {
  source: string;
  kind: PreviewKind;
  assets?: ConversationAsset[];
  assetBase?: string;
  previewExportBase?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [error, setError] = useState("");
  let cardContent = "";
  let cardError = "";
  let cardActions: string[] = [];
  if (kind === "card-preview") {
    try {
      const card: unknown = JSON.parse(source);
      cardContent = cardMarkdown(card, assets, false);
      const actions = object(card)?.actions;
      cardActions = Array.isArray(actions)
        ? actions.map((action) => text(object(action)?.title) || "Card action")
        : [];
    } catch (error) {
      cardError = error instanceof Error ? error.message : "Invalid card.";
    }
  }
  useEffect(() => {
    const bridge = kind === "mcp-preview" ? snapshotBridge(source) : null;
    const listener = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object"
      )
        return;
      const value = event.data as Record<string, unknown>;
      if (bridge && event.origin === "null") {
        for (const reply of bridge(value))
          frame.current?.contentWindow?.postMessage(reply, "*");
      }
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
  }, [kind, source]);
  return (
    <div className={styles.preview}>
      {kind === "card-preview" ? (
        <section role="region" aria-label="Adaptive Card">
          <Markdown
            content={cardContent}
            assets={assets}
            assetBase={assetBase}
            paperRefs={false}
          />
          {cardActions.map((title, index) => (
            <button key={index} type="button" disabled>
              {title}
            </button>
          ))}
        </section>
      ) : (
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
                : kind === "react-preview"
                  ? "React artifact"
                  : kind === "notebook-preview"
                    ? "Notebook output"
                    : kind === "mcp-preview"
                      ? "MCP app snapshot"
                      : "HTML artifact"
          }
          src={`/vendor/conversations/sandbox.html?v=2#${encodeURIComponent(JSON.stringify({ kind, source }))}`}
        />
      )}
      {(error || cardError) && <p role="alert">{error || cardError}</p>}
      {previewExportBase && kind !== "card-preview" && (
        <SnapshotButton
          kind={kind}
          source={source}
          url={previewExportBase}
          getFrame={() => frame.current?.contentWindow}
        />
      )}
      <details>
        <summary>View source</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </div>
  );
}
