import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readCaptureJob,
  writeCaptureJob,
  type CaptureJob,
} from "@/lib/capture/jobs";

let directory: string;
const job: CaptureJob = {
  slug: "paper",
  state: "analyzing",
  sourceUrl: "https://example.com/paper.pdf",
  addedBy: "reader",
  generation: 0,
  startedAt: "2026-09-11T00:00:00.000Z",
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-job-storage-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("preserves the previous complete marker when publication fails", () => {
  writeCaptureJob(job);
  const failure = Object.assign(new Error("Disk unavailable"), { code: "EIO" });
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw failure;
  });
  expect(() =>
    writeCaptureJob({ ...job, state: "done", finalSlug: "title" }),
  ).toThrow(failure);
  expect(readCaptureJob(job.slug)).toEqual(job);
  const folder = path.join(directory, "capture-jobs");
  expect(fs.readdirSync(folder)).toEqual(["paper.json"]);
  expect(fs.statSync(path.join(folder, "paper.json")).mode & 0o777).toBe(0o600);
});

it("surfaces unreadable job storage instead of reporting a missing capture", () => {
  writeCaptureJob(job);
  const failure = Object.assign(new Error("Permission denied"), {
    code: "EACCES",
  });
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw failure;
  });
  expect(() => readCaptureJob(job.slug)).toThrow(failure);
});
