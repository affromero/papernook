import { rebuildIndex, searchIndex, type IndexedPaper } from "../index-db";
import { listPapers, type Paper } from "../papers";

export interface LibraryFilters {
  query: string;
  tag: string | null;
  topic: string | null;
}

export function matchesLibraryFilters(
  paper: IndexedPaper,
  filters: Omit<LibraryFilters, "query">,
): boolean {
  if (filters.tag && !paper.tags.includes(filters.tag)) return false;
  if (filters.topic === "_inbox") return paper.topic === null;
  if (filters.topic && paper.topic !== filters.topic) return false;
  return true;
}

/**
 * Apply the same FTS/topic/tag semantics as LibraryView, then reconcile those
 * identities against confirmed filesystem papers. SQLite selects; disk wins.
 */
export function confirmedPapersForFilters(filters: LibraryFilters): Paper[] {
  if (filters.topic === "_inbox") return [];
  rebuildIndex();
  const matching = new Set(
    searchIndex(filters.query)
      .filter((paper) => matchesLibraryFilters(paper, filters))
      .filter((paper) => paper.topic !== null)
      .map((paper) => `${paper.topic}/${paper.slug}`),
  );
  return listPapers().filter((paper) =>
    matching.has(`${paper.topic}/${paper.slug}`),
  );
}
