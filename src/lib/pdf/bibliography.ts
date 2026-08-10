/**
 * Bibliography reconstruction from PDF text geometry, and the citation →
 * entry resolver that gates citations.ts's permissive pattern matches.
 *
 * Layout facts this leans on (verified against real papers):
 * - Two-column layouts interleave y coordinates across columns, so lines
 *   must be clustered per column before anything else.
 * - Author-year styles (AAAI) may have NO hanging indent; entry boundaries
 *   show up as a slightly larger vertical gap plus a "Surname, I." head.
 * - Entries wrap across columns and pages mid-author-list, and the year can
 *   sit on any line of the entry, so parsing works on joined entry text.
 * - Printed author-year bibliographies carry natbib disambiguation
 *   suffixes ("2025a", "2025b") that citations reference.
 */

import { NAME_PATTERN, type CitationKey } from "./citations";

export interface PdfTextChunk {
  str: string;
  x: number;
  y: number;
  width?: number;
}

export interface BibliographyPage {
  pageNumber: number;
  pageWidth: number;
  chunks: PdfTextChunk[];
}

export interface BibEntry {
  pageNumber: number;
  /** PDF coordinates of the entry's first line (origin bottom-left). */
  x: number;
  y: number;
  text: string;
  surname: string | null;
  year: string | null;
  suffix: string | null;
  number: number | null;
}

export interface Bibliography {
  style: "numbered" | "author-year";
  entries: BibEntry[];
}

export interface TextLine {
  x: number;
  y: number;
  text: string;
  pageNumber: number;
  /** Index of the line's column on its page (left to right). */
  column: number;
}

const X_TOLERANCE = 3;
/** A text column spans at most this fraction of the page width. */
export const COLUMN_WIDTH_FACTOR = 0.55;
/**
 * Stored-entry-text bound. Generous because parsing must see past giant
 * author lists (the Wan 2025 entry's list alone exceeds 400 chars); callers
 * with tighter limits (the citations/match API caps q at 400) slice
 * themselves.
 */
const ENTRY_TEXT_CAP = 1000;
const NUMBERED_MARKER = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})\.)\s/;
const HEADING = /^(references|bibliography)\s*[.:]?\s*$/i;
const ENTRY_HEAD = new RegExp(`^(?:${NAME_PATTERN})[,.]\\s`, "u");
const YEAR_IN_TEXT = /(?:^|[\s([])((?:19|20)\d{2})([a-z])?(?![\p{L}\d])/u;
const SURNAME_BEFORE_SEPARATOR = new RegExp(`(${NAME_PATTERN})(?=[,.])`, "gu");

interface Cluster {
  value: number;
  count: number;
}

/** Greedy 1-D clustering of sorted values within a tolerance. */
function clusterValues(values: number[], tolerance: number): Cluster[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: Cluster[] = [];
  for (const value of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && value - current.value <= tolerance) {
      current.count += 1;
    } else {
      clusters.push({ value, count: 1 });
    }
  }
  return clusters;
}

/**
 * Column base x positions for a page: frequent line-start clusters, merged
 * unless separated by a real gutter. Every page has at least one column.
 */
function columnBases(chunks: PdfTextChunk[], pageWidth: number): number[] {
  const clusters = clusterValues(
    chunks.map((chunk) => chunk.x),
    X_TOLERANCE,
  ).filter((cluster) => cluster.count >= 3);
  if (clusters.length === 0) {
    return [Math.min(...chunks.map((chunk) => chunk.x), 0)];
  }
  const byCount = [...clusters].sort((a, b) => b.count - a.count);
  const gutter = pageWidth * 0.3;
  const representatives: number[] = [];
  for (const cluster of byCount) {
    if (
      representatives.every((base) => Math.abs(base - cluster.value) >= gutter)
    ) {
      representatives.push(cluster.value);
    }
  }
  representatives.sort((a, b) => a - b);
  // Indented sub-clusters merge into their column; the base is the column's
  // leftmost frequent x, not its most frequent one.
  return representatives.map((base) => {
    const merged = clusters.filter(
      (cluster) =>
        Math.abs(cluster.value - base) < gutter &&
        representatives.every(
          (other) =>
            other === base ||
            Math.abs(cluster.value - base) <= Math.abs(cluster.value - other),
        ),
    );
    return Math.min(...merged.map((cluster) => cluster.value), base);
  });
}

function columnIndexFor(x: number, bases: number[]): number {
  let index = 0;
  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base !== undefined && x >= base - X_TOLERANCE) index = i;
  }
  return index;
}

