import { listPapers, type Paper } from "./papers";
import {
  paperBibliographyEntries,
  prunePaperBibliographyCache,
} from "./bibliography/entries";
import { titleCited, tokenizeTitle } from "./context/reference-match";

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

function citationEdges(papers: Paper[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const titles = papers.map((paper) => tokenizeTitle(paper.meta.title));
  // ponytail: O(n²) title scan over a personal library; index bibliography
  // text in SQLite if libraries pass ~1k papers.
  for (const paper of papers) {
    // Cached against both source files' stamps in bibliography/entries.ts;
    // a corrupt bibliography.json falls through to the text heuristic there.
    const entries = paperBibliographyEntries(paper);
    if (entries.length === 0) continue;
    papers.forEach((other, index) => {
      if (other.slug === paper.slug) return;
      const title = titles[index];
      if (entries.some((entry) => titleCited(entry.tokens, title))) {
        edges.push({
          source: `paper:${paper.slug}`,
          target: `paper:${other.slug}`,
          kind: "cites",
        });
      }
    });
  }
  prunePaperBibliographyCache(papers);
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
