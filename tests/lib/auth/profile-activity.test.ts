import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  acquireFileLockSync,
  FileLockBusyError,
} from "thesidedoor-core/storage";
import { beginProfileActivity } from "@/lib/auth/profile-activity";
import { withProfileActivity } from "@/lib/auth/profile-capability";
import { PapernookIdentityStore } from "@/lib/auth/identity-store";
import {
  createTestProfile,
  revokeTestProfile,
  testProfileCapability,
} from "../../helpers/access";

let directory: string;
it("releases a profile lease when an awaited operation fails", async () => {
  const identity = new PapernookIdentityStore(directory);
  const capability = testProfileCapability("reader");
  await expect(
    withProfileActivity(identity, capability, async () => {
      await Promise.resolve();
      throw new Error("Resource operation failed");
    }),
  ).rejects.toThrow("Resource operation failed");
  const release = acquireFileLockSync(identity.profileLockPath("reader"));
  release();
});

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-activity-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Reader");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("holds cleanup off until all activities finish and rejects revoked admission", async () => {
  const capability = testProfileCapability("reader");
  const first = beginProfileActivity(capability)!;
  const second = beginProfileActivity(capability)!;
  const anchor = new PapernookIdentityStore(directory).profileLockPath(
    "reader",
  );
  try {
    const cleanup = await revokeTestProfile("reader");
    expect(first.cancelled()).toBe(true);
    expect(second.cancelled()).toBe(true);
    expect(beginProfileActivity(capability)).toBeNull();
    expect(() => acquireFileLockSync(anchor)).toThrow(FileLockBusyError);
    first.finish();
    first.finish();
    expect(() => acquireFileLockSync(anchor)).toThrow(FileLockBusyError);
    second.finish();
    await cleanup();
    await createTestProfile("Reader");
    expect(beginProfileActivity(capability)).toBeNull();
    const replacement = beginProfileActivity(testProfileCapability("reader"))!;
    expect(replacement.cancelled()).toBe(false);
    replacement.finish();
  } finally {
    first.finish();
    second.finish();
  }
});

it("refuses to start while exclusive cleanup owns the profile files", () => {
  const capability = testProfileCapability("reader");
  const release = acquireFileLockSync(
    new PapernookIdentityStore(directory).profileLockPath("reader"),
  );
  try {
    expect(() => beginProfileActivity(capability)).toThrow(FileLockBusyError);
  } finally {
    release();
  }
  const activity = beginProfileActivity(capability)!;
  expect(activity.cancelled()).toBe(false);
  activity.finish();
});

it("surfaces corrupt identity storage instead of treating it as normal cancellation", () => {
  const activity = beginProfileActivity(testProfileCapability("reader"))!;
  try {
    fs.writeFileSync(path.join(directory, "identity.json"), "corrupt");
    expect(() => activity.cancelled()).toThrow();
  } finally {
    activity.finish();
  }
  const release = acquireFileLockSync(
    new PapernookIdentityStore(directory).profileLockPath("reader"),
  );
  release();
});
