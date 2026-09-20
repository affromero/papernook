import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "thesidedoor-core/storage";
import {
  createTestProfile,
  revokeTestProfile,
  testProfileCapability,
} from "../../helpers/access";
import { captureAsync } from "@/lib/capture";
import { listCaptureJobs } from "@/lib/capture/jobs";

const network = vi.hoisted(() => ({ pending: Promise.resolve() }));
vi.mock("node:dns/promises", () => ({
  lookup: async () => {
    await network.pending;
    return [{ address: "127.0.0.1", family: 4 }];
  },
}));
let directory: string;
let finishNetwork: () => void;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-reservation-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  network.pending = new Promise<void>((resolve) => {
    finishNetwork = resolve;
  });
  await createTestProfile("Reader");
});
afterEach(async () => {
  vi.restoreAllMocks();
  finishNetwork();
  await vi.waitFor(() =>
    expect(listCaptureJobs().every((job) => job.state !== "analyzing")).toBe(
      true,
    ),
  );
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("gives simultaneous submissions of one URL a single polling handle", async () => {
  const capability = testProfileCapability("reader");
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      captureAsync("https://same.example/paper.pdf", capability),
    ),
  );
  expect(new Set(results.map((result) => result.slug)).size).toBe(1);
  expect(listCaptureJobs("reader")).toHaveLength(1);
});

it("reserves distinct handles for simultaneous URLs sharing a basename", async () => {
  const capability = testProfileCapability("reader");
  const results = await Promise.all([
    captureAsync("https://first.example/paper.pdf", capability),
    captureAsync("https://second.example/paper.pdf", capability),
  ]);
  expect(new Set(results.map((result) => result.slug)).size).toBe(2);
  expect(
    listCaptureJobs("reader")
      .map((job) => job.sourceUrl)
      .sort(),
  ).toEqual([
    "https://first.example/paper.pdf",
    "https://second.example/paper.pdf",
  ]);
});

it("keeps different profiles' captures separate for the same URL", async () => {
  await createTestProfile("Other");
  const results = await Promise.all([
    captureAsync(
      "https://shared.example/paper.pdf",
      testProfileCapability("reader"),
    ),
    captureAsync(
      "https://shared.example/paper.pdf",
      testProfileCapability("other"),
    ),
  ]);
  expect(results[0].slug).not.toBe(results[1].slug);
  expect(listCaptureJobs("reader")).toHaveLength(1);
  expect(listCaptureJobs("other")).toHaveLength(1);
});

it("does not publish a job when its profile is revoked while waiting", async () => {
  const release = acquireFileLockSync(
    path.join(directory, "locks", "capture-reservation.guard"),
  );
  const pending = captureAsync(
    "https://revoked.example/paper.pdf",
    testProfileCapability("reader"),
  );
  const rejected = expect(pending).rejects.toThrow();
  let erase: (() => Promise<void>) | undefined;
  try {
    erase = await revokeTestProfile("reader");
  } finally {
    release();
  }
  await rejected;
  expect(listCaptureJobs()).toEqual([]);
  await erase();
});

it("releases ownership after failed publication so a retry can proceed", async () => {
  const original = fs.renameSync;
  const failure = Object.assign(new Error("Storage unavailable"), {
    code: "EIO",
  });
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).startsWith(path.join(directory, "capture-jobs")))
      throw failure;
    original(from, to);
  });
  await expect(
    captureAsync(
      "https://retry.example/paper.pdf",
      testProfileCapability("reader"),
    ),
  ).rejects.toThrow(failure);
  expect(listCaptureJobs()).toEqual([]);
  const anchors = path.join(directory, "locks", "capture-jobs");
  for (const name of fs.readdirSync(anchors)) {
    const release = acquireFileLockSync(path.join(anchors, name));
    release();
  }
  spy.mockRestore();
  const result = await captureAsync(
    "https://retry.example/paper.pdf",
    testProfileCapability("reader"),
  );
  expect(listCaptureJobs("reader")).toMatchObject([
    { slug: result.slug, state: "analyzing" },
  ]);
});
