import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { companionDir } from "../papers";
import type { Bibliography } from "@/lib/pdf/bibliography";

/**
 * Server-side cache of a paper's scanned bibliography. The PDF reader
 * reconstructs the bibliography from text geometry in the browser and PUTs
 * it here once per document open; surfaces without a mounted reader (the
 * canvas chat) and the library graph read it back instead of re-deriving
 * entries from text.txt heuristics. The file is a rebuildable cache inside
 * the companion dir — deleting it is always safe, the next reader visit
 * repopulates it.
 */

const BIBLIOGRAPHY_FILE = "bibliography.json";

/** Stored entry text is truncated client-side before the PUT. */
export const MAX_STORED_ENTRY_TEXT = 1000;
export const MAX_STORED_ENTRIES = 2000;

const entrySchema = z
  .object({
    pageNumber: z.number().int().min(1).max(5000),
    x: z.number().finite(),
    y: z.number().finite(),
    text: z.string().min(1).max(MAX_STORED_ENTRY_TEXT),
    surname: z.string().max(200).nullable(),
    year: z
      .string()
      .regex(/^(19|20)\d{2}[a-z]?$/)
      .nullable(),
    suffix: z.string().max(2).nullable(),
    number: z.number().int().nullable(),
  })
  .strict();

export const bibliographySchema = z
  .object({
    style: z.enum(["numbered", "author-year"]),
    // Never empty: the reader only reports scans with entries, and an
    // empty-but-valid file would suppress the graph's text.txt heuristic.
    entries: z.array(entrySchema).min(1).max(MAX_STORED_ENTRIES),
  })
  .strict();

export function bibliographyPath(topic: string | null, slug: string): string {
  return path.join(companionDir(topic, slug), BIBLIOGRAPHY_FILE);
}

/** Parse and validate the cached bibliography; null on any failure. */
export function readBibliography(
  topic: string | null,
  slug: string,
): Bibliography | null {
  try {
    const raw = fs.readFileSync(bibliographyPath(topic, slug), "utf8");
    const parsed = bibliographySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic tmp+rename write, mirroring `writeMeta`. */
export function writeBibliography(
  topic: string | null,
  slug: string,
  bibliography: Bibliography,
): void {
  const dir = companionDir(topic, slug);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.bibliography.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(bibliography, null, 2));
  fs.renameSync(tmp, path.join(dir, BIBLIOGRAPHY_FILE));
}
