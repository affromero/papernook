import fs from "node:fs";
import path from "node:path";
import {
  papersRoot,
  libraryRoot,
  inboxRoot,
  ensureDataDirs,
} from "../data-dir";
import { assertSlug, isValidSlug } from "./slug";
import {
  readCaptureJob,
  removeCaptureJobDir,
  sweepCaptureJobs,
} from "../capture/jobs";

/**
 * Paper CRUD over the two trees. The filesystem is the source of truth:
 *   data/papers/<topic>/<slug>.pdf              annotated artifact (WebDAV)
 *   data/papers/<topic>/<slug>.exercises.pdf    rendered exercises (WebDAV)
 *   data/library/<topic>/<slug>/                companion (meta, chats, …)
 *   data/library/_inbox/<slug>/                 awaiting confirmation
 * Inbox papers keep their PDF inside the companion folder until accepted so
 * unconfirmed captures never appear over WebDAV.
 */

/** Provenance for papers imported by an integration sync. */
export interface PaperSource {
  provider: "zotero";
  /** Item key in the source library. */
  key: string;
  /** Source library version at import time. */
  version: number;
  /** Library-local identity; missing only on legacy personal imports. */
  libraryType?: "user" | "group";
  libraryId?: string;
  /** Stable Zotero collection keys and their current display names. */
  collectionKeys?: string[];
  /** Zotero collection names retained without forcing them into one topic. */
  collections?: string[];
  /** Last observed Zotero tags, so refresh can preserve local-only tags. */
  tags?: string[];
}

export const CITATION_TYPES = [
  "article",
  "article-journal",
  "book",
  "chapter",
  "dataset",
  "document",
  "manuscript",
  "paper-conference",
  "report",
  "thesis",
  "webpage",
] as const;

export type CitationType = (typeof CITATION_TYPES)[number];

export interface CitationAuthor {
  family?: string;
  given?: string;
  literal?: string;
}

/**
 * Canonical bibliographic metadata. When present it is authoritative for
 * exports; legacy `bibtex` is consulted only for older records without this.
 */
export interface CitationMeta {
  type: CitationType;
  authors: CitationAuthor[];
  DOI?: string;
  containerTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  publisherPlace?: string;
  abstract?: string;
  URL?: string;
  language?: string;
  ISBN?: string;
  ISSN?: string;
}

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
  /** Filing proposal from capture analysis; preselects the inbox confirm. */
  proposedTopic?: string;
  /** Set when an integration sync imported this paper. */
  source?: PaperSource;
  /** Auto-filed by a sync and awaiting user review. */
  needsReview?: boolean;
  citation?: CitationMeta;
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

export class CaptureOwnershipError extends Error {}

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

/**
 * Remove private inbox captures owned by a deleted profile and anonymize its
 * attribution on confirmed shared papers.
 */
