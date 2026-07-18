import { listPapers } from "./papers";

/**
 * The library as a graph: papers connect to their authors, topic, and tags,
 * plus direct paper-to-paper edges from the AI's related[] cross-links.
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
  kind: "authored" | "filed" | "tagged" | "related";
}

export interface LibraryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
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

  return { nodes: [...nodes.values()], edges };
}
