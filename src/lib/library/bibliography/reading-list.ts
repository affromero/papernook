import { listPapers } from "../papers";
import { titleCited, tokenizeTitle } from "../context/reference-match";
import { titleGuess } from "../context/reference-resolve";
import {
  paperBibliographyEntries,
  prunePaperBibliographyCache,
} from "./entries";

/**
 * Deterministic reading list: works the library's papers cite that are not
 * themselves in the library. No AI involved — this is pure text matching
 * over each paper's bibliography (reader-scanned when available, text
 * heuristic otherwise), so the Discover page can show it even when no agent
 * is configured. Same O(papers × entries × titles) cost profile as the
 * graph's citation edges, bounded by the shared extraction caps and served
 * from the same per-paper entry cache in entries.ts.
 */

export interface ReadingListCiter {
  topic: string;
  slug: string;
  title: string;
}

export interface ReadingListItem {
  /** Normalized dedupe key shared by every citing paper's entry for this work. */
  key: string;
  /** Best guess at the cited work's title, else the entry text truncated. */
  title: string;
  /** The bibliography entry text, for the citations/resolve lookup. */
  entryText: string;
  citedBy: ReadingListCiter[];
  count: number;
}

export const MAX_READING_LIST_ITEMS = 50;
/** Matches the resolve API's query cap; longer text adds nothing to a lookup. */
const MAX_ENTRY_TEXT = 400;
const FALLBACK_KEY_CHARS = 80;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fallbackTitle(entryText: string): string {
  const flat = entryText.replace(/\s+/g, " ").trim();
  return flat.length <= FALLBACK_KEY_CHARS
    ? flat
    : `${flat.slice(0, FALLBACK_KEY_CHARS - 1).trimEnd()}…`;
}

/**
 * Cited works missing from the library, deduped across citing papers by
 * normalized title guess (falling back to the entry's first characters),
 * most-cited first, capped at MAX_READING_LIST_ITEMS.
 */
export function buildReadingList(): ReadingListItem[] {
  const papers = listPapers();
  const titles = papers.map((paper) => tokenizeTitle(paper.meta.title));
  const items = new Map<string, ReadingListItem>();
  for (const paper of papers) {
    if (paper.topic === null) continue;
    const citer: ReadingListCiter = {
      topic: paper.topic,
      slug: paper.slug,
      title: paper.meta.title,
    };
    /** One vote per citing paper, however many windows repeat the entry. */
    const voted = new Set<string>();
    for (const entry of paperBibliographyEntries(paper)) {
      if (titles.some((title) => titleCited(entry.tokens, title))) continue;
      const guess = titleGuess(entry.text);
      const key = guess
        ? normalize(guess)
        : normalize(entry.text).slice(0, FALLBACK_KEY_CHARS).trim();
      if (!key || voted.has(key)) continue;
      voted.add(key);
      const existing = items.get(key);
      if (existing) {
        existing.citedBy.push(citer);
        existing.count += 1;
      } else {
        items.set(key, {
          key,
          title: guess ?? fallbackTitle(entry.text),
          entryText: entry.text.slice(0, MAX_ENTRY_TEXT),
          citedBy: [citer],
          count: 1,
        });
      }
    }
  }
  prunePaperBibliographyCache(papers);
  return [...items.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, MAX_READING_LIST_ITEMS);
}
