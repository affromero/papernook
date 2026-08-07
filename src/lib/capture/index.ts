import fs from "node:fs";
import path from "node:path";
import { slugify } from "../library/slug";
import { ensureDataDirs } from "../data-dir";
import {
  acceptInboxCapture,
  companionDir,
  exercisesPdfPath,
  findPaperBySource,
  pdfPath,
  readMeta,
  writeMeta,
  writeSummary,
  writeText,
  uniqueSlug,
  type PaperMeta,
  type PaperSource,
} from "../library/papers";
import { createChat, appendMessage } from "../library/chats";
import { hasConfiguredProvider } from "../agent/registry";
import { rebuildIndex } from "../library/index-db";
import { downloadPdf } from "./download";
import { extractPdfText, analyzePaper, type Analysis } from "./analyze";
import {
  beginProfileActivity,
  type ProfileActivity,
} from "../auth/profile-activity";
import { CaptureError } from "./download";
import { captureLockKey, withZoteroLock } from "./zotero-lock";

/**
 * Capture orchestration: URL → inbox paper with proposed filing.
 * The paper stays in data/library/_inbox/ (PDF inside the companion dir, so
 * nothing unconfirmed ever shows over WebDAV) until the user accepts the
 * proposed topic/tags on the confirmation page.
 */

export interface CaptureResult {
  slug: string;
  proposedTopic: string;
  analysis: Analysis;
}

export interface CapturePdfOptions {
  /** Original URL recorded in meta and given to the analyzer. */
  sourceUrl: string;
  username: string;
  /** URL the bytes actually came from; seeds the provisional slug. */
  finalUrl?: string;
  arxivId?: string | null;
  /** File straight into the proposed topic instead of waiting in the inbox. */
  autoFile?: boolean;
  source?: PaperSource;
  /** Trusted bibliographic metadata that wins over the AI's guess. */
  overrides?: Partial<
    Pick<
      PaperMeta,
      "title" | "authors" | "year" | "venue" | "bibtex" | "citation"
    >
  >;
  /** Trusted source tags merged after AI-proposed tags. */
  sourceTags?: string[];
}

export async function capture(
  url: string,
  username: string,
): Promise<CaptureResult> {
  const activity = beginProfileActivity(username);
  if (!activity) throw profileDeletedError();
  try {
    const pdf = await downloadPdf(url);
    assertActive(activity);
    return await capturePdf(
      pdf.bytes,
      {
        sourceUrl: url,
        username,
        finalUrl: pdf.finalUrl,
        arxivId: pdf.arxivId,
      },
      activity,
    );
  } finally {
    activity.finish();
  }
}

export async function capturePdf(
  bytes: Buffer,
  opts: CapturePdfOptions,
  parentActivity?: ProfileActivity,
): Promise<CaptureResult> {
  const activity = parentActivity ?? beginProfileActivity(opts.username);
  if (!activity) throw profileDeletedError();
  try {
    return await capturePdfActive(bytes, opts, activity);
  } finally {
    if (!parentActivity) activity.finish();
  }
}

async function capturePdfActive(
  bytes: Buffer,
  opts: CapturePdfOptions,
  activity: ProfileActivity,
): Promise<CaptureResult> {
  return withZoteroLock(captureLockKey(), 10 * 60_000, () =>
    capturePdfLocked(bytes, opts, activity),
  );
}