export function anonymizePapersByUser(username: string): void {
  assertSlug(username);
  for (const paper of listInbox()) {
    if (paper.meta.addedBy === username) {
      fs.rmSync(paper.companionDir, { recursive: true, force: true });
    }
  }
  // Marker-only capture dirs (no meta.json) carry the username too.
  sweepCaptureJobs(username);
  for (const paper of listPapers()) {
    if (paper.meta.addedBy === username) {
      writeMeta(paper.topic, paper.slug, {
        ...paper.meta,
        addedBy: "deleted-profile",
      });
    }
  }
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
    entries = fs.readdirSync(papersRoot(), {
      withFileTypes: true,
    });
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
    topics = fs.readdirSync(libraryRoot(), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  for (const topicEntry of topics) {
    if (!topicEntry.isDirectory() || topicEntry.name === "_inbox") continue;
    if (!isValidSlug(topicEntry.name)) continue;
    const topicDir = path.join(libraryRoot(), topicEntry.name);
    for (const entry of fs.readdirSync(topicDir, {
      withFileTypes: true,
    })) {
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
    entries = fs.readdirSync(inboxRoot(), {
      withFileTypes: true,
    });
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

function canonicalSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

function unversionedArxivId(value: string | null | undefined): string | null {
  return value?.replace(/v\d+$/i, "") ?? null;
}

/** Find an existing confirmed or pending capture by stable source identity. */
export function findPaperBySource(
  sourceUrl: string,
  arxivId?: string | null,
  username?: string,
): Paper | null {
  const wantedArxiv = unversionedArxivId(arxivId);
  const wantedUrl = canonicalSourceUrl(sourceUrl);
  return (
    [...listPapers(), ...listInbox()].find((paper) => {
      if (paper.topic === null && paper.meta.addedBy !== username) return false;
      const paperArxiv = unversionedArxivId(paper.meta.arxivId);
      if (wantedArxiv && paperArxiv) return wantedArxiv === paperArxiv;
      return canonicalSourceUrl(paper.meta.sourceUrl) === wantedUrl;
    }) ?? null
  );
}

/** A library-unique slug: appends -2, -3, … on collision anywhere. */
export function uniqueSlug(base: string): string {
  const taken = new Set<string>();
  for (const p of listPapers()) taken.add(p.slug);
  for (const p of listInbox()) taken.add(p.slug);
  // In-flight async captures own their dir before meta.json exists —
  // loadPaper can't see them, so reserve every raw inbox dir name too.
  try {
    for (const entry of fs.readdirSync(inboxRoot(), { withFileTypes: true })) {
      if (entry.isDirectory()) taken.add(entry.name);
    }
  } catch {
    // No inbox yet — nothing reserved.
  }
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
  if (fs.existsSync(toDir) || fs.existsSync(toPdf)) {
    throw new Error(`A paper named "${slug}" already exists in "${topic}".`);
  }
  fs.mkdirSync(path.dirname(toPdf), { recursive: true });
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  // Async-capture status marker must not travel into the library.
  fs.rmSync(path.join(fromDir, "capture.json"), { force: true });
  // The WebDAV-visible PDF is the commit point. Until this final rename, an
  // interrupted acceptance cannot expose an unconfirmed capture.
  fs.renameSync(fromDir, toDir);
  try {
    fs.renameSync(path.join(toDir, INBOX_PDF), toPdf);
  } catch (error) {
    fs.renameSync(toDir, fromDir);
    throw error;
  }
  const paper = loadPaper(topic, slug);
  if (!paper) throw new Error(`Accept failed for "${slug}".`);
  return paper;
}

/**
 * Move a confirmed paper to another topic: atomic renames of the WebDAV
 * artifacts and the companion dir (same filesystem, so each rename is atomic).
 * The companion moves first and the primary PDF last, making the WebDAV rename
 * the commit point while recovery completes any interrupted move.
 */
export function movePaper(
  topic: string,
  slug: string,
  newTopic: string,
): Paper {
  assertSlug(topic);
  assertSlug(slug);
  assertSlug(newTopic);
  const existing = loadPaper(topic, slug);
  if (!existing) throw new Error(`No paper "${slug}" in topic "${topic}".`);
  if (newTopic === topic) return existing;
  const toPdf = pdfPath(newTopic, slug);
  const toDir = companionDir(newTopic, slug);
  if (fs.existsSync(toPdf) || fs.existsSync(toDir)) {
    throw new Error(
      `A paper named "${slug}" already exists in topic "${newTopic}".`,
    );
  }
  fs.mkdirSync(path.dirname(toPdf), { recursive: true });
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  fs.renameSync(companionDir(topic, slug), toDir);
  const exercises = exercisesPdfPath(topic, slug);
  if (fs.existsSync(exercises)) {
    fs.renameSync(exercises, exercisesPdfPath(newTopic, slug));
  }
  fs.renameSync(pdfPath(topic, slug), toPdf);
  const paper = loadPaper(newTopic, slug);
  if (!paper) throw new Error(`Move failed for "${slug}".`);
  return paper;
}

/**
 * Recover the only two safe partial states produced by companion-first moves:
 * an accepted inbox companion still containing paper.pdf, or a confirmed
 * companion whose PDF remains under its previous topic. The WebDAV PDF is
 * always moved last, so recovery never publishes metadata-less content.
 */
export function recoverInterruptedMoves(): void {
  ensureDataDirs();
  for (const topicEntry of fs.readdirSync(libraryRoot(), {
    withFileTypes: true,
  })) {
    if (!topicEntry.isDirectory() || topicEntry.name === "_inbox") continue;
    if (!isValidSlug(topicEntry.name)) continue;
    const topic = topicEntry.name;
    const topicDir = path.join(libraryRoot(), topic);
    for (const paperEntry of fs.readdirSync(topicDir, {
      withFileTypes: true,
    })) {
      if (!paperEntry.isDirectory() || !isValidSlug(paperEntry.name)) continue;
      const slug = paperEntry.name;
      const destination = pdfPath(topic, slug);
      if (fs.existsSync(destination)) continue;

      const acceptedPdf = path.join(companionDir(topic, slug), INBOX_PDF);
      if (fs.existsSync(acceptedPdf)) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(acceptedPdf, destination);
        continue;
      }

      const candidates: string[] = [];
      for (const sourceTopicEntry of fs.readdirSync(papersRoot(), {
        withFileTypes: true,
      })) {
        if (!sourceTopicEntry.isDirectory()) continue;
        const candidate = path.join(
          papersRoot(),
          sourceTopicEntry.name,
          `${slug}.pdf`,
        );
        if (fs.existsSync(candidate)) candidates.push(candidate);
      }
      if (candidates.length !== 1) continue;
      const source = candidates[0];
      const sourceExercises = source.replace(/\.pdf$/, ".exercises.pdf");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(sourceExercises)) {
        fs.renameSync(sourceExercises, exercisesPdfPath(topic, slug));
      }
      fs.renameSync(source, destination);
    }
  }
}

/** Clear the sync-review flag once the user keeps or re-files the paper. */
export function clearNeedsReview(topic: string, slug: string): void {
  const meta = readMeta(topic, slug);
  if (!meta) throw new Error(`No paper "${slug}" in topic "${topic}".`);
  if (!meta.needsReview) return;
  delete meta.needsReview;
  writeMeta(topic, slug, meta);
}

/** Accept an inbox capture only when it belongs to the profile's capture token. */
export function acceptInboxCapture(
  slug: string,
  topic: string,
  username: string,
): Paper {
  assertSlug(slug);
  assertSlug(topic);
  const meta = readMeta(null, slug);
  if (!meta || meta.addedBy !== username) {
    throw new CaptureOwnershipError(
      "No pending capture is available for this profile.",
    );
  }
  return acceptFromInbox(slug, topic);
}

/** Delete a pending capture only when it belongs to the signed-in profile. */
export function discardInboxCapture(slug: string, username: string): void {
  assertSlug(slug);
  assertSlug(username);
  const paper = loadPaper(null, slug);
  if (paper) {
    if (paper.meta.addedBy !== username) {
      throw new CaptureOwnershipError(
        "No pending capture is available for this profile.",
      );
    }
    fs.rmSync(paper.companionDir, { recursive: true, force: true });
    return;
  }
  // Marker-only dirs (failed/stale async captures) own no meta.json;
  // ownership comes from the marker itself.
  const job = readCaptureJob(slug);
  if (!job || job.addedBy !== username) {
    throw new CaptureOwnershipError(
      "No pending capture is available for this profile.",
    );
  }
  removeCaptureJobDir(slug);
}
