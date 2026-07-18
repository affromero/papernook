"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import styles from "./LibraryGraph.module.css";

/**
 * The library as a force-directed graph (Cytoscape + fcose, the same stack
 * as Sotto's memory graph). Papers, authors, topics, and tags are nodes;
 * clicking a paper opens it. Cytoscape renders to canvas and is styled via
 * its JS stylesheet API (accepted CSS-Modules deviation, as in Sotto).
 */

cytoscape.use(fcose);

interface GraphNode {
  id: string;
  label: string;
  kind: "paper" | "author" | "topic" | "tag";
  href?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

const KIND_COLORS: Record<GraphNode["kind"], string> = {
  paper: "#3f4fb0",
  author: "#1f8a5b",
  topic: "#c2730a",
  tag: "#b83280",
};

export function LibraryGraph() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let cy: cytoscape.Core | null = null;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/v1/graph", { credentials: "include" });
      const data = (await res.json()) as {
        nodes?: GraphNode[];
        edges?: GraphEdge[];
      };
      if (cancelled || !containerRef.current) return;
      const nodes = data.nodes ?? [];
      if (nodes.length === 0) {
        setEmpty(true);
        return;
      }
      cy = cytoscape({
        container: containerRef.current,
        elements: [
          ...nodes.map((n) => ({
            data: { id: n.id, label: n.label, kind: n.kind, href: n.href },
          })),
          ...(data.edges ?? []).map((e, i) => ({
            data: {
              id: `e${i}`,
              source: e.source,
              target: e.target,
              kind: e.kind,
            },
          })),
        ],
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "font-size": 9,
              color: "#565b68",
              "text-wrap": "ellipsis",
              "text-max-width": "120",
              "text-valign": "bottom",
              "text-margin-y": 4,
              width: 14,
              height: 14,
              "background-color": "#999",
            },
          },
          ...(Object.keys(KIND_COLORS) as GraphNode["kind"][]).map((kind) => ({
            selector: `node[kind = "${kind}"]`,
            style: { "background-color": KIND_COLORS[kind] },
          })),
          {
            selector: 'node[kind = "paper"]',
            style: { width: 26, height: 26, "font-size": 10 },
          },
          {
            selector: "edge",
            style: {
              width: 1,
              "line-color": "#c8c8c8",
              "curve-style": "haystack",
            },
          },
          {
            selector: 'edge[kind = "related"]',
            style: { "line-color": "#3f4fb0", width: 2 },
          },
        ],
        layout: {
          name: "fcose",
          animate: false,
          nodeRepulsion: 6000,
          idealEdgeLength: 60,
        } as cytoscape.LayoutOptions,
        wheelSensitivity: 0.2,
      });
      cy.on("tap", "node", (event) => {
        const href = event.target.data("href") as string | undefined;
        if (href) router.push(href);
      });
    })();
    return () => {
      cancelled = true;
      cy?.destroy();
    };
  }, [router]);

  if (empty) {
    return (
      <p className={styles.empty}>
        The graph appears once the library has papers. Add one and come back.
      </p>
    );
  }
  return (
    <div className={styles.wrap}>
      <div ref={containerRef} className={styles.canvas} />
      <div className={styles.legend}>
        {(Object.keys(KIND_COLORS) as GraphNode["kind"][]).map((kind) => (
          <span key={kind} className={styles.legendItem}>
            <span
              className={styles.dot}
              style={{ backgroundColor: KIND_COLORS[kind] }}
            />
            {kind}
          </span>
        ))}
      </div>
    </div>
  );
}
