import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
  return process.env.PAPERNOOK_DATA_DIR ?? path.join(process.cwd(), "data");
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

/**
 * Session-signing secret. Prefer SESSION_SECRET from env; otherwise generate
 * once into data/session-secret so restarts keep sessions valid without any
 * required env for a first local boot.
 */
export function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  const file = path.join(dataRoot(), "session-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through to generate
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dataRoot(), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** True when the instance is exposed beyond the private network. */
export function isPublicExposure(): boolean {
  return process.env.PUBLIC_EXPOSURE === "true";
}
