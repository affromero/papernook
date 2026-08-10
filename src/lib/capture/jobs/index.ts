import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { inboxRoot } from "../../data-dir";
import { assertSlug, isValidSlug } from "../../library/slug";

/**
 * On-disk capture job markers: data/library/_inbox/<slug>/capture.json.
 * The filesystem stays the source of truth for in-flight captures, so a
 * client that lost its connection (Cloudflare cuts responses at 100s) can
 * always find out what happened. States:
 *   analyzing — capture running (or queued on the capture lock)
 *   failed    — capture died; error carries the user-facing reason
 *   done      — capture finished; finalSlug points at the inbox paper
 *               (the companion dir may have been renamed to a title slug)
 * Markers never carry meta.json, so listInbox()/rebuildIndex() skip them.
 */

const MARKER = "capture.json";

const jobFileSchema = z.object({
  state: z.enum(["analyzing", "failed", "done"]),
  sourceUrl: z.string(),
  addedBy: z.string(),
  startedAt: z.string(),
  error: z.string().optional(),
  finalSlug: z.string().optional(),
});

export type CaptureJob = z.infer<typeof jobFileSchema> & { slug: string };

function markerPath(slug: string): string {
  return path.join(inboxRoot(), slug, MARKER);
}

export function writeCaptureJob(job: CaptureJob): void {
  assertSlug(job.slug);
  const { slug, ...data } = job;
  fs.mkdirSync(path.join(inboxRoot(), slug), { recursive: true });
  fs.writeFileSync(markerPath(slug), JSON.stringify(data, null, 2));
}

export function readCaptureJob(slug: string): CaptureJob | null {
  if (!isValidSlug(slug)) return null;
  try {
    const parsed = jobFileSchema.safeParse(
      JSON.parse(fs.readFileSync(markerPath(slug), "utf8")),
    );
    return parsed.success ? { slug, ...parsed.data } : null;
  } catch {
    return null;
  }
}

export function clearCaptureJob(slug: string): void {
  assertSlug(slug);
  fs.rmSync(markerPath(slug), { force: true });
}

/** Remove a marker-only companion dir (failed/stale jobs; never papers). */
export function removeCaptureJobDir(slug: string): void {
  assertSlug(slug);
  const dir = path.join(inboxRoot(), slug);
  if (fs.existsSync(path.join(dir, "meta.json"))) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/** All job markers, newest first; optionally one profile's. */
export function listCaptureJobs(username?: string): CaptureJob[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(inboxRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs: CaptureJob[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
    const job = readCaptureJob(entry.name);
    if (!job) continue;
    if (username && job.addedBy !== username) continue;
    jobs.push(job);
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function findAnalyzingJobBySource(
  sourceUrl: string,
  username: string,
): CaptureJob | null {
  return (
    listCaptureJobs(username).find(
      (job) => job.state === "analyzing" && job.sourceUrl === sourceUrl,
    ) ?? null
  );
}

/** Delete every marker owned by an erased profile (privacy invariant). */
export function sweepCaptureJobs(username: string): void {
  for (const job of listCaptureJobs(username)) {
    if (job.state === "done") {
      clearCaptureJob(job.slug);
    } else {
      removeCaptureJobDir(job.slug);
    }
  }
}

/**
 * Boot-time reconciliation (scanner startup): an "analyzing" marker can
 * only belong to this process, so any found at boot died with the previous
 * one. "done" markers are viewed-once handles for the /add status page; at
 * boot the flow is long over, so drop the leftovers.
 */
export function recoverInterruptedCaptures(): void {
  for (const job of listCaptureJobs()) {
    if (job.state === "analyzing") {
      writeCaptureJob({
        ...job,
        state: "failed",
        error: "Interrupted by a server restart. Dismiss and retry.",
      });
    } else if (job.state === "done") {
      clearCaptureJob(job.slug);
      removeCaptureJobDir(job.slug);
    }
  }
}
