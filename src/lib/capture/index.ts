import fs from "node:fs";
import { writeCaptureOwner } from "./jobs/ownership";
import { randomUUID } from "node:crypto";
import { acquireFileLock } from "thesidedoor-core/storage";
import path from "node:path";
import { slugify } from "../library/slug";
import { ensureDataDirs, dataRoot } from "../data-dir";
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
  withPaperCatalog,
  type PaperMeta,
  type PaperSource,
} from "../library/papers";
import { createChat, appendMessage } from "../library/chats";
import { canonicalCitationMetadata } from "../library/citations";
import { hasConfiguredProvider } from "../agent/registry";
import { rebuildIndex } from "../library/index-db";
import { downloadPdf } from "./download";
import {
  extractPdfText,
  analyzePaper,
  compressPdf,
  linearizePdf,
  type Analysis,
} from "./analyze";
import {
  beginProfileActivity,
  type ProfileActivity,
} from "../auth/profile-activity";
import { CaptureError } from "./download";
import {
  withProfileFiles,
  type ProfileCapability,
} from "../auth/profile-capability";
import { PapernookIdentityStore } from "../auth/identity-store";
import { captureLockKey, withZoteroLock } from "./zotero-lock";
import {
  findAnalyzingJobBySource,
  removeCaptureJobDir,
  writeCaptureJob,
  acquireCaptureJob,
} from "./jobs";

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
  capability: ProfileCapability;
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
  /** Reuse an async-capture marker dir instead of minting a new slug. */
  provisionalSlug?: string;
}

/**
 * Async capture for interactive callers: writes an "analyzing" marker,
 * returns the provisional slug immediately, and finishes in the background
 * (Cloudflare cuts responses at 100s, so waiting inline loses the outcome).
 * The marker transitions to "done" (with finalSlug) or "failed" (with the
 * user-facing error); the UI reads markers, never this promise.
 */
function commitCapture<Result>(
  activity: ProfileActivity,
  operation: () => Result &
    (Result extends PromiseLike<unknown> ? never : unknown),
): Result {
  return withProfileFiles(
    new PapernookIdentityStore(dataRoot()),
    activity.capability,
    operation,
  );
}

async function reserveCapture<Result>(
  activity: ProfileActivity,
  operation: () => Result &
    (Result extends PromiseLike<unknown> ? never : unknown),
): Promise<Result> {
  const release = await acquireFileLock(
    path.join(dataRoot(), "locks", "capture-reservation.guard"),
  );
  try {
    assertActive(activity);
    return withPaperCatalog(() => commitCapture(activity, operation));
  } finally {
    await release();
  }
}

export async function captureAsync(
  url: string,
  capability: ProfileCapability,
): Promise<{ slug: string }> {
  const { username } = capability;
  const activity = beginProfileActivity(capability);
  if (!activity) throw profileDeletedError();
  let slug: string;
  const jobId = randomUUID();
  let releaseJob: (() => void) | undefined;
  const startedAt = new Date().toISOString();
  try {
    const reservation = await reserveCapture(activity, () => {
      ensureDataDirs();
      const running = findAnalyzingJobBySource(
        url,
        username,
        capability.generation,
      );
      if (running && running.generation === capability.generation) {
        return { slug: running.pollingSlug ?? running.slug, existing: true };
      }
      const slug = uniqueSlug(provisionalBase(url));
      releaseJob = acquireCaptureJob(jobId);
      writeCaptureJob({
        slug,
        jobId,
        pollingSlug: slug,
        state: "analyzing",
        sourceUrl: url,
        addedBy: username,
        generation: capability.generation,
        startedAt,
      });
      return { slug, existing: false };
    });
    slug = reservation.slug;
    if (reservation.existing) {
      activity.finish();
      return { slug };
    }
  } catch (error) {
    try {
      releaseJob?.();
    } finally {
      activity.finish();
    }
    throw error;
  }
  void (async () => {
    try {
      const pdf = await downloadPdf(url);
      assertActive(activity);
      const result = await capturePdf(
        pdf.bytes,
        {
          sourceUrl: url,
          username,
          capability,
          finalUrl: pdf.finalUrl,
          arxivId: pdf.arxivId,
          provisionalSlug: slug,
        },
        activity,
      );
      // Job records remain outside the renamed paper directories.
      commitCapture(activity, () =>
        writeCaptureJob({
          slug,
          jobId,
          pollingSlug: slug,
          state: "done",
          sourceUrl: url,
          addedBy: username,
          generation: capability.generation,
          startedAt,
          finalSlug: result.slug,
        }),
      );
    } catch (error) {
      if (activity.cancelled()) {
        // Profile erasure won: leave nothing behind.
        removeCaptureJobDir(slug);
        return;
      }
      if (!(error instanceof CaptureError)) {
        console.error(`papernook capture failed (${url}):`, error);
      }
      commitCapture(activity, () =>
        writeCaptureJob({
          slug,
          jobId,
          pollingSlug: slug,
          state: "failed",
          sourceUrl: url,
          addedBy: username,
          generation: capability.generation,
          startedAt,
          error:
            error instanceof CaptureError
              ? error.message
              : "Capture failed unexpectedly on the server. Dismiss and retry.",
        }),
      );
    } finally {
      try {
        releaseJob?.();
      } finally {
        activity.finish();
      }
    }
  })().catch(() => {
    console.error(
      "Capture completion could not be persisted. Check identity and job storage.",
    );
  });
  return { slug };
}

