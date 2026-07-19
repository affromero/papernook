import {
  FilesystemBusyError,
  filesystemLockPath,
  withFilesystemLock,
} from "../filesystem-lock";

export class ZoteroBusyError extends FilesystemBusyError {}

export function zoteroLockPath(key: string): string {
  return filesystemLockPath("zotero", key);
}

export async function withZoteroLock<T>(
  key: string,
  waitMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await withFilesystemLock("zotero", key, waitMs, operation);
  } catch (error) {
    if (error instanceof FilesystemBusyError) {
      throw new ZoteroBusyError("Another Zotero operation is still running.");
    }
    throw error;
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
