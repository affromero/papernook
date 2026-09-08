"use client";

import { useSyncExternalStore } from "react";

const EVENT = "papernook-server-connection";
let reachable = true;

export function reportServerConnection(available: boolean): void {
  if (reachable === available) return;
  reachable = available;
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(listener: () => void): () => void {
  for (const event of [EVENT, "online", "offline"])
    window.addEventListener(event, listener);
  return () => {
    for (const event of [EVENT, "online", "offline"])
      window.removeEventListener(event, listener);
  };
}

export function useConnection(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => reachable && navigator.onLine,
    () => true,
  );
}
