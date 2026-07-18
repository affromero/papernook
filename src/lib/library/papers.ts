import fs from "node:fs";
import path from "node:path";
import { papersRoot, libraryRoot, inboxRoot } from "../data-dir";
import { assertSlug, isValidSlug } from "./slug";

/**
 * Paper CRUD over the two trees. The filesystem is the source of truth:
 *   data/papers/<topic>/<slug>.pdf              annotated artifact (WebDAV)
 *   data/papers/<topic>/<slug>.exercises.pdf    rendered exercises (WebDAV)
 *   data/library/<topic>/<slug>/                companion (meta, chats, …)
 *   data/library/_inbox/<slug>/                 awaiting confirmation
 * Inbox papers keep their PDF inside the companion folder until accepted so
 * unconfirmed captures never appear over WebDAV.
 */

export interface PaperMeta {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  arxivId: string | null;
  bibtex: string | null;
  tags: string[];
  /** Slugs of related papers already in the library. */
  related: string[];
  sourceUrl: string;
  addedAt: string;
  /** Username of the profile whose capture token added it. */
  addedBy: string;
}

export interface Paper {
  slug: string;
  /** Topic folder slug; null while in the inbox. */
  topic: string | null;
  meta: PaperMeta;
  pdfPath: string;
  companionDir: string;
  summary: string | null;
}

const META_FILE = "meta.json";
const SUMMARY_FILE = "summary.md";
const TEXT_FILE = "text.txt";
const INBOX_PDF = "paper.pdf";

export function companionDir(topic: string | null, slug: string): string {
  assertSlug(slug);
  if (topic === null) return path.join(inboxRoot(), slug);
  assertSlug(topic);
  return path.join(libraryRoot(), topic, slug);
}

export function pdfPath(topic: string | null, slug: string): string {
  assertSlug(slug);
  if (topic === null) return path.join(inboxRoot(), slug, INBOX_PDF);
  assertSlug(topic);
  return path.join(papersRoot(), topic, `${slug}.pdf`);
}

export function exercisesPdfPath(topic: string, slug: string): string {
  assertSlug(topic);
  assertSlug(slug);
  return path.join(papersRoot(), topic, `${slug}.exercises.pdf`);
}

export function readMeta(topic: string | null, slug: string): PaperMeta | null {
  try {
    const raw = fs.readFileSync(
      path.join(companionDir(topic, slug), META_FILE),
      "utf8",
    );
    return JSON.parse(raw) as PaperMeta;
  } catch {
    return null;
  }
}

export function writeMeta(
  topic: string | null,
  slug: string,
  meta: PaperMeta,
): void {
  const dir = companionDir(topic, slug);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.meta.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, path.join(dir, META_FILE));
}

export function readSummary(topic: string | null, slug: string): string | null {
  try {
    return fs.readFileSync(
      path.join(companionDir(topic, slug), SUMMARY_FILE),
      "utf8",
    );
  } catch {
    return null;
  }
}

export function writeSummary(
  topic: string | null,
  slug: string,
  summary: string,
): void {
  const dir = companionDir(topic, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SUMMARY_FILE), summary);
}

export function readText(topic: string | null, slug: string): string | null {
  try {
    return fs.readFileSync(
      path.join(companionDir(topic, slug), TEXT_FILE),
      "utf8",
    );
  } catch {
    return null;
  }
}

export function writeText(
  topic: string | null,
  slug: string,
  text: string,
): void {
  const dir = companionDir(topic, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, TEXT_FILE), text);
}

function loadPaper(topic: string | null, slug: string): Paper | null {
  const meta = readMeta(topic, slug);
  if (!meta) return null;
  const pdf = pdfPath(topic, slug);
  if (!fs.existsSync(pdf)) return null;
  return {
    slug,
    topic,
    meta,
    pdfPath: pdf,
    companionDir: companionDir(topic, slug),
    summary: readSummary(topic, slug),
  };
}

/** Topic folders present in the library (from the papers tree). */
export function listTopics(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(papersRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isValidSlug(e.name))
    .map((e) => e.name)
    .sort();
}

/** All confirmed papers, discovered from the library tree. */
export function listPapers(): Paper[] {
  const papers: Paper[] = [];
  let topics: fs.Dirent[];
  try {
    topics = fs.readdirSync(libraryRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const topicEntry of topics) {
    if (!topicEntry.isDirectory() || topicEntry.name === "_inbox") continue;
    if (!isValidSlug(topicEntry.name)) continue;
    const topicDir = path.join(libraryRoot(), topicEntry.name);
    for (const entry of fs.readdirSync(topicDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
      const paper = loadPaper(topicEntry.name, entry.name);
      if (paper) papers.push(paper);
    }
  }
  return papers;
}

/** Captures awaiting confirmation. */
export function listInbox(): Paper[] {
  const papers: Paper[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(inboxRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
    const paper = loadPaper(null, entry.name);
    if (paper) papers.push(paper);
  }
  return papers;
}

export function getPaper(topic: string | null, slug: string): Paper | null {
  if (!isValidSlug(slug) || (topic !== null && !isValidSlug(topic)))
    return null;
  return loadPaper(topic, slug);
}

/** A library-unique slug: appends -2, -3, … on collision anywhere. */
export function uniqueSlug(base: string): string {
  const taken = new Set<string>();
  for (const p of listPapers()) taken.add(p.slug);
  for (const p of listInbox()) taken.add(p.slug);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base.slice(0, 76)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Accept an inbox capture into a topic folder: moves the companion dir into
 * data/library/<topic>/ and the PDF into data/papers/<topic>/<slug>.pdf.
 */
export function acceptFromInbox(slug: string, topic: string): Paper {
  assertSlug(slug);
  assertSlug(topic);
  const fromDir = companionDir(null, slug);
  const fromPdf = pdfPath(null, slug);
  if (!fs.existsSync(fromDir) || !fs.existsSync(fromPdf)) {
    throw new Error(`No inbox capture named "${slug}".`);
  }
  const toDir = companionDir(topic, slug);
  const toPdf = pdfPath(topic, slug);
  fs.mkdirSync(path.dirname(toPdf), { recursive: true });
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  fs.renameSync(fromPdf, toPdf);
  fs.renameSync(fromDir, toDir);
  const paper = loadPaper(topic, slug);
  if (!paper) throw new Error(`Accept failed for "${slug}".`);
  return paper;
}
