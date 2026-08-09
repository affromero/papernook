import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dataRoot } from "../data-dir";
import { listPapers, listInbox, readText, type Paper } from "./papers";

/**
 * Rebuildable SQLite index over the filesystem trees. Disk always wins: the
 * scanner triggers full rebuilds, and any query result is only as fresh as
 * the last rebuild. Deleting data/index.db is always safe.
 */

export interface IndexedPaper {
  slug: string;
  topic: string | null;
  title: string;
  authors: string;
  year: number | null;
  tags: string[];
  addedBy: string;
  addedAt: string;
  summarySnippet: string | null;
  needsReview: boolean;
}

let db: Database.Database | null = null;

function connection(): Database.Database {
  if (db) return db;
  fs.mkdirSync(dataRoot(), { recursive: true });
  db = new Database(path.join(dataRoot(), "index.db"));
  db.pragma("journal_mode = WAL");
  // The DB is a rebuildable cache: on any schema change, drop and let the
  // boot-time rebuild repopulate instead of migrating.
  const SCHEMA_VERSION = 3;
  if (db.pragma("user_version", { simple: true }) !== SCHEMA_VERSION) {
    db.exec(
      "DROP TABLE IF EXISTS papers; DROP TABLE IF EXISTS papers_fts; DROP TABLE IF EXISTS chunks_fts;",
    );
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      slug TEXT PRIMARY KEY,
      topic TEXT,
      title TEXT NOT NULL,
      authors TEXT NOT NULL,
      year INTEGER,
      tags TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      summary_snippet TEXT,
      needs_review INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
      slug UNINDEXED, title, authors, tags, summary, fulltext
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      slug UNINDEXED, ord UNINDEXED, start UNINDEXED, body
    );
  `);
  return db;
}

/** Test hook: close and forget the connection (e.g. between temp dirs). */
export function closeIndex(): void {
  db?.close();
  db = null;
}

/** Chunk target size; passages keep paragraph boundaries where possible. */
const CHUNK_CHARS = 1_200;

/**
 * Split extracted text into passages with their character offsets, merging
 * small paragraphs up to the target and hard-splitting oversized ones.
 */
export function chunkText(
  text: string,
): { ord: number; start: number; body: string }[] {
  const chunks: { ord: number; start: number; body: string }[] = [];
  let buffer = "";
  let bufferStart = 0;
  let cursor = 0;
  const flush = () => {
    const body = buffer.trim();
    if (body) chunks.push({ ord: chunks.length, start: bufferStart, body });
    buffer = "";
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    const start = text.indexOf(paragraph, cursor);
    cursor = start + paragraph.length;
    if (!buffer) bufferStart = start;
    if (buffer && buffer.length + paragraph.length > CHUNK_CHARS) {
      flush();
      bufferStart = start;
    }
    buffer += (buffer ? "\n\n" : "") + paragraph;
    while (buffer.length > CHUNK_CHARS * 2) {
      const head = buffer.slice(0, CHUNK_CHARS);
      chunks.push({
        ord: chunks.length,
        start: bufferStart,
        body: head.trim(),
      });
      bufferStart += head.length;
      buffer = buffer.slice(CHUNK_CHARS);
    }
  }
  flush();
  return chunks;
}

function indexOne(
  insertPaper: Database.Statement,
  insertFts: Database.Statement,
  insertChunk: Database.Statement,
  paper: Paper,
): void {
  const snippet =
    paper.summary?.split("\n").find((l) => l.trim().length > 0) ?? null;
  insertPaper.run(
    paper.slug,
    paper.topic,
    paper.meta.title,
    JSON.stringify(paper.meta.authors),
    paper.meta.year,
    JSON.stringify(paper.meta.tags),
    paper.meta.addedBy,
    paper.meta.addedAt,
    snippet,
    paper.meta.needsReview ? 1 : 0,
  );
  const text = readText(paper.topic, paper.slug) ?? "";
  insertFts.run(
    paper.slug,
    paper.meta.title,
    paper.meta.authors.join(" "),
    paper.meta.tags.join(" "),
    paper.summary ?? "",
    text,
  );
  for (const chunk of chunkText(text)) {
    insertChunk.run(paper.slug, chunk.ord, chunk.start, chunk.body);
  }
}

/** Full rebuild from disk. Cheap at personal-library scale. */
export function rebuildIndex(): void {
  const conn = connection();
  const insertPaper = conn.prepare(
    "INSERT INTO papers (slug, topic, title, authors, year, tags, added_by, added_at, summary_snippet, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = conn.prepare(
    "INSERT INTO papers_fts (slug, title, authors, tags, summary, fulltext) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertChunk = conn.prepare(
    "INSERT INTO chunks_fts (slug, ord, start, body) VALUES (?, ?, ?, ?)",
  );
  const rebuild = conn.transaction(() => {
    conn.exec(
      "DELETE FROM papers; DELETE FROM papers_fts; DELETE FROM chunks_fts;",
    );
    for (const paper of listPapers())
      indexOne(insertPaper, insertFts, insertChunk, paper);
    for (const paper of listInbox())
      indexOne(insertPaper, insertFts, insertChunk, paper);
  });
  rebuild();
}

interface PaperRow {
  slug: string;
  topic: string | null;
  title: string;
  authors: string;
  year: number | null;
  tags: string;
  added_by: string;
  added_at: string;
  summary_snippet: string | null;
  needs_review: number;
}

function rowToIndexed(row: PaperRow): IndexedPaper {
  return {
    slug: row.slug,
    topic: row.topic,
    title: row.title,
    authors: (JSON.parse(row.authors) as string[]).join(", "),
    year: row.year,
    tags: JSON.parse(row.tags) as string[],
    addedBy: row.added_by,
    addedAt: row.added_at,
    summarySnippet: row.summary_snippet,
    needsReview: row.needs_review === 1,
  };
}

export function allIndexed(): IndexedPaper[] {
  const rows = connection()
    .prepare("SELECT * FROM papers ORDER BY added_at DESC")
    .all() as PaperRow[];
  return rows.map(rowToIndexed);
}

/** FTS search across title/authors/tags/summary/fulltext. */
export function searchIndex(query: string): IndexedPaper[] {
  const trimmed = query.trim();
  if (!trimmed) return allIndexed();
  // Quote each term to keep FTS syntax characters from breaking the query.
  const ftsQuery = trimmed
    .split(/\s+/)
    .map((t) => `"${t.replaceAll('"', "")}"*`)
    .join(" ");
  const slugs = connection()
    .prepare(
      "SELECT slug FROM papers_fts WHERE papers_fts MATCH ? ORDER BY rank",
    )
    .all(ftsQuery) as { slug: string }[];
  if (slugs.length === 0) return [];
  const bySlug = new Map(allIndexed().map((p) => [p.slug, p]));
  return slugs
    .map((s) => bySlug.get(s.slug))
    .filter((p): p is IndexedPaper => Boolean(p));
}

/**
 * bm25-ranked passages from one paper's text; used to ground chat context
 * for papers too long to inject whole. Never throws on FTS syntax.
 */
export function searchChunks(
  slug: string,
  query: string,
  limit = 6,
): { ord: number; start: number; body: string }[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  // OR-joined (unlike searchIndex): a question rarely has every word in one
  // passage; bm25's rarity weighting then surfaces the substantive terms.
  const ftsQuery = trimmed
    .split(/\s+/)
    .map((t) => `"${t.replaceAll('"', "")}"*`)
    .filter((t) => t !== '""*')
    .join(" OR ");
  try {
    return connection()
      .prepare(
        "SELECT ord, start, body FROM chunks_fts WHERE chunks_fts MATCH ? AND slug = ? ORDER BY rank LIMIT ?",
      )
      .all(ftsQuery, slug, limit) as {
      ord: number;
      start: number;
      body: string;
    }[];
  } catch {
    return [];
  }
}

export function allTags(username?: string): string[] {
  const tags = new Set<string>();
  for (const paper of allIndexed()) {
    if (paper.topic === null && paper.addedBy !== username) continue;
    for (const tag of paper.tags) tags.add(tag);
  }
  return [...tags].sort();
}