export async function capture(
  url: string,
  capability: ProfileCapability,
): Promise<CaptureResult> {
  const { username } = capability;
  const activity = beginProfileActivity(capability);
  if (!activity) throw profileDeletedError();
  try {
    const pdf = await downloadPdf(url);
    assertActive(activity);
    return await capturePdf(
      pdf.bytes,
      {
        sourceUrl: url,
        username,
        capability,
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
  const activity = parentActivity ?? beginProfileActivity(opts.capability);
  if (!activity) throw profileDeletedError();
  try {
    if (
      activity.username !== opts.username ||
      activity.capability.generation !== opts.capability.generation ||
      opts.capability.username !== opts.username
    )
      throw profileDeletedError();
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
  let allocatedSlug: string | undefined;
  const provisional = await reserveCapture(activity, () => {
    const slug =
      opts.provisionalSlug ??
      uniqueSlug(provisionalBase(opts.finalUrl ?? opts.sourceUrl));
    fs.mkdirSync(companionDir(null, slug), { recursive: true });
    allocatedSlug = slug;
    writeCaptureOwner(companionDir(null, slug), activity.capability);
    return slug;
  }).catch((error: unknown) => {
    if (allocatedSlug) removeOwnedCapture(opts.username, allocatedSlug, null);
    throw error;
  });
  const inboxPdf = pdfPath(null, provisional);
  let finalSlug = provisional;
  let proposedTopic: string | null = null;
  try {
    commitCapture(activity, () => fs.writeFileSync(inboxPdf, bytes));
    // Compress first, linearize second: ghostscript writes its own file
    // structure, which would undo the fast-web-view layout.
    await compressPdf(inboxPdf);
    assertActive(activity);
    await linearizePdf(inboxPdf);
    assertActive(activity);

    const text = await extractPdfText(inboxPdf);
    assertActive(activity);
    const analysis = await analyzePaper(
      opts.sourceUrl,
      text,
      opts.arxivId,
      activity.capability,
    );
    assertActive(activity);

    // Rename to a title-based slug now that the title is known.
    await reserveCapture(activity, () => {
      finalSlug = retargetSlug(
        provisional,
        opts.overrides?.title ?? analysis.title,
      );
    });

    const topic = slugify(analysis.topic) || "unsorted";
    proposedTopic = topic;
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
    meta.citation = canonicalCitationMetadata(meta);
    commitCapture(activity, () => {
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
        acceptInboxCapture(finalSlug, topic, opts.username);
      } else {
        rebuildIndex();
      }
    });
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
  withPaperCatalog(() => removeOwnedCaptureLocked(username, slug, topic));
}

function removeOwnedCaptureLocked(
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
