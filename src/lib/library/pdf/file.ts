import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { syncDirectory } from "thesidedoor-core/storage";
import { FilesystemBusyError, withFilesystemLock } from "../../filesystem-lock";
import { MAX_PDF_BYTES } from "../../pdf-limits";
import { getPaper, exercisesPdfPath } from "../papers";

export type PdfKind = "paper" | "exercises";

function paperPdfPath(
  topic: string,
  slug: string,
  kind: PdfKind,
): string | null {
  const paper = getPaper(topic, slug);
  return paper
    ? kind === "paper"
      ? paper.pdfPath
      : exercisesPdfPath(topic, slug)
    : null;
}

const RECENT_WRITE_MS = 5_000;
const PDF_LOCK_WAIT_MS = 2_000;
const recentAppWrites = new Map<string, { etag: string; writtenAt: number }>();
const versionCache = new Map<string, { identity: string; etag: string }>();

export class PdfFileError extends Error {}
export class PdfConflictError extends PdfFileError {}
export class PdfBusyError extends PdfFileError {}
export class PdfTooLargeError extends PdfFileError {}
export class InvalidPdfError extends PdfFileError {}

export interface VersionedPdf {
  bytes: Uint8Array;
  etag: string;
}

function statIdentity(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

export function pdfEtag(bytes: Uint8Array): string {
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  return `"${digest}"`;
}

async function readStableFile(pdfPath: string): Promise<VersionedPdf> {
  const before = await fs.stat(pdfPath);
  const bytes = new Uint8Array(await fs.readFile(pdfPath));
  const after = await fs.stat(pdfPath);
  const identity = statIdentity(after);
  if (statIdentity(before) !== identity || after.size !== bytes.byteLength) {
    throw new PdfBusyError(
      "The PDF is still being written. Try again in a moment.",
    );
  }
  const etag = pdfEtag(bytes);
  versionCache.set(pdfPath, { identity, etag });
  return { bytes, etag };
}

export async function readVersionedPdf(
  topic: string,
  slug: string,
  kind: PdfKind = "paper",
): Promise<VersionedPdf | null> {
  const file = paperPdfPath(topic, slug, kind);
  if (!file) return null;
  try {
    return await readStableFile(file);
  } catch (error) {
    if (
      kind === "exercises" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}

/**
 * Locate a paper's PDF and its save version without reading the bytes, so a
 * range-served GET streams from disk instead of buffering 20+ MB per request.
 * The sha256 is only recomputed when the file changed on disk.
 */
export async function readVersionedPdfFile(
  topic: string,
  slug: string,
  kind: PdfKind = "paper",
): Promise<{ path: string; size: number; etag: string } | null> {
  const file = paperPdfPath(topic, slug, kind);
  if (!file) return null;

  const stat = await fs.stat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!stat) return null;
  const cached = versionCache.get(file);
  if (cached?.identity === statIdentity(stat)) {
    return { path: file, size: stat.size, etag: cached.etag };
  }

  const version = await readStableFile(file);
  return {
    path: file,
    size: version.bytes.byteLength,
    etag: version.etag,
  };
}

export async function readStablePdfVersion(
  topic: string,
  slug: string,
  kind: PdfKind = "paper",
): Promise<{ etag: string } | null> {
  const file = paperPdfPath(topic, slug, kind);
  if (!file) return null;

  const stat = await fs.stat(file).catch((error: unknown) => {
    if (
      kind === "exercises" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  });
  if (!stat) return null;
  const identity = statIdentity(stat);
  const cached = versionCache.get(file);
  if (cached?.identity === identity) return { etag: cached.etag };

  if (Date.now() - stat.mtimeMs < RECENT_WRITE_MS) {
    const known = recentAppWrites.get(file);
    if (known && Date.now() - known.writtenAt < RECENT_WRITE_MS) {
      const version = await readStableFile(file);
      if (version.etag === known.etag) return { etag: version.etag };
    }
    throw new PdfBusyError(
      "The PDF is still being written. Try again in a moment.",
    );
  }

  const version = await readStableFile(file);
  return { etag: version.etag };
}

function assertWritablePdf(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfTooLargeError("The saved PDF exceeds the 100 MB limit.");
  }
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!header.includes("%PDF-")) {
    throw new InvalidPdfError("The saved file is not a valid PDF.");
  }
  // A body cut off in transit keeps its header but loses the trailer; the
  // spec requires %%EOF within the last 1024 bytes.
  const trailer = new TextDecoder("latin1").decode(bytes.subarray(-1024));
  if (!trailer.includes("%%EOF")) {
    throw new InvalidPdfError("The saved PDF is incomplete. Try saving again.");
  }
}

function assertFileVersion(file: string, expected: string | null): void {
  let current: Buffer | null;
  try {
    current = fsSync.readFileSync(file);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    current = null;
  }
  if ((current ? pdfEtag(current) : null) !== expected)
    throw new PdfConflictError(
      "The PDF changed at the final commit. Reload and try again.",
    );
}

/** Hold the canonical writer lease while committing metadata against unchanged bytes. */
export async function verifyPdfVersion(
  topic: string,
  slug: string,
  expected: string,
  commit: (verify: () => void) => void,
  kind: PdfKind = "paper",
): Promise<void> {
  await withPdfWriteLock(
    topic,
    slug,
    async (file) => {
      commit(() => assertFileVersion(file, expected));
    },
    kind,
  );
}

async function assertNotRecentlyWritten(
  pdfPath: string,
  allowedAppEtag?: string,
): Promise<void> {
  const stat = await fs.stat(pdfPath);
  if (Date.now() - stat.mtimeMs >= RECENT_WRITE_MS) return;

  const knownWrite = recentAppWrites.get(pdfPath);
  if (
    allowedAppEtag &&
    knownWrite?.etag === allowedAppEtag &&
    Date.now() - knownWrite.writtenAt < RECENT_WRITE_MS
  ) {
    return;
  }
  throw new PdfBusyError(
    "The PDF was just modified. Wait a few seconds so another editor can finish saving.",
  );
}

async function atomicReplace(
  pdfPath: string,
  bytes: Uint8Array,
  expectedEtag?: string | null,
  commit?: (operation: () => void) => void,
): Promise<string> {
  const stat = await fs.stat(pdfPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  const tempPath = path.join(
    path.dirname(pdfPath),
    `.${path.basename(pdfPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, bytes, {
      mode: stat ? stat.mode & 0o777 : 0o600,
      flush: true,
    });
    const existing = await fs.readFile(pdfPath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (
      expectedEtag !== undefined &&
      (existing ? pdfEtag(existing) : null) !== expectedEtag
    ) {
      throw new PdfConflictError(
        "The PDF changed while it was being saved. Reload and try again.",
      );
    }
    if (commit)
      commit(() => {
        if (expectedEtag !== undefined)
          assertFileVersion(pdfPath, expectedEtag);
        fsSync.renameSync(tempPath, pdfPath);
        syncDirectory(path.dirname(pdfPath));
      });
    else {
      await fs.rename(tempPath, pdfPath);
      syncDirectory(path.dirname(pdfPath));
    }
    const etag = pdfEtag(bytes);
    // A WebDAV writer may save immediately after our rename. Do not attach
    // our digest to a later writer's file identity.
    versionCache.delete(pdfPath);
    return etag;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function withPdfWriteLock<T>(
  topic: string,
  slug: string,
  operation: (pdfPath: string) => Promise<T>,
  kind: PdfKind = "paper",
): Promise<T> {
  const file = paperPdfPath(topic, slug, kind);
  if (!file) throw new PdfFileError(`Unknown paper ${topic}/${slug}`);

  try {
    return await withFilesystemLock(
      "pdf",
      kind === "paper" ? `${topic}/${slug}` : `${topic}/${slug}/exercises`,
      PDF_LOCK_WAIT_MS,
      () => operation(file),
    );
  } catch (error) {
    if (error instanceof FilesystemBusyError) {
      throw new PdfBusyError(
        "Another PDF operation is still running. Try again in a moment.",
      );
    }
    throw error;
  }
}

export async function replacePdf(
  topic: string,
  slug: string,
  expectedEtag: string | null,
  bytes: Uint8Array,
  commit?: (operation: () => void) => void,
  kind: PdfKind = "paper",
): Promise<{ etag: string }> {
  assertWritablePdf(bytes);

  return withPdfWriteLock(
    topic,
    slug,
    async (pdfPath) => {
      const current = await fs.readFile(pdfPath).catch((error: unknown) => {
        if (
          kind === "exercises" &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      });
      if ((current ? pdfEtag(current) : null) !== expectedEtag) {
        throw new PdfConflictError(
          "The PDF changed after you opened it. Reload before saving so newer annotations are not overwritten.",
        );
      }
      if (current)
        await assertNotRecentlyWritten(pdfPath, expectedEtag ?? undefined);
      const etag = await atomicReplace(pdfPath, bytes, expectedEtag, commit);
      recentAppWrites.set(pdfPath, { etag, writtenAt: Date.now() });
      return { etag };
    },
    kind,
  );
}

export async function rewritePdf(
  topic: string,
  slug: string,
  transform: (bytes: Uint8Array) => Promise<Uint8Array>,
  expectedEtag?: string,
  commit?: (operation: () => void) => void,
  kind: PdfKind = "paper",
): Promise<{ etag: string }> {
  return withPdfWriteLock(
    topic,
    slug,
    async (pdfPath) => {
      const current = new Uint8Array(await fs.readFile(pdfPath));
      if (expectedEtag && pdfEtag(current) !== expectedEtag) {
        throw new PdfConflictError(
          "The PDF changed after you opened it. Reload before saving.",
        );
      }
      await assertNotRecentlyWritten(pdfPath, expectedEtag);
      const next = await transform(current);
      assertWritablePdf(next);
      const etag = await atomicReplace(pdfPath, next, pdfEtag(current), commit);
      recentAppWrites.set(pdfPath, {
        etag,
        writtenAt: Date.now(),
      });
      return { etag };
    },
    kind,
  );
}
