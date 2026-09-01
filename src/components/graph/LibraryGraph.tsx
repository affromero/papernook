"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import styles from "./LibraryGraph.module.css";

/**
 * The library as a force-directed graph (Cytoscape + fcose). Papers, authors, topics, and tags are nodes;
 * clicking a paper opens it. Cytoscape renders to canvas and is styled via
 * its JS stylesheet API (accepted CSS-Modules deviation).
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

const EDGE_COLORS = {
  related: "#3f4fb0",
  cites: "#d0342c",
} as const;

const HIDDEN_CLASS = "hidden";

function swatch(color: string): CSSProperties {
  return { "--swatch": color } as CSSProperties;
}

/** Keep only paper nodes and directed citation edges while the filter is on. */
function applyCitationsOnly(cy: cytoscape.Core, on: boolean): void {
  cy.batch(() => {
    cy.elements().removeClass(HIDDEN_CLASS);
    if (!on) return;
    cy.nodes('[kind != "paper"]').addClass(HIDDEN_CLASS);
    cy.edges('[kind != "cites"]').addClass(HIDDEN_CLASS);
  });
}

export function LibraryGraph() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [empty, setEmpty] = useState(false);
  const [citationsOnly, setCitationsOnly] = useState(false);
  // Mirrors state so the async load can apply a toggle made before data arrived.
  const citationsOnlyRef = useRef(false);

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
          ...nodes.map((n, index) => {
            const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
            return {
              data: { id: n.id, label: n.label, kind: n.kind, href: n.href },
              position: {
                x: 400 + Math.cos(angle) * 220,
                y: 300 + Math.sin(angle) * 220,
              },
            };
          }),
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
            style: { "line-color": EDGE_COLORS.related, width: 2 },
          },
          {
            // Haystack edges cannot carry arrowheads; citations are directed.
            selector: 'edge[kind = "cites"]',
            style: {
              "line-color": EDGE_COLORS.cites,
              width: 2,
              "curve-style": "bezier",
              "target-arrow-shape": "triangle",
              "target-arrow-color": EDGE_COLORS.cites,
              "arrow-scale": 0.9,
            },
          },
          {
            selector: `.${HIDDEN_CLASS}`,
            style: { display: "none" },
          },
        ],
        layout: {
          name: "fcose",
          animate: false,
          randomize: false,
          nodeRepulsion: 6000,
          idealEdgeLength: 60,
        } as cytoscape.LayoutOptions,
      });
      cy.on("tap", "node", (event) => {
        const href = event.target.data("href") as string | undefined;
        if (href) router.push(href);
      });
      cyRef.current = cy;
      applyCitationsOnly(cy, citationsOnlyRef.current);
    })();
    return () => {
      cancelled = true;
      cyRef.current = null;
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
            <span className={styles.dot} style={swatch(KIND_COLORS[kind])} />
            {kind}
          </span>
        ))}
        <span className={styles.legendItem}>
          <span className={styles.line} style={swatch(EDGE_COLORS.related)} />
          related
        </span>
        <span className={styles.legendItem}>
          <span className={styles.arrow} style={swatch(EDGE_COLORS.cites)} />
          cites
        </span>
      </div>
      <label className={styles.filter}>
        <input
          type="checkbox"
          checked={citationsOnly}
          onChange={(event) => {
            const on = event.target.checked;
            citationsOnlyRef.current = on;
            setCitationsOnly(on);
            const cy = cyRef.current;
            if (cy) applyCitationsOnly(cy, on);
          }}
        />
        Citations only
      </label>
    </div>
  );
}
