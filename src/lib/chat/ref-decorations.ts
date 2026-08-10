/**
 * Rehype transform decorating chat prose with interactive references:
 * in-paper refs ("Figure 3", "Sec. 4.3") always, bibliography citations
 * ("[20]", "Kheradmand et al. 2024") only once the PDF side has published
 * its scanned bibliography — undecorated citations would be dead
 * affordances, and the author-year pattern is too aggressive on prose to
 * mark unverified.
 *
 * Emits plain hast <button> elements carrying JSON payloads in data
 * attributes; ChatPanel owns the (delegated) event handlers, so this stays
 * a pure transform usable from Server Components. It must run AFTER
 * rehype-katex and still skips katex/math subtrees — their MathML
 * annotation nodes contain literal TeX source. Payloads go into data-*
 * and text only; never href, src, or style.
 */

import {
  matchCitation,
  type Bibliography,
  type BibEntry,
} from "@/lib/pdf/bibliography";
import { findCitations } from "@/lib/pdf/citations";
import { findPaperRefs } from "@/lib/pdf/paper-refs";

/** Minimal structural hast typing (no @types/hast direct dependency). */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP_TAGS = new Set(["code", "pre", "a", "button", "script", "style"]);
const SKIP_CLASSES = ["katex", "katex-display", "katex-error", "math"];

function skippedElement(node: HastNode): boolean {
  if (node.tagName && SKIP_TAGS.has(node.tagName)) return true;
  const className = node.properties?.className;
  const classes = Array.isArray(className)
    ? className.map(String)
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  return classes.some((name) => SKIP_CLASSES.includes(name));
}

interface Decoration {
  start: number;
  end: number;
  properties: Record<string, unknown>;
}

function refDecorations(text: string): Decoration[] {
  return findPaperRefs(text).map((ref) => ({
    start: ref.start,
    end: ref.end,
    properties: {
      type: "button",
      dataPaperRef: JSON.stringify({ kind: ref.kind, label: ref.label }),
      ariaLabel: `Go to ${ref.kind} ${ref.label} in the paper`,
    },
  }));
}

function citationDecorations(
  text: string,
  bibliography: Bibliography,
): Decoration[] {
  return findCitations(text).flatMap((citation) => {
    const entry: BibEntry | null = matchCitation(bibliography, citation.key);
    if (!entry) return [];
    return [
      {
        start: citation.start,
        end: citation.end,
        properties: {
          type: "button",
          dataCitation: JSON.stringify(citation.key),
          ariaLabel: `Show reference: ${entry.text.slice(0, 80)}`,
        },
      },
    ];
  });
}

function decorateText(
  text: string,
  bibliography: Bibliography | null,
): HastNode[] | null {
  const all = [
    ...refDecorations(text),
    ...(bibliography ? citationDecorations(text, bibliography) : []),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  if (all.length === 0) return null;

  const nodes: HastNode[] = [];
  let cursor = 0;
  for (const decoration of all) {
    if (decoration.start < cursor) continue;
    if (decoration.start > cursor) {
      nodes.push({ type: "text", value: text.slice(cursor, decoration.start) });
    }
    nodes.push({
      type: "element",
      tagName: "button",
      properties: decoration.properties,
      children: [
        { type: "text", value: text.slice(decoration.start, decoration.end) },
      ],
    });
    cursor = decoration.end;
  }
  if (cursor < text.length) {
    nodes.push({ type: "text", value: text.slice(cursor) });
  }
  return nodes;
}

function walk(node: HastNode, bibliography: Bibliography | null): void {
  const children = node.children;
  if (!children) return;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type === "element") {
      if (!skippedElement(child)) walk(child, bibliography);
      continue;
    }
    if (child.type !== "text" || typeof child.value !== "string") continue;
    const replacement = decorateText(child.value, bibliography);
    if (replacement) children.splice(index, 1, ...replacement);
  }
}

/**
 * Plugin factory for react-markdown's rehypePlugins:
 * `[rehypePaperRefs, { bibliography }]`.
 */
export function rehypePaperRefs(options?: {
  bibliography?: Bibliography | null;
}): (tree: HastNode) => void {
  const bibliography = options?.bibliography ?? null;
  return (tree) => walk(tree, bibliography);
}
