import { allIndexed, type IndexedPaper } from "../index-db";

/**
 * Resolve a bibliography entry's text to a confirmed paper in the library.
 * Conservative on purpose: a wrong "in your library" link is worse than
 * none, so a candidate only matches when most of its title's substantive
 * words literally appear in the reference string.
 */

export function significantWords(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
    (word) => !["the", "and", "for", "with", "via", "from"].includes(word),
  );
}

/** The tokenized text of ONE reference entry, built once and tested against many titles. */
export interface ReferenceTokens {
  words: Set<string>;
  /** Significant words in reading order, space-delimited on both ends, for phrase matching. */
  phrase: string;
}

export function tokenizeReference(text: string): ReferenceTokens {
  const words = significantWords(text);
  return { words: new Set(words), phrase: ` ${words.join(" ")} ` };
}

/** The tokenized title of ONE paper, built once and tested against many entries. */
export interface TitleTokens {
  words: string[];
  /** Significant words in reading order, space-delimited on both ends. */
  phrase: string;
}

export function tokenizeTitle(title: string): TitleTokens {
  const words = significantWords(title);
  return { words, phrase: ` ${words.join(" ")} ` };
}

/**
 * True when at least 80% of the title's significant words appear anywhere
 * in the reference entry. Titles with fewer than two significant words
 * never match: a single common word is not evidence of a citation.
 */
export function titleOverlaps(
  tokens: ReferenceTokens,
  title: TitleTokens,
): boolean {
  if (title.words.length < 2) return false;
  const present = title.words.filter((word) => tokens.words.has(word));
  return present.length / title.words.length >= 0.8;
}

/** Titles this short are only evidence as an exact ordered phrase, not as a bag of words. */
const PHRASE_ONLY_BELOW = 4;

/**
 * The stricter rule the library graph draws `cites` edges with: a title of
 * fewer than four significant words must occur as the exact ordered phrase
 * ("Deep Learning" would otherwise match every entry about deep learning);
 * longer titles fall back to the overlap rule.
 */
export function titleCited(
  tokens: ReferenceTokens,
  title: TitleTokens,
): boolean {
  if (title.words.length < 2) return false;
  if (title.words.length < PHRASE_ONLY_BELOW) {
    return tokens.phrase.includes(title.phrase);
  }
  return titleOverlaps(tokens, title);
}

export function referenceMentionsTitle(
  reference: string,
  title: string,
): boolean {
  return titleOverlaps(tokenizeReference(reference), tokenizeTitle(title));
}

export function findPaperByReference(reference: string): IndexedPaper | null {
  // Full scan on purpose: a citation string contains author names and venues
  // that defeat FTS AND-matching, and a personal library is small. Precision
  // comes from the title-overlap threshold, not the candidate source.
  const tokens = tokenizeReference(reference);
  for (const candidate of allIndexed()) {
    if (candidate.topic === null) continue; // never link unconfirmed captures
    if (titleOverlaps(tokens, tokenizeTitle(candidate.title))) return candidate;
  }
  return null;
}
