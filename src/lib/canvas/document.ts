import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { syncDirectory } from "thesidedoor-core/storage";
import { getPaper, withPaperMutation } from "../library/papers";

export const MAX_CANVAS_BYTES = 20 * 1024 * 1024;
export const CANVAS_VERSION_HEADER = "X-Canvas-Version";
const EMPTY_CANVAS_VERSION = '"empty"';

import { CanvasError } from "./errors";

function canvasVersion(raw: string): string {
  return `"${crypto.createHash("sha256").update(raw).digest("base64url")}"`;
}

export function readCanvasFile(file: string): {
  document: unknown;
  version: string;
} {
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_CANVAS_BYTES)
      throw new CanvasError("The saved canvas is invalid or too large.", 413);
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { document: null, version: EMPTY_CANVAS_VERSION };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  return {
    document:
      parsed && typeof parsed === "object" && "document" in parsed
        ? parsed.document
        : parsed,
    version: canvasVersion(raw),
  };
}

export function readCanvas(topic: string, slug: string) {
  const paper = getPaper(topic, slug);
  if (!paper) throw new CanvasError("Unknown paper.", 404);
  return readCanvasFile(path.join(paper.companionDir, "canvas.json"));
}

/** The paper guard covers the version comparison and atomic rename together. */
export function saveCanvas(
  topic: string,
  slug: string,
  expected: string,
  document: unknown,
): string {
  return withPaperMutation(slug, () => {
    const paper = getPaper(topic, slug);
    if (!paper) throw new CanvasError("Unknown paper.", 404);
    const file = path.join(paper.companionDir, "canvas.json");
    if (readCanvasFile(file).version !== expected)
      throw new CanvasError(
        "This canvas changed on another device. Reload before adding more.",
        409,
      );
    const raw = JSON.stringify({ document });
    if (Buffer.byteLength(raw) > MAX_CANVAS_BYTES)
      throw new CanvasError("Canvas too large.", 413);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, raw, { flag: "wx", mode: 0o600, flush: true });
      fs.renameSync(temp, file);
      syncDirectory(paper.companionDir);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return canvasVersion(raw);
  });
}
