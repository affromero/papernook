import fs from "node:fs";
import { listPapers, readText, textPath, type Paper } from "./papers";
import {
  tokenizeReference,
  titleWordsIn,
  type ReferenceTokens,
} from "./context/reference-match";

/**
 * The library as a graph: papers connect to their authors, topic, and tags,
 * plus direct paper-to-paper edges from the AI's related[] cross-links and
 * from one paper's bibliography naming another's title.
 * Built fresh from disk on request; personal-library scale makes that cheap.
 */

export interface GraphNode {
  id: string;
  label: string;
  kind: "paper" | "author" | "topic" | "tag";
  /** Papers only: for navigation. */
  href?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** `cites` is directed: source's bibliography names target's title. */
  kind: "authored" | "filed" | "tagged" | "related" | "cites";
}

export interface LibraryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const BIBLIOGRAPHY_HEADING =
  /^[ \t]*(?:\d+\.?\s*)?(references|bibliography)\s*$/gim;

/**
 * The part of a paper's extracted text that lists its references: everything
 * after the first "References"/"Bibliography" heading in the second half of
 * the text (a running page header or an appendix's own list repeats the
 * heading later; an early mention in a table of contents comes before), else
 * after the last heading, else the last 15% of the text when no heading
 * survived extraction.
 */
export function bibliographyText(text: string): string {
  const midpoint = text.length / 2;
  let last = -1;
  for (const match of text.matchAll(BIBLIOGRAPHY_HEADING)) {
    const end = match.index + match[0].length;
    if (match.index >= midpoint) return text.slice(end);
    last = end;
  }
  if (last >= 0) return text.slice(last);
  return text.slice(Math.floor(text.length * 0.85));
}

const ENTRY_MARKER = /^\s*(?:\[\d+\]|\d{1,3}\.)\s/;
const ENTRY_BOUNDARY = /\n\s*\n|\n(?=\s*(?:\[\d+\]|\d{1,3}\.)\s)/;
const WINDOW_LINES = 3;

/**
 * Split a bibliography into its entries so a title must occur within ONE
 * entry, not scattered across the whole list. Entries are separated by blank
 * lines or by a `[12]` / `12.` marker starting a line (pdftotext keeps line
 * breaks). A marker-less chunk longer than a single wrapped entry (an
 * author-year list between two page breaks) is replaced by windows of a few
 * consecutive lines so a wrapped title still lands in one chunk while words
 * from different entries do not.
 */
export function bibliographyEntries(refText: string): string[] {
  return refText
    .split(ENTRY_BOUNDARY)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) =>
      ENTRY_MARKER.test(entry) ? [entry] : lineWindows(entry),
    );
}

function lineWindows(chunk: string): string[] {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= WINDOW_LINES) return [lines.join(" ")];
  const windows: string[] = [];
  for (let i = 0; i + WINDOW_LINES <= lines.length; i++) {
    windows.push(lines.slice(i, i + WINDOW_LINES).join(" "));
  }
  return windows;
}

/**
 * Tokenized bibliography per paper, keyed by text.txt path and invalidated
 * by its mtime and size: the graph route rebuilds per request, and re-reading every
 * paper's full text each time would let one signed-in profile keep the
 * event loop busy with disk reads.
 */
const bibliographyCache = new Map<
  string,
  { stamp: string; entries: ReferenceTokens[] }
>();

function bibliographyTokens(paper: Paper): ReferenceTokens[] {
  const file = textPath(paper.topic, paper.slug);
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    bibliographyCache.delete(file);
    return [];
  }
  const cached = bibliographyCache.get(file);
  if (cached && cached.stamp === stamp) return cached.entries;
  const text = readText(paper.topic, paper.slug) ?? "";
  const entries = bibliographyEntries(bibliographyText(text)).map(
    tokenizeReference,
  );
  bibliographyCache.set(file, { stamp, entries });
  return entries;
}

function citationEdges(papers: Paper[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const live = new Set<string>();
  // ponytail: O(n²) title scan over a personal library; index bibliography
  // text in SQLite if libraries pass ~1k papers.
  for (const paper of papers) {
    live.add(textPath(paper.topic, paper.slug));
    const entries = bibliographyTokens(paper);
    if (entries.length === 0) continue;
    for (const other of papers) {
      if (other.slug === paper.slug) continue;
      if (entries.some((tokens) => titleWordsIn(tokens, other.meta.title))) {
        edges.push({
          source: `paper:${paper.slug}`,
          target: `paper:${other.slug}`,
          kind: "cites",
        });
      }
    }
  }
  for (const key of bibliographyCache.keys()) {
    if (!live.has(key)) bibliographyCache.delete(key);
  }
  return edges;
}

export function buildLibraryGraph(): LibraryGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const papers = listPapers();
  const paperIds = new Set(papers.map((p) => `paper:${p.slug}`));

  for (const paper of papers) {
    const paperId = `paper:${paper.slug}`;
    nodes.set(paperId, {
      id: paperId,
      label: paper.meta.title,
      kind: "paper",
      href: `/paper/${paper.topic}/${paper.slug}`,
    });

    if (paper.topic) {
      const topicId = `topic:${paper.topic}`;
      nodes.set(topicId, { id: topicId, label: paper.topic, kind: "topic" });
      edges.push({ source: paperId, target: topicId, kind: "filed" });
    }

    for (const author of paper.meta.authors) {
      const clean = author.trim();
      if (!clean) continue;
      const authorId = `author:${clean.toLowerCase()}`;
      nodes.set(authorId, { id: authorId, label: clean, kind: "author" });
      edges.push({ source: paperId, target: authorId, kind: "authored" });
    }

    for (const tag of paper.meta.tags) {
      const tagId = `tag:${tag}`;
      nodes.set(tagId, { id: tagId, label: tag, kind: "tag" });
      edges.push({ source: paperId, target: tagId, kind: "tagged" });
    }

    for (const related of paper.meta.related) {
      const targetId = `paper:${related}`;
      if (paperIds.has(targetId) && targetId !== paperId) {
        edges.push({ source: paperId, target: targetId, kind: "related" });
      }
    }
  }

  edges.push(...citationEdges(papers));

  return { nodes: [...nodes.values()], edges };
}
