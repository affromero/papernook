import { allIndexed, type IndexedPaper } from "../index-db";

/**
 * Resolve a bibliography entry's text to a confirmed paper in the library.
 * Conservative on purpose: a wrong "in your library" link is worse than
 * none, so a candidate only matches when most of its title's substantive
 * words literally appear in the reference string.
 */

function significantWords(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
    (word) => !["the", "and", "for", "with", "via", "from"].includes(word),
  );
}

export function findPaperByReference(reference: string): IndexedPaper | null {
  const referenceWords = new Set(significantWords(reference));
  if (referenceWords.size === 0) return null;
  // Full scan on purpose: a citation string contains author names and venues
  // that defeat FTS AND-matching, and a personal library is small. Precision
  // comes from the title-overlap threshold, not the candidate source.
  for (const candidate of allIndexed()) {
    if (candidate.topic === null) continue; // never link unconfirmed captures
    const titleWords = significantWords(candidate.title);
    if (titleWords.length < 2) continue;
    const present = titleWords.filter((word) => referenceWords.has(word));
    if (present.length / titleWords.length >= 0.8) return candidate;
  }
  return null;
}
