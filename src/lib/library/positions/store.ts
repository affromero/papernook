import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { companionDir } from "../papers";
import { assertSlug } from "../slug";
import {
  MAX_READING_SCALE,
  MIN_READING_SCALE,
  type ReadingPosition,
} from "@/lib/pdf/view/reading-position";

/**
 * Per-profile reading positions, one JSON file per user under the paper's
 * companion dir (`positions/<username>.json`). The companion dir is never
 * WebDAV-served, so positions stay app-private. Like every companion-dir
 * cache the files are expendable — deleting one only forgets where that
 * reader left off.
 */

// Year 2100: far past any honest clock, so a skewed or hand-crafted
// far-future timestamp cannot permanently win every freshness race for
// this profile.
const MAX_POSITION_TIMESTAMP_MS = 4_102_444_800_000;

export const readingPositionSchema = z
  .object({
    page: z.number().int().min(1).max(5000),
    scale: z.number().min(MIN_READING_SCALE).max(MAX_READING_SCALE),
    updatedAt: z.number().int().min(0).max(MAX_POSITION_TIMESTAMP_MS),
  })
  .strict();

function positionsDir(topic: string | null, slug: string): string {
  return path.join(companionDir(topic, slug), "positions");
}

export function positionPath(
  topic: string | null,
  slug: string,
  username: string,
): string {
  assertSlug(username);
  return path.join(positionsDir(topic, slug), `${username}.json`);
}

/** Parse and validate the stored position; null on any failure. */
export function readPosition(
  topic: string | null,
  slug: string,
  username: string,
): ReadingPosition | null {
  // Resolved outside the try: an invalid username is a caller bug and must
  // throw, never read as "no position yet".
  const file = positionPath(topic, slug, username);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = readingPositionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic tmp+rename write, mirroring `writeMeta`. */
export function writePosition(
  topic: string | null,
  slug: string,
  username: string,
  position: ReadingPosition,
): void {
  const file = positionPath(topic, slug, username);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${username}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(position));
  fs.renameSync(tmp, file);
}
