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
}

let db: Database.Database | null = null;

function connection(): Database.Database {
  if (db) return db;
  fs.mkdirSync(dataRoot(), { recursive: true });
  db = new Database(path.join(dataRoot(), "index.db"));
  db.pragma("journal_mode = WAL");
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
      summary_snippet TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
      slug UNINDEXED, title, authors, tags, summary, fulltext
    );
  `);
  return db;
}

/** Test hook: close and forget the connection (e.g. between temp dirs). */
export function closeIndex(): void {
  db?.close();
  db = null;
}

function indexOne(
  insertPaper: Database.Statement,
  insertFts: Database.Statement,
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
  );
  insertFts.run(
    paper.slug,
    paper.meta.title,
    paper.meta.authors.join(" "),
    paper.meta.tags.join(" "),
    paper.summary ?? "",
    readText(paper.topic, paper.slug) ?? "",
  );
}

/** Full rebuild from disk. Cheap at personal-library scale. */
export function rebuildIndex(): void {
  const conn = connection();
  const insertPaper = conn.prepare(
    "INSERT INTO papers (slug, topic, title, authors, year, tags, added_by, added_at, summary_snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = conn.prepare(
    "INSERT INTO papers_fts (slug, title, authors, tags, summary, fulltext) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const rebuild = conn.transaction(() => {
    conn.exec("DELETE FROM papers; DELETE FROM papers_fts;");
    for (const paper of listPapers()) indexOne(insertPaper, insertFts, paper);
    for (const paper of listInbox()) indexOne(insertPaper, insertFts, paper);
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

export function allTags(): string[] {
  const tags = new Set<string>();
  for (const paper of allIndexed()) {
    for (const tag of paper.tags) tags.add(tag);
  }
  return [...tags].sort();
}
