import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataRoot } from "../data-dir";

const LOCK_STALE_MS = 15 * 60_000;
const HEARTBEAT_MS = 30_000;
const POLL_MS = 100;

export class ZoteroBusyError extends Error {}

export function zoteroLockPath(key: string): string {
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(dataRoot(), ".locks", `zotero-${digest}`);
}

async function removeStaleLock(lock: string): Promise<void> {
  try {
    const stat = await fs.stat(lock);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      const stale = `${lock}.stale-${crypto.randomUUID()}`;
      await fs.rename(lock, stale);
      await fs.rm(stale, { recursive: true, force: true });
    }
  } catch {
    // The lock disappeared or was renewed between inspection and removal.
  }
}

async function ownsLock(lock: string, token: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(lock, "owner.json"), "utf8");
    return (JSON.parse(raw) as { token?: unknown }).token === token;
  } catch {
    return false;
  }
}

async function acquire(
  key: string,
  waitMs: number,
): Promise<() => Promise<void>> {
  const lock = zoteroLockPath(key);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await fs.mkdir(lock);
      const token = crypto.randomUUID();
      await fs.writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({
          token,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      const heartbeat = setInterval(() => {
        void ownsLock(lock, token).then((owned) => {
          if (!owned) return;
          const now = new Date();
          return fs.utimes(lock, now, now).catch(() => undefined);
        });
      }, HEARTBEAT_MS);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        if (await ownsLock(lock, token)) {
          await fs.rm(lock, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      await removeStaleLock(lock);
      if (Date.now() >= deadline) {
        throw new ZoteroBusyError("Another Zotero operation is still running.");
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

export async function withZoteroLock<T>(
  key: string,
  waitMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquire(key, waitMs);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function profileLockKey(username: string): string {
  return `profile:${username}`;
}

export function itemLockKey(
  libraryType: "user" | "group",
  libraryId: string,
  itemKey: string,
): string {
  return `item:${libraryType}:${libraryId}:${itemKey}`;
}

export function captureLockKey(): string {
  return "capture:filesystem";
}
