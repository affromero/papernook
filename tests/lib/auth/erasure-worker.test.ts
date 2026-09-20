import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "thesidedoor-core/storage";
import {
  createTestProfile,
  revokeTestProfile,
  testAccess,
} from "../../helpers/access";
import {
  runErasurePass,
  startErasureWorker,
  stopErasureWorker,
  erasureWorkerStatus,
} from "@/lib/auth/platform/erasure-worker";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-erasure-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
});
afterEach(async () => {
  await stopErasureWorker();
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function pendingErasure() {
  await createTestProfile("Reader");
  const { identity } = await testAccess();
  const privateDirectory = path.join(directory, "users", "reader");
  fs.mkdirSync(privateDirectory, { recursive: true });
  const file = path.join(privateDirectory, "private-conversation.json");
  fs.writeFileSync(file, "Private conversation");
  await revokeTestProfile("reader");
  return { identity, file };
}

it("removes private files before completing a pending erasure", async () => {
  const { identity, file } = await pendingErasure();
  expect(await runErasurePass(identity, new AbortController().signal)).toEqual(
    [],
  );
  expect(fs.existsSync(file)).toBe(false);
  expect((await identity.read()).erasures).toEqual([]);
});

it("retains the tombstone when deletion cannot be flushed and completes after a successful retry", async () => {
  const { identity, file } = await pendingErasure();
  const parent = fs.statSync(path.join(directory, "users"));
  const marker = (await identity.read()).erasures[0];
  const sync = fs.fsyncSync.bind(fs);
  const fault = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    const target = fs.fstatSync(descriptor);
    if (target.ino === parent.ino && target.dev === parent.dev)
      throw Object.assign(new Error("Directory flush failed"), { code: "EIO" });
    sync(descriptor);
  });
  syncBuiltinESMExports();
  try {
    expect(
      await runErasurePass(identity, new AbortController().signal),
    ).toEqual([{ ...marker, status: "failed" }]);
    expect(fs.existsSync(file)).toBe(false);
    expect((await identity.read()).erasures).toHaveLength(1);
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
  expect(await runErasurePass(identity, new AbortController().signal)).toEqual(
    [],
  );
  expect((await identity.read()).erasures).toEqual([]);
});

it("keeps unresolved ownership pending without exposing private content in diagnostics", async () => {
  const { identity, file } = await pendingErasure();
  const inbox = path.join(directory, "library", "_inbox", "unknown");
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, "paper.pdf"), "Sensitive paper contents");
  expect(await runErasurePass(identity, new AbortController().signal)).toEqual([
    { ...(await identity.read()).erasures[0], status: "failed" },
  ]);
  expect(fs.existsSync(file)).toBe(true);
  expect((await identity.read()).erasures).toHaveLength(1);
});

it("does not create files or start a worker during a production build", () => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build");
  startErasureWorker();
  expect(erasureWorkerStatus()).toEqual({ running: false, diagnostics: [] });
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("supports repeat startup and shutdown while profile cleanup is locked", async () => {
  const { identity, file } = await pendingErasure();
  const release = acquireFileLockSync(
    identity.profileLockPath("reader"),
    "shared",
  );
  try {
    startErasureWorker();
    startErasureWorker();
    expect(erasureWorkerStatus().running).toBe(true);
    await stopErasureWorker();
    expect(erasureWorkerStatus().running).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect((await identity.read()).erasures).toHaveLength(1);
  } finally {
    release();
  }
});
