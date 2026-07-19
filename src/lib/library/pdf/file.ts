import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FilesystemBusyError, withFilesystemLock } from "../../filesystem-lock";
import { MAX_PDF_BYTES } from "../../pdf-limits";
import { getPaper } from "../papers";

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
): Promise<VersionedPdf | null> {
  const paper = getPaper(topic, slug);
  if (!paper) return null;
  return readStableFile(paper.pdfPath);
}

export async function readStablePdfVersion(
  topic: string,
  slug: string,
): Promise<{ etag: string } | null> {
  const paper = getPaper(topic, slug);
  if (!paper) return null;

  const stat = await fs.stat(paper.pdfPath);
  const identity = statIdentity(stat);
  const cached = versionCache.get(paper.pdfPath);
  if (cached?.identity === identity) return { etag: cached.etag };

  if (Date.now() - stat.mtimeMs < RECENT_WRITE_MS) {
    throw new PdfBusyError(
      "The PDF is still being written. Try again in a moment.",
    );
  }

  const version = await readStableFile(paper.pdfPath);
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
): Promise<string> {
  const stat = await fs.stat(pdfPath);
  const tempPath = path.join(
    path.dirname(pdfPath),
    `.${path.basename(pdfPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, bytes, { mode: stat.mode & 0o777 });
    await fs.rename(tempPath, pdfPath);
    const identity = statIdentity(await fs.stat(pdfPath));
    const etag = pdfEtag(bytes);
    versionCache.set(pdfPath, { identity, etag });
    return etag;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function withPdfWriteLock<T>(
  topic: string,
  slug: string,
  operation: (pdfPath: string) => Promise<T>,
): Promise<T> {
  const paper = getPaper(topic, slug);
  if (!paper) throw new PdfFileError(`Unknown paper ${topic}/${slug}`);

  try {
    return await withFilesystemLock(
      "pdf",
      `${topic}/${slug}`,
      PDF_LOCK_WAIT_MS,
      () => operation(paper.pdfPath),
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
  expectedEtag: string,
  bytes: Uint8Array,
): Promise<{ etag: string }> {
  assertWritablePdf(bytes);

  return withPdfWriteLock(topic, slug, async (pdfPath) => {
    const current = new Uint8Array(await fs.readFile(pdfPath));
    if (pdfEtag(current) !== expectedEtag) {
      throw new PdfConflictError(
        "The PDF changed after you opened it. Reload before saving so newer annotations are not overwritten.",
      );
    }
    await assertNotRecentlyWritten(pdfPath, expectedEtag);
    const etag = await atomicReplace(pdfPath, bytes);
    recentAppWrites.set(pdfPath, { etag, writtenAt: Date.now() });
    return { etag };
  });
}

export async function rewritePdf(
  topic: string,
  slug: string,
  transform: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<void> {
  await withPdfWriteLock(topic, slug, async (pdfPath) => {
    await assertNotRecentlyWritten(pdfPath);
    const next = await transform(new Uint8Array(await fs.readFile(pdfPath)));
    assertWritablePdf(next);
    const etag = await atomicReplace(pdfPath, next);
    recentAppWrites.set(pdfPath, {
      etag,
      writtenAt: Date.now(),
    });
  });
}
