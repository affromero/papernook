"use client";

import dynamicImport from "next/dynamic";

/** tldraw touches window at import time — load it client-side only. */
export const CanvasClient = dynamicImport(
  () =>
    import("@/components/canvas/CanvasBoard").then((m) => ({
      default: m.CanvasBoard,
    })),
  { ssr: false, loading: () => <p>Loading canvas…</p> },
);
