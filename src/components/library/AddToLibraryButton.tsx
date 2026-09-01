"use client";

import { useState } from "react";
import { captureInboxHref, startCapture, useCapture } from "./useCapture";
import styles from "./AddToLibraryButton.module.css";

/**
 * Shared "Add to library" affordance. Two entry points:
 *  - `url`: the work's link is already known (a chat sources card row) —
 *    hand it straight to the shared capture registry.
 *  - `resolveQuery`: only the bibliography entry text is known (a citation
 *    popover) — resolve it to a capturable URL server-side via
 *    /api/v1/citations/resolve first, then capture.
 * Capture progress lives in the module-level registry (`useCapture`), so
 * the outcome stays visible across remounts of whichever surface hosts it.
 */

type AddToLibraryButtonProps =
  | { url: string; resolveQuery?: undefined }
  | { url?: undefined; resolveQuery: string };

type ResolveState =
  | { status: "idle" }
  | { status: "resolving" }
  | { status: "notFound" }
  | { status: "failed"; error: string }
  | { status: "resolved"; url: string };

function CaptureAction({ url }: { url: string }) {
  const { state, start } = useCapture(url);
  if (state.status === "added") {
    return (
      <a className={styles.added} href={captureInboxHref(state.finalSlug)}>
        Added ✓ · review in Inbox
      </a>
    );
  }
  if (state.status === "adding") {
    return (
      <span className={styles.adding} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        Adding…
      </span>
    );
  }
  return (
    <span className={styles.actionGroup}>
      <button type="button" className={styles.addBtn} onClick={start}>
        {state.status === "failed" ? "Retry" : "+ Add to library"}
      </button>
      {state.status === "failed" && (
        <span className={styles.failed} role="alert" title={state.error}>
          Failed · {state.error}
        </span>
      )}
    </span>
  );
}

function ResolveAndCapture({ query }: { query: string }) {
  const [state, setState] = useState<ResolveState>({ status: "idle" });

  async function resolveAndCapture(): Promise<void> {
    // The resolve API requires 12-400 chars.
    if (query.length < 12) {
      setState({ status: "notFound" });
      return;
    }
    setState({ status: "resolving" });
    try {
      const response = await fetch(
        `/api/v1/citations/resolve?q=${encodeURIComponent(query.slice(0, 400))}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) {
        setState({
          status: "failed",
          error:
            response.status === 429
              ? "too many lookups, try again later"
              : `lookup failed (${response.status})`,
        });
        return;
      }
      const data = (await response.json()) as { url: string | null };
      if (!data.url) {
        setState({ status: "notFound" });
        return;
      }
      await startCapture(data.url);
      setState({ status: "resolved", url: data.url });
    } catch {
      setState({ status: "failed", error: "lookup failed" });
    }
  }

  if (state.status === "resolved") return <CaptureAction url={state.url} />;
  if (state.status === "resolving") {
    return (
      <span className={styles.stateText} role="status">
        Resolving…
      </span>
    );
  }
  if (state.status === "notFound") {
    return (
      <span className={styles.stateText} role="status">
        Not found online
      </span>
    );
  }
  return (
    <span className={styles.actionGroup}>
      <button
        type="button"
        className={styles.addBtn}
        onClick={() => void resolveAndCapture()}
      >
        {state.status === "failed" ? "Retry" : "+ Add to library"}
      </button>
      {state.status === "failed" && (
        <span className={styles.failed} role="alert" title={state.error}>
          Failed · {state.error}
        </span>
      )}
    </span>
  );
}

export function AddToLibraryButton(props: AddToLibraryButtonProps) {
  if (props.url !== undefined) return <CaptureAction url={props.url} />;
  return <ResolveAndCapture query={props.resolveQuery} />;
}
