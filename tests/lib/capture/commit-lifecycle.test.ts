import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTestProfile,
  revokeTestProfile,
  testProfileCapability,
} from "../../helpers/access";

let directory: string;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-commit-lifecycle-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.stubEnv("AI_PROVIDER", "");
  await createTestProfile("Reader");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("node:child_process");
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("removes its PDF when the profile is revoked during compression", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  vi.doMock("node:child_process", () => ({
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
      });
      finish = () => child.emit("close", 1);
      entered();
      return child;
    },
  }));
  const { capturePdf } = await import("@/lib/capture");
  const pending = capturePdf(Buffer.alloc(2 * 1024 * 1024), {
    sourceUrl: "https://example.com/paper.pdf",
    username: "reader",
    capability: testProfileCapability("reader"),
  });
  const rejected = expect(pending).rejects.toThrow(/profile was deleted/);
  await started;
  const erase = await revokeTestProfile("reader");
  finish();
  await rejected;
  expect(fs.readdirSync(path.join(directory, "library", "_inbox"))).toEqual([]);
  await erase();
});

it("removes renamed content after a metadata write fails and preserves other captures", async () => {
  vi.doMock("node:child_process", () => ({
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        kill: () => true,
      });
      queueMicrotask(() => child.emit("close", 1));
      return child;
    },
  }));
  const { capturePdf } = await import("@/lib/capture");
  const inbox = path.join(directory, "library", "_inbox");
  fs.mkdirSync(path.join(inbox, "unrelated"), { recursive: true });
  fs.writeFileSync(path.join(inbox, "unrelated", "keep.txt"), "Other capture");
  const original = fs.renameSync;
  const failure = Object.assign(new Error("Metadata storage failed"), {
    code: "EIO",
  });
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith("meta.json")) throw failure;
    return original(from, to);
  });
  await expect(
    capturePdf(Buffer.from("%PDF-1.4"), {
      sourceUrl: "https://example.com/title.pdf",
      username: "reader",
      capability: testProfileCapability("reader"),
      provisionalSlug: "original",
    }),
  ).rejects.toThrow(failure);
  expect(fs.readdirSync(inbox)).toEqual(["unrelated"]);
  expect(
    fs.readFileSync(path.join(inbox, "unrelated", "keep.txt"), "utf8"),
  ).toBe("Other capture");
});
