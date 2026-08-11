"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "./Markdown.module.css";

type CopyState = "idle" | "copied" | "error";

export function CopyCodeButton({ code }: { code: string }) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("error");
    }
  }

  const label =
    state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy";

  return (
    <span className={styles.copyCodeWrap}>
      <button
        type="button"
        className={styles.copyCode}
        data-state={state}
        onClick={() => void copyCode()}
        aria-label="Copy code"
        title={state === "error" ? "Clipboard unavailable. Try again." : label}
      >
        {state === "copied" ? (
          <Check aria-hidden="true" />
        ) : state === "error" ? (
          <TriangleAlert aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
        <span aria-hidden="true">{label}</span>
      </button>
      <span className={styles.srOnly} role="status" aria-live="polite">
        {state === "copied"
          ? "Code copied to clipboard."
          : state === "error"
            ? "Code could not be copied."
            : ""}
      </span>
    </span>
  );
}
