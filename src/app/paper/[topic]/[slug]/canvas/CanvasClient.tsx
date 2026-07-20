"use client";

import dynamicImport from "next/dynamic";
import type { CanvasBoardProps } from "@/components/canvas/CanvasBoard";

/** tldraw touches window at import time; load it client-side only. */
export const CanvasClient = dynamicImport<CanvasBoardProps>(
  () =>
    import("@/components/canvas/CanvasBoard").then((m) => ({
      default: m.CanvasBoard,
    })),
  { ssr: false, loading: () => <p>Opening canvas…</p> },
);