/**
 * Reconstruct a page's lines in reading order: columns left to right, lines
 * top to bottom within each column.
 */
export function pageLines(page: BibliographyPage): TextLine[] {
  const bases = columnBases(page.chunks, page.pageWidth);
  const columns: PdfTextChunk[][] = bases.map(() => []);
  for (const chunk of page.chunks) {
    if (!chunk.str.trim()) continue;
    columns[columnIndexFor(chunk.x, bases)]?.push(chunk);
  }
  const lines: TextLine[] = [];
  columns.forEach((columnChunks, column) => {
    const byY = [...columnChunks].sort((a, b) => b.y - a.y || a.x - b.x);
    let currentLine: TextLine | null = null;
    let chunksInLine: PdfTextChunk[] = [];
    const flush = () => {
      if (!currentLine) return;
      chunksInLine.sort((a, b) => a.x - b.x);
      currentLine.text = chunksInLine
        .map((chunk) => chunk.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      currentLine.x = Math.min(...chunksInLine.map((chunk) => chunk.x));
      if (currentLine.text) lines.push(currentLine);
      currentLine = null;
      chunksInLine = [];
    };
    for (const chunk of byY) {
      // Superscripts and subscripts sit within ~2.5 units of their line.
      if (!currentLine || currentLine.y - chunk.y > 2.5) {
        flush();
        currentLine = {
          x: chunk.x,
          y: chunk.y,
          text: "",
          pageNumber: page.pageNumber,
          column,
        };
      }
      chunksInLine.push(chunk);
    }
    flush();
  });
  return lines;
}

/** Vertical gap above which a line starts a new entry, per column. */
function gapThreshold(lines: TextLine[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const previous = lines[i - 1];
    const line = lines[i];
    if (!previous || !line || previous.column !== line.column) continue;
    if (previous.pageNumber !== line.pageNumber) continue;
    gaps.push(previous.y - line.y);
  }
  if (gaps.length < 3) return null;
  gaps.sort((a, b) => a - b);
  // The lower quartile estimates the plain line pitch even when short
  // entries make paragraph gaps as common as line gaps (a median would
  // flip); entry gaps only exceed the pitch by ~15-20%, so the margin is
  // deliberately tight.
  const pitch = gaps[Math.floor(gaps.length / 4)];
  if (pitch === undefined || pitch <= 0) return null;
  return pitch + Math.max(1.5, pitch * 0.12);
}

/** A column has a hanging indent if line starts are bimodal by ~an em. */
function hasHangingIndent(lines: TextLine[]): boolean {
  if (lines.length < 4) return false;
  const clusters = clusterValues(
    lines.map((line) => line.x),
    X_TOLERANCE,
  ).filter((cluster) => cluster.count >= 2);
  if (clusters.length < 2) return false;
  const [base, indent] = clusters;
  if (!base || !indent) return false;
  const distance = indent.value - base.value;
  const smaller = Math.min(base.count, indent.count);
  return distance >= 4 && distance <= 40 && smaller >= lines.length * 0.2;
}

interface ColumnTraits {
  threshold: number | null;
  indented: boolean;
  base: number;
}

function columnTraits(lines: TextLine[]): Map<string, ColumnTraits> {
  const traits = new Map<string, ColumnTraits>();
  const groups = new Map<string, TextLine[]>();
  for (const line of lines) {
    const key = `${line.pageNumber}:${line.column}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const [key, columnLines] of groups) {
    traits.set(key, {
      threshold: gapThreshold(columnLines),
      indented: hasHangingIndent(columnLines),
      base: Math.min(...columnLines.map((line) => line.x)),
    });
  }
  return traits;
}

export function detectStyle(lines: TextLine[]): "numbered" | "author-year" {
  const numbered = lines.filter((line) =>
    NUMBERED_MARKER.test(line.text),
  ).length;
  return numbered >= 3 ? "numbered" : "author-year";
}

/**
 * Split reference-section lines into entries. Returns the indexes of lines
 * that start a new entry.
 */
export function entryStartIndexes(
  lines: TextLine[],
  style: "numbered" | "author-year",
): number[] {
  const traits = columnTraits(lines);
  const starts: number[] = [];
  let accumulated = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const previous = lines[index - 1];
    const trait = traits.get(`${line.pageNumber}:${line.column}`);
    let isStart = false;
    if (index === 0) {
      isStart = true;
    } else if (style === "numbered") {
      isStart = NUMBERED_MARKER.test(line.text);
    } else if (trait?.indented) {
      isStart = line.x <= trait.base + X_TOLERANCE;
    } else {
      const newColumn =
        !previous ||
        previous.column !== line.column ||
        previous.pageNumber !== line.pageNumber;
      if (newColumn) {
        // A column-top line only starts an entry when the running entry is
        // already complete (has its year): the Wan-style giant author list
        // wraps across columns and its continuation lines look like heads.
        isStart = ENTRY_HEAD.test(line.text) && YEAR_IN_TEXT.test(accumulated);
      } else {
        const gap = previous.y - line.y;
        isStart =
          trait !== undefined &&
          trait.threshold !== null &&
          gap > trait.threshold &&
          ENTRY_HEAD.test(line.text);
      }
    }
    if (isStart) {
      starts.push(index);
      accumulated = "";
    }
    accumulated = `${accumulated} ${line.text}`;
  }
  return starts;
}

function parseEntry(lines: TextLine[], style: string): BibEntry | null {
  const first = lines[0];
  if (!first) return null;
  const text = lines
    .map((line) => line.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const marker = NUMBERED_MARKER.exec(text);
  const number = marker
    ? Number.parseInt(marker[1] ?? marker[2] ?? "", 10)
    : null;
  if (style === "numbered" && number === null) return null;
  const yearMatch = YEAR_IN_TEXT.exec(text);
  const year = yearMatch?.[1] ?? null;
  const suffix = yearMatch?.[2] ?? null;
  const head = yearMatch
    ? text.slice(0, text.indexOf(yearMatch[0]))
    : text.slice(0, 200);
  SURNAME_BEFORE_SEPARATOR.lastIndex = 0;
  const surname =
    SURNAME_BEFORE_SEPARATOR.exec(
      marker ? head.slice(marker[0].length) : head,
    )?.[1] ?? null;
  if (style === "author-year" && (!surname || !year)) return null;
  return {
    pageNumber: first.pageNumber,
    x: first.x,
    y: first.y,
    text: text.slice(0, ENTRY_TEXT_CAP),
    surname,
    year,
    suffix,
    number,
  };
}

/**
 * Build the bibliography index for a document. Returns null when no
 * References/Bibliography heading is found — recognition stays off rather
 * than guessing.
 */
export function buildBibliography(
  pages: BibliographyPage[],
): Bibliography | null {
  const lines = pages.flatMap((page) => pageLines(page));
  let headingIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    // The LAST heading wins: body prose can mention "References" but the
    // real section heading is the one entries actually follow.
    if (HEADING.test(lines[index]?.text ?? "")) headingIndex = index;
  }
  if (headingIndex < 0) return null;
  const sectionLines = lines.slice(headingIndex + 1);
  if (sectionLines.length === 0) return null;
  const style = detectStyle(sectionLines);
  const starts = entryStartIndexes(sectionLines, style);
  const entries: BibEntry[] = [];
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? sectionLines.length;
    const entry = parseEntry(sectionLines.slice(start, end), style);
    if (entry) entries.push(entry);
  });
  if (entries.length < 2) return null;
  return { style, entries };
}

/** Diacritic-, case-, spacing-, and particle-insensitive surname keys. */
function nameKeys(name: string): Set<string> {
  const flattened = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const full = flattened.replace(/[\s'’-]+/gu, "");
  const withoutParticles = flattened
    .replace(
      /^(?:(?:della|delle|del|den|der|des|de|dos|du|da|di|van|von|ten|ter|le|la|el|al)\s+)+/u,
      "",
    )
    .replace(/[\s'’-]+/gu, "");
  return new Set([full, withoutParticles]);
}

function surnameMatches(a: string, b: string): boolean {
  const keysA = nameKeys(a);
  return [...nameKeys(b)].some((key) => keysA.has(key));
}

/**
 * Resolve an inline citation against the bibliography. Null means the
 * "citation" is a look-alike (or ambiguous) and must not become a hotspot.
 */
export function matchCitation(
  bibliography: Bibliography,
  key: CitationKey,
): BibEntry | null {
  if (key.kind === "numeric") {
    if (bibliography.style !== "numbered") return null;
    return (
      bibliography.entries.find((entry) => entry.number === key.number) ?? null
    );
  }
  const candidates = bibliography.entries.filter(
    (entry) =>
      entry.year === key.year &&
      entry.surname !== null &&
      surnameMatches(entry.surname, key.surname),
  );
  const [first] = candidates;
  if (!first) return null;
  if (key.suffix) {
    return (
      candidates.find((entry) => entry.suffix === key.suffix) ??
      (candidates.length === 1 ? first : null)
    );
  }
  return candidates.length === 1 ? first : null;
}
