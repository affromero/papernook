import { searchIndex, type IndexedPaper } from "../index-db";
import { isPaperVisibleToProfile } from "../citations/filters";
import type { Paper } from "../papers";

/**
 * Library context for a chat turn: the papers most related to the one being
 * read and to the current question, so the assistant can point across the
 * library. Only confirmed papers (or the asking profile's own inbox
 * captures) ever appear — unconfirmed captures stay private.
 */

export function relatedLibraryContext(
  paper: Paper,
  question: string,
  username: string | undefined,
  budgetChars = 4_000,
): string {
  const visible = (candidate: IndexedPaper): boolean =>
    candidate.slug !== paper.slug &&
    (username
      ? isPaperVisibleToProfile(candidate, username)
      : candidate.topic !== null);

  const seen = new Set<string>();
  const picks: IndexedPaper[] = [];
  const add = (candidate: IndexedPaper | undefined) => {
    if (!candidate || seen.has(candidate.slug) || !visible(candidate)) return;
    seen.add(candidate.slug);
    picks.push(candidate);
  };

  const hits = searchIndex(question);
  const bySlug = new Map(hits.map((hit) => [hit.slug, hit]));
  for (const slug of paper.meta.related) add(bySlug.get(slug));
  // Related-by-metadata first even without a query hit.
  if (paper.meta.related.length > 0) {
    for (const hit of searchIndex(paper.meta.related.join(" "))) {
      if (paper.meta.related.includes(hit.slug)) add(hit);
    }
  }
  for (const hit of hits) add(hit);

  const lines: string[] = [];
  let budget = budgetChars;
  for (const pick of picks) {
    const line = `- ${pick.title} (${pick.topic}/${pick.slug})${
      pick.summarySnippet ? ` — ${pick.summarySnippet}` : ""
    }`;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length;
  }
  if (lines.length === 0) return "";
  return [
    "Other papers in this library (may be relevant; cite them by title and",
    "say when a question is better answered by one of them):",
    ...lines,
  ].join("\n");
}
