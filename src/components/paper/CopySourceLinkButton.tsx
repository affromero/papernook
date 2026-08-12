"use client";

import { Check, Clipboard, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "./PaperHeader.module.css";

type CopyState = "idle" | "copied" | "error";

export function CopySourceLinkButton({ sourceUrl }: { sourceUrl: string }) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copySourceLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sourceUrl);
      setState("copied");
    } catch {
      setState("error");
    }
  }

  const label =
    state === "copied"
      ? "Copied"
      : state === "error"
        ? "Copy failed"
        : "Copy link";

  return (
    <button
      type="button"
      className={styles.sourceButton}
      data-state={state}
      onClick={() => void copySourceLink()}
      aria-label="Copy original paper link"
      title={
        state === "error" ? "Clipboard unavailable. Try again." : sourceUrl
      }
    >
      {state === "copied" ? (
        <Check aria-hidden="true" />
      ) : state === "error" ? (
        <TriangleAlert aria-hidden="true" />
      ) : (
        <Clipboard aria-hidden="true" />
      )}
      <span>{label}</span>
      <span className={styles.srOnly} role="status" aria-live="polite">
        {state === "copied"
          ? "Original paper link copied to clipboard."
          : state === "error"
            ? "Original paper link could not be copied."
            : ""}
      </span>
    </button>
  );
}
