import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  acquireFileLockSync,
  FileLockBusyError,
} from "thesidedoor-core/storage";
import { isAccessError } from "thesidedoor-core/access";
import { inboxRoot, dataRoot } from "../../data-dir";
import { beginProfileActivity } from "../../auth/profile-activity";
import { withProfileFiles } from "../../auth/profile-capability";
import { PapernookIdentityStore } from "../../auth/identity-store";
import { assertSlug, isValidSlug } from "../../library/slug";
import { withPaperCatalog } from "../../library/papers";

/**
 * On-disk capture job records: data/capture-jobs/<slug>.json.
 * The filesystem stays the source of truth for in-flight captures, so a
 * client that lost its connection (Cloudflare cuts responses at 100s) can
 * always find out what happened. States:
 *   analyzing — capture running (or queued on the capture lock)
 *   failed    — capture died; error carries the user-facing reason
 *   done      — capture finished; finalSlug points at the inbox paper
 *               (the companion dir may have been renamed to a title slug)
 * Markers never carry meta.json, so listInbox()/rebuildIndex() skip them.
 */

function jobsRoot(): string {
  return path.join(dataRoot(), "capture-jobs");
}

function syncPath(file: string): void {
  const descriptor = fs.openSync(file, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

const jobFileSchema = z.object({
  state: z.enum(["analyzing", "failed", "done"]),
  sourceUrl: z.string(),
  addedBy: z.string(),
  /** Legacy markers are display-only and cannot authorize resumed work. */
  generation: z.number().int().nonnegative().optional(),
  jobId: z.string().uuid().optional(),
  pollingSlug: z.string().refine(isValidSlug).optional(),
  startedAt: z.string(),
  error: z.string().optional(),
  finalSlug: z.string().optional(),
});

export type CaptureJob = z.infer<typeof jobFileSchema> & { slug: string };

export function acquireCaptureJob(jobId: string): () => void {
  z.string().uuid().parse(jobId);
  return acquireFileLockSync(
    path.join(dataRoot(), "locks", "capture-jobs", `${jobId}.guard`),
  );
}

function markerPath(slug: string): string {
  return path.join(jobsRoot(), `${slug}.json`);
}

export function writeCaptureJob(job: CaptureJob): void {
  assertSlug(job.slug);
  if (job.pollingSlug && job.pollingSlug !== job.slug)
    throw new Error("Capture record must use its original polling handle.");
  const { slug, ...data } = job;
  fs.mkdirSync(jobsRoot(), { recursive: true, mode: 0o700 });
  const file = markerPath(slug);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    fs.renameSync(temporary, file);
    syncPath(jobsRoot());
    syncPath(dataRoot());
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readCaptureJob(
  slug: string,
  strict = false,
): CaptureJob | null {
  if (!isValidSlug(slug)) return null;
  try {
    const parsed = jobFileSchema.safeParse(
      JSON.parse(fs.readFileSync(markerPath(slug), "utf8")),
    );
    if (!parsed.success && strict) throw parsed.error;
    return parsed.success ? { slug, ...parsed.data } : null;
  } catch (error) {
    if (
      (!strict && error instanceof SyntaxError) ||
      (error instanceof Error && "code" in error && error.code === "ENOENT")
    )
      return null;
    throw error;
  }
}

export function clearCaptureJob(slug: string): void {
  assertSlug(slug);
  fs.rmSync(markerPath(slug), { force: true });
  if (fs.existsSync(jobsRoot())) syncPath(jobsRoot());
}

/** Remove a marker-only companion dir (failed/stale jobs; never papers). */
export function removeCaptureJobDir(slug: string): void {
  withPaperCatalog(() => removeCaptureJobDirLocked(slug));
}

function removeCaptureJobDirLocked(slug: string): void {
  assertSlug(slug);
  clearCaptureJob(slug);
  const dir = path.join(inboxRoot(), slug);
  if (fs.existsSync(path.join(dir, "meta.json"))) return;
  fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(inboxRoot())) syncPath(inboxRoot());
}

/** All job markers, newest first; optionally one profile's. */
export function listCaptureJobs(
  username?: string,
  strict = false,
): CaptureJob[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(jobsRoot(), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  const jobs: CaptureJob[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const slug = entry.name.slice(0, -5);
    if (!isValidSlug(slug)) continue;
    const job = readCaptureJob(slug, strict);
    if (!job) continue;
    if (username && job.addedBy !== username) continue;
    jobs.push(job);
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function findAnalyzingJobBySource(
  sourceUrl: string,
  username: string,
  generation?: number,
): CaptureJob | null {
  return (
    listCaptureJobs(username).find(
      (job) =>
        job.state === "analyzing" &&
        job.sourceUrl === sourceUrl &&
        (generation === undefined || job.generation === generation),
    ) ?? null
  );
}

/** Delete every marker owned by an erased profile (privacy invariant). */
export function sweepCaptureJobs(username: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(jobsRoot(), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^[a-z0-9][a-z0-9-]*\.json\.[a-f0-9-]{36}\.tmp$/.test(entry.name)
    )
      continue;
    const file = path.join(jobsRoot(), entry.name);
    const record = jobFileSchema.parse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    if (record.addedBy === username) {
      fs.rmSync(file);
      syncPath(jobsRoot());
    }
  }
  for (const job of listCaptureJobs(username, true)) {
    if (job.state === "done") {
      clearCaptureJob(job.slug);
    } else {
      removeCaptureJobDir(job.slug);
    }
  }
  syncPath(jobsRoot());
}

/** Reconcile abandoned jobs without interrupting another worker. */
export function recoverInterruptedCaptures(): void {
  for (const job of listCaptureJobs()) {
    if (
      job.state !== "analyzing" ||
      !job.jobId ||
      !job.pollingSlug ||
      job.generation === undefined
    )
      continue;
    let releaseJob: (() => void) | undefined;
    let activity: ReturnType<typeof beginProfileActivity> = null;
    try {
      activity = beginProfileActivity({
        username: job.addedBy,
        generation: job.generation,
      });
      if (!activity) continue;
      releaseJob = acquireCaptureJob(job.jobId);
      const identity = new PapernookIdentityStore(dataRoot());
      withProfileFiles(identity, activity.capability, () => {
        const current = readCaptureJob(job.slug);
        if (
          !current ||
          current.state !== "analyzing" ||
          current.jobId !== job.jobId ||
          current.addedBy !== job.addedBy ||
          current.generation !== job.generation ||
          current.pollingSlug !== job.pollingSlug
        )
          return;
        writeCaptureJob({
          ...current,
          state: "failed",
          error: "Interrupted by a server restart. Dismiss and retry.",
        });
      });
    } catch (error) {
      if (
        !(error instanceof FileLockBusyError) &&
        !(isAccessError(error) && error.code === "unauthorized")
      )
        throw error;
    } finally {
      try {
        releaseJob?.();
      } finally {
        activity?.finish();
      }
    }
  }
}
