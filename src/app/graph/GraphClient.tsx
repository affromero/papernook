"use client";

import dynamicImport from "next/dynamic";

/** Cytoscape touches the DOM at import time; client only. */
export const GraphClient = dynamicImport(
  () =>
    import("@/components/graph/LibraryGraph").then((m) => ({
      default: m.LibraryGraph,
    })),
  { ssr: false, loading: () => <p>Building the graph…</p> },
);
