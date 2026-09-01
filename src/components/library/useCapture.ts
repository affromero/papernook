"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * One in-app capture per URL, shared by every component that offers
 * "Add to library" for it (a sources card row, a reference popover, …).
 * The registry lives at module level so a capture keeps polling — and its
 * outcome stays visible — across re-renders and remounts of the button that
 * started it. The server side is the session-authed /api/v1/capture pair:
 * POST starts an async job (202 {slug}); GET ?slug= reports its marker.
 */

export type CaptureState =
  | { status: "idle" }
  | { status: "adding" }
  | { status: "added"; finalSlug: string | null }
  | { status: "failed"; error: string };

interface Entry {
  state: CaptureState;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  startedAt: number;
}

const IDLE: CaptureState = { status: "idle" };
const POLL_MS = 2000;
/** A job marker stuck in `analyzing` this long (server restarted mid-capture) is given up on. */
const MAX_POLL_MS = 10 * 60 * 1000;
const NO_RESPONSE =
  "Capture failed: no response from the server. A slow capture may still finish — check the Inbox before retrying.";

const registry = new Map<string, Entry>();

function entryFor(url: string): Entry {
  let entry = registry.get(url);
  if (!entry) {
    entry = { state: IDLE, listeners: new Set(), timer: null, startedAt: 0 };
    registry.set(url, entry);
  }
  return entry;
}

function setState(entry: Entry, state: CaptureState): void {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

function stopPolling(entry: Entry): void {
  if (entry.timer !== null) clearInterval(entry.timer);
  entry.timer = null;
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export function captureState(url: string): CaptureState {
  return registry.get(url)?.state ?? IDLE;
}

export function subscribeCapture(
  url: string,
  listener: () => void,
): () => void {
  const entry = entryFor(url);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

/** Where a finished capture landed: its inbox review page, else the inbox. */
export function captureInboxHref(finalSlug: string | null): string {
  return finalSlug
    ? `/inbox/${encodeURIComponent(finalSlug)}`
    : "/?topic=_inbox";
}

async function poll(entry: Entry, slug: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/capture?slug=${encodeURIComponent(slug)}`, {
      credentials: "include",
    });
  } catch {
    // Transient network blip: the capture is still running server-side.
    return;
  }
  if (entry.timer === null) return;
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 404) {
    // The marker was already retired (another tab, an earlier poll): the
    // paper is in the inbox even though we never saw its final slug.
    stopPolling(entry);
    setState(entry, { status: "added", finalSlug: null });
    return;
  }
  if (!response.ok) {
    stopPolling(entry);
    setState(entry, {
      status: "failed",
      error: stringField(payload, "error") ?? "Capture failed.",
    });
    return;
  }
  const state = stringField(payload, "state");
  if (state === "done") {
    stopPolling(entry);
    setState(entry, {
      status: "added",
      finalSlug: stringField(payload, "finalSlug"),
    });
  } else if (state === "failed") {
    stopPolling(entry);
    setState(entry, {
      status: "failed",
      error: stringField(payload, "error") ?? "Capture failed.",
    });
  } else if (Date.now() - entry.startedAt >= MAX_POLL_MS) {
    stopPolling(entry);
    setState(entry, { status: "failed", error: NO_RESPONSE });
  }
}

/**
 * Start capturing `url` unless a capture for it is already running or done.
 * Resolves when the job is *started*; the state stream carries the outcome.
 */
export async function startCapture(url: string): Promise<void> {
  const entry = entryFor(url);
  if (entry.state.status === "adding" || entry.state.status === "added") return;
  setState(entry, { status: "adding" });
  let payload: unknown = null;
  let ok = false;
  try {
    const response = await fetch("/api/v1/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ url }),
    });
    ok = response.ok;
    payload = await response.json().catch(() => null);
  } catch {
    setState(entry, { status: "failed", error: "Capture failed." });
    return;
  }
  const slug = stringField(payload, "slug");
  if (!ok || !slug) {
    setState(entry, {
      status: "failed",
      error: stringField(payload, "error") ?? NO_RESPONSE,
    });
    return;
  }
  let inFlight = false;
  entry.startedAt = Date.now();
  entry.timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    poll(entry, slug).finally(() => {
      inFlight = false;
    });
  }, POLL_MS);
}

/** Live capture state for `url` plus a stable starter bound to it. */
export function useCapture(url: string): {
  state: CaptureState;
  start: () => void;
} {
  const state = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeCapture(url, listener),
      [url],
    ),
    () => captureState(url),
    () => IDLE,
  );
  const start = useCallback(() => {
    void startCapture(url);
  }, [url]);
  return { state, start };
}
