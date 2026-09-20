import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestProfile, testProfileCapability } from "../../helpers/access";
import {
  writeCaptureJob,
  readCaptureJob,
  clearCaptureJob,
  recoverInterruptedCaptures,
  type CaptureJob,
} from "@/lib/capture/jobs";

let directory: string;
let job: CaptureJob;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-job-recovery-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Reader");
  job = {
    slug: "original",
    pollingSlug: "original",
    jobId: "11111111-1111-4111-8111-111111111111",
    state: "analyzing",
    addedBy: "reader",
    generation: testProfileCapability("reader").generation,
    sourceUrl: "https://example.com/paper.pdf",
    startedAt: "2026-09-11T00:00:00.000Z",
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("leaves a live worker's marker alone and recovers it after the worker exits", async () => {
  writeCaptureJob(job);
  const anchor = path.join(
    directory,
    "locks",
    "capture-jobs",
    `${job.jobId}.guard`,
  );
  fs.mkdirSync(path.dirname(anchor), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const { acquireFileLockSync } = require('thesidedoor-core/storage');
    acquireFileLockSync(process.argv[1]);
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `,
      anchor,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let diagnostics = "";
      child.stderr.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Lock worker exited (${code}): ${diagnostics}`)),
      );
      child.stdout.once("data", () => resolve());
    });
    recoverInterruptedCaptures();
    expect(readCaptureJob(job.slug)?.state).toBe("analyzing");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  recoverInterruptedCaptures();
  expect(readCaptureJob(job.slug)?.state).toBe("failed");
});

it("restores the original polling handle after a crash during title renaming", () => {
  writeCaptureJob(job);
  const root = path.join(directory, "library", "_inbox");
  fs.mkdirSync(path.join(root, "original"), { recursive: true });
  fs.renameSync(path.join(root, "original"), path.join(root, "paper-title"));
  fs.writeFileSync(
    path.join(root, "paper-title", "text.txt"),
    "Captured paper",
  );
  recoverInterruptedCaptures();
  expect(readCaptureJob("original")).toMatchObject({
    state: "failed",
    jobId: job.jobId,
  });
  expect(readCaptureJob("paper-title")).toBeNull();
  expect(
    fs.readFileSync(path.join(root, "paper-title", "text.txt"), "utf8"),
  ).toBe("Captured paper");
});

it("preserves completed handles and never resurrects a consumed handle", () => {
  writeCaptureJob({ ...job, state: "done", finalSlug: "paper-title" });
  recoverInterruptedCaptures();
  expect(readCaptureJob("original")?.state).toBe("done");
  clearCaptureJob("original");
  recoverInterruptedCaptures();
  expect(readCaptureJob("original")).toBeNull();
});

it("does not modify a marker with a mismatched profile generation", () => {
  writeCaptureJob({ ...job, generation: job.generation! + 1 });
  recoverInterruptedCaptures();
  expect(readCaptureJob(job.slug)?.state).toBe("analyzing");
});