async function capturePdfLocked(
  bytes: Buffer,
  opts: CapturePdfOptions,
  activity: ProfileActivity,
): Promise<CaptureResult> {
  ensureDataDirs();
  assertActive(activity);
  const duplicate = findPaperBySource(
    opts.sourceUrl,
    opts.arxivId,
    opts.username,
  );
  if (duplicate) {
    throw new CaptureError(
      duplicate.topic
        ? "This paper is already in your library."
        : "This paper is already waiting in the Inbox.",
    );
  }

  // Slug from the analyzed title once we have it; provisional from URL now.
  const provisional = uniqueSlug(
    provisionalBase(opts.finalUrl ?? opts.sourceUrl),
  );
  const inboxPdf = pdfPath(null, provisional);
  fs.mkdirSync(path.dirname(inboxPdf), { recursive: true });
  fs.writeFileSync(inboxPdf, bytes);

  let finalSlug = provisional;
  let proposedTopic: string | null = null;
  try {
    const text = await extractPdfText(inboxPdf);
    assertActive(activity);
    const analysis = await analyzePaper(opts.sourceUrl, text, opts.arxivId);
    assertActive(activity);

    // Rename to a title-based slug now that the title is known.
    finalSlug = retargetSlug(
      provisional,
      opts.overrides?.title ?? analysis.title,
    );

    proposedTopic = slugify(analysis.topic) || "unsorted";
    const meta: PaperMeta = {
      title: analysis.title,
      authors: analysis.authors,
      year: analysis.year,
      venue: analysis.venue,
      arxivId: opts.arxivId ?? null,
      bibtex: analysis.bibtex,
      tags: mergeTags(analysis.tags, opts.sourceTags ?? []),
      related: analysis.related,
      proposedTopic,
      ...opts.overrides,
      sourceUrl: opts.sourceUrl,
      addedAt: new Date().toISOString(),
      addedBy: opts.username,
    };
    if (opts.source) meta.source = opts.source;
    if (opts.autoFile) meta.needsReview = true;
    writeMeta(null, finalSlug, meta);
    writeSummary(null, finalSlug, analysis.summary);
    if (text) writeText(null, finalSlug, text);

    // Seed the capturing profile's first chat with the starter questions.
    // No-provider mode skips the seed: chats are an AI-only surface there.
    if (hasConfiguredProvider()) {
      const chat = createChat(
        null,
        finalSlug,
        opts.username,
        "Starter questions",
      );
      appendMessage(null, finalSlug, opts.username, chat.id, {
        role: "assistant",
        content:
          "Some questions to start studying this paper:\n\n" +
          analysis.starterQuestions.map((q) => `- ${q}`).join("\n"),
        at: new Date().toISOString(),
      });
    }

    if (opts.autoFile) {
      // Same inbox→library path the confirm page uses: the PDF only reaches
      // data/papers/ (and thus WebDAV) via the accept function's atomic rename.
      // No per-paper rebuildIndex here — callers may batch one rebuild.
      acceptInboxCapture(finalSlug, proposedTopic, opts.username);
    } else {
      rebuildIndex();
    }
    assertActive(activity);
    return { slug: finalSlug, proposedTopic, analysis };
  } catch (error) {
    removeOwnedCapture(opts.username, finalSlug, proposedTopic);
    if (activity.cancelled()) {
      throw profileDeletedError();
    }
    throw error;
  }
}

function assertActive(activity: ProfileActivity): void {
  if (activity.cancelled()) throw profileDeletedError();
}

function profileDeletedError(): CaptureError {
  return new CaptureError(
    "This profile was deleted while the capture was running.",
  );
}

export function removeOwnedCapture(
  username: string,
  slug: string,
  topic: string | null,
): void {
  const locations: Array<string | null> = topic ? [topic, null] : [null];
  for (const location of locations) {
    const meta = readMeta(location, slug);
    if (meta && meta.addedBy !== username) continue;
    fs.rmSync(pdfPath(location, slug), { force: true });
    if (location) {
      fs.rmSync(exercisesPdfPath(location, slug), { force: true });
    }
    fs.rmSync(companionDir(location, slug), { recursive: true, force: true });
  }
}

function mergeTags(proposed: string[], source: string[]): string[] {
  const merged = new Map<string, string>();
  for (const value of [...proposed, ...source]) {
    const tag = value.trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (!merged.has(key)) merged.set(key, tag);
  }
  return [...merged.values()];
}

function provisionalBase(url: string): string {
  try {
    return slugify(path.basename(new URL(url).pathname)) || "paper";
  } catch {
    return "paper";
  }
}

/** Move the provisional inbox capture onto a title-derived slug. */
function retargetSlug(provisional: string, title: string): string {
  const wanted = slugify(title);
  if (!wanted || wanted === provisional) return provisional;
  const finalSlug = uniqueSlug(wanted);
  const fromDir = companionDir(null, provisional);
  const toDir = companionDir(null, finalSlug);
  if (fs.existsSync(fromDir)) {
    fs.renameSync(fromDir, toDir);
  } else {
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(pdfPath(null, provisional), pdfPath(null, finalSlug));
  }
  return finalSlug;
}
