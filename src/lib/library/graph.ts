import fs from "node:fs";
import {
  companionDir,
  listPapers,
  readText,
  textPath,
  type Paper,
} from "./papers";
import { bibliographyPath, readBibliography } from "./bibliography/store";
import {
  titleCited,
  tokenizeReference,
  tokenizeTitle,
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
 * Bounds on what one paper contributes: the graph is built synchronously
 * per request over every paper, and any signed-in user can capture an
 * arbitrary PDF, so the text after a "References" heading must never be
 * allowed to turn into a hundred thousand windows held in memory and
 * scanned against every title. Real reference lists are a few hundred
 * entries in well under 200k characters.
 */
export const MAX_BIBLIOGRAPHY_CHARS = 200_000;
export const MAX_BIBLIOGRAPHY_ENTRIES = 2_000;

/**
 * Split a bibliography into its entries so a title must occur within ONE
 * entry, not scattered across the whole list. Entries are separated by blank
 * lines or by a `[12]` / `12.` marker starting a line (pdftotext keeps line
 * breaks). A marker-less chunk longer than a single wrapped entry (an
 * author-year list between two page breaks) is replaced by windows of a few
 * consecutive lines so a wrapped title still lands in one chunk while words
 * from different entries do not. Stops after MAX_BIBLIOGRAPHY_ENTRIES.
 */
export function bibliographyEntries(refText: string): string[] {
  const entries: string[] = [];
  for (const raw of refText
    .slice(0, MAX_BIBLIOGRAPHY_CHARS)
    .split(ENTRY_BOUNDARY)) {
    const entry = raw.trim();
    if (!entry) continue;
    const room = MAX_BIBLIOGRAPHY_ENTRIES - entries.length;
    if (room <= 0) break;
    const chunk = ENTRY_MARKER.test(entry) ? [entry] : lineWindows(entry, room);
    entries.push(...chunk);
  }
  return entries;
}

function lineWindows(chunk: string, limit: number): string[] {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= WINDOW_LINES) return [lines.join(" ")];
  const windows: string[] = [];
  for (
    let i = 0;
    i + WINDOW_LINES <= lines.length && windows.length < limit;
    i++
  ) {
    windows.push(lines.slice(i, i + WINDOW_LINES).join(" "));
  }
  return windows;
}

/**
 * Tokenized bibliography per paper, keyed by companion dir and invalidated
 * by the mtime and size of BOTH sources — the reader-scanned
 * bibliography.json (preferred: real parsed entries) and text.txt (the
 * heuristic fallback) — so writing either one refreshes the cache. The
 * graph route rebuilds per request, and re-reading every paper's full text
 * each time would let one signed-in profile keep the event loop busy with
 * disk reads.
 */
const bibliographyCache = new Map<
  string,
  { stamp: string; entries: ReferenceTokens[] }
>();

function statStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function bibliographyTokens(paper: Paper): ReferenceTokens[] {
  const key = companionDir(paper.topic, paper.slug);
  const bibStamp = statStamp(bibliographyPath(paper.topic, paper.slug));
  const textStamp = statStamp(textPath(paper.topic, paper.slug));
  if (bibStamp === "missing" && textStamp === "missing") {
    bibliographyCache.delete(key);
    return [];
  }
  const stamp = `bib:${bibStamp}|text:${textStamp}`;
  const cached = bibliographyCache.get(key);
  if (cached && cached.stamp === stamp) return cached.entries;
  // A corrupt or invalid bibliography.json reads as null and falls through
  // to the text heuristic rather than blanking the paper's edges.
  const scanned =
    bibStamp === "missing"
      ? null
      : readBibliography(paper.topic, paper.slug)?.entries.map((entry) =>
          tokenizeReference(entry.text),
        );
  const entries =
    scanned ??
    bibliographyEntries(
      bibliographyText(readText(paper.topic, paper.slug) ?? ""),
    ).map(tokenizeReference);
  bibliographyCache.set(key, { stamp, entries });
  return entries;
}

function citationEdges(papers: Paper[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const live = new Set<string>();
  const titles = papers.map((paper) => tokenizeTitle(paper.meta.title));
  // ponytail: O(n²) title scan over a personal library; index bibliography
  // text in SQLite if libraries pass ~1k papers.
  for (const paper of papers) {
    live.add(companionDir(paper.topic, paper.slug));
    const entries = bibliographyTokens(paper);
    if (entries.length === 0) continue;
    papers.forEach((other, index) => {
      if (other.slug === paper.slug) return;
      const title = titles[index];
      if (entries.some((tokens) => titleCited(tokens, title))) {
        edges.push({
          source: `paper:${paper.slug}`,
          target: `paper:${other.slug}`,
          kind: "cites",
        });
      }
    });
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
