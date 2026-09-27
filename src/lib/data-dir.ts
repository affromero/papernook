import fs from "node:fs";
import path from "node:path";

/**
 * Filesystem layout: the filesystem is the source of truth.
 *
 * data/papers/   WebDAV-shared tree: only annotatable PDFs (+ rendered
 *                exercise PDFs). Served by the rclone sidecar.
 * data/library/  App-private tree: companion folders (meta, summary, text,
 *                per-account chats, crops, canvas) and _inbox. Never exposed
 *                over WebDAV.
 * data/users/    Profiles plus private integration caches:
 *                <username>/profile.json + zotero-catalog.json.
 */

export function dataRoot(): string {
  if (process.env.NODE_ENV === "production") return "/data";
  const configured = process.env.PAPERNOOK_DATA_DIR;
  return configured
    ? path.resolve(configured)
    : path.join(process.cwd(), "data");
}

export function papersRoot(): string {
  return path.join(dataRoot(), "papers");
}

export function libraryRoot(): string {
  return path.join(dataRoot(), "library");
}

export function inboxRoot(): string {
  return path.join(libraryRoot(), "_inbox");
}

export function usersRoot(): string {
  return path.join(dataRoot(), "users");
}

export function ensureDataDirs(): void {
  for (const dir of [papersRoot(), libraryRoot(), inboxRoot(), usersRoot()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
