import fs from "node:fs";
import { companionDir, readText, textPath, type Paper } from "../papers";
import { bibliographyPath, readBibliography } from "./store";
import {
  tokenizeReference,
  type ReferenceTokens,
} from "../context/reference-match";

/**
 * Where a paper's bibliography entries come from, in preference order: the
 * reader-scanned bibliography.json (real parsed entries) when present and
 * valid, else a text.txt heuristic that finds the reference section and
 * splits it into entries. The library graph and the reading list both build
 * on these entries through a shared per-paper cache, so neither path
 * re-reads a paper's full text or re-tokenizes its entries until one of the
 * source files changes on disk.
 */

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

/** One bibliography entry, tokenized once for every title-matching consumer. */
export interface BibliographyEntry {
  text: string;
  tokens: ReferenceTokens;
}

/**
 * Extracted entries per paper, keyed by companion dir and invalidated by the
 * mtime and size of BOTH sources — the reader-scanned bibliography.json
 * (preferred: real parsed entries) and text.txt (the heuristic fallback) —
 * so writing either one refreshes the cache. The graph and reading-list
 * routes rebuild per request, and re-reading every paper's full text each
 * time would let one signed-in profile keep the event loop busy with disk
 * reads.
 */
const entryCache = new Map<
  string,
  { stamp: string; entries: BibliographyEntry[] }
>();

function statStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

/**
 * A paper's bibliography entries, tokenized and cached against the source
 * files' stamps. The reader-scanned bibliography.json wins when present and
 * valid (a corrupt or invalid file reads as null and falls through), else
 * the text.txt heuristic. Empty when neither source exists.
 */
export function paperBibliographyEntries(paper: Paper): BibliographyEntry[] {
  const key = companionDir(paper.topic, paper.slug);
  const bibStamp = statStamp(bibliographyPath(paper.topic, paper.slug));
  const textStamp = statStamp(textPath(paper.topic, paper.slug));
  if (bibStamp === "missing" && textStamp === "missing") {
    entryCache.delete(key);
    return [];
  }
  const stamp = `bib:${bibStamp}|text:${textStamp}`;
  const cached = entryCache.get(key);
  if (cached && cached.stamp === stamp) return cached.entries;
  const entries = extractEntryTexts(paper).map((text) => ({
    text,
    tokens: tokenizeReference(text),
  }));
  entryCache.set(key, { stamp, entries });
  return entries;
}

/**
 * Drop cached entries for papers no longer in the library so deleted
 * companion dirs do not pin tokenized bibliographies forever. Callers pass
 * the full paper list they just walked.
 */
export function prunePaperBibliographyCache(papers: Paper[]): void {
  const live = new Set(
    papers.map((paper) => companionDir(paper.topic, paper.slug)),
  );
  for (const key of entryCache.keys()) {
    if (!live.has(key)) entryCache.delete(key);
  }
}

function extractEntryTexts(paper: Paper): string[] {
  const scanned = readBibliography(paper.topic, paper.slug);
  if (scanned) return scanned.entries.map((entry) => entry.text);
  return bibliographyEntries(
    bibliographyText(readText(paper.topic, paper.slug) ?? ""),
  );
}
