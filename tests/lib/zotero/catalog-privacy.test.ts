import fs from "node:fs";
import asyncFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTestProfile,
  revokeTestProfile,
  testProfileCapability,
} from "../../helpers/access";
import {
  readZoteroCatalog,
  writeZoteroCatalog,
  type ZoteroCatalog,
} from "@/lib/capture/zotero-catalog";

let directory: string;
const empty: ZoteroCatalog = {
  formatVersion: 1,
  libraries: {},
  associations: {},
};
beforeEach(async () => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-catalog-privacy-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Reader");
  await writeZoteroCatalog(testProfileCapability("reader"), empty);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("rejects private catalog bytes read before profile revocation", async () => {
  const capability = testProfileCapability("reader");
  const file = path.join(directory, "users", "reader", "zotero-catalog.json");
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const original = asyncFs.readFile;
  vi.spyOn(asyncFs, "readFile").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (String(args[0]) === file) {
      entered();
      await paused;
    }
    return result;
  });
  const reading = readZoteroCatalog(capability);
  const rejected = expect(reading).rejects.toMatchObject({
    code: "unauthorized",
  });
  await started;
  const erase = await revokeTestProfile("reader");
  resume();
  await rejected;
  await erase();
});

it("rejects publication after revocation and removes its temporary catalog", async () => {
  const capability = testProfileCapability("reader");
  const file = path.join(directory, "users", "reader", "zotero-catalog.json");
  const before = fs.readFileSync(file, "utf8");
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const original = asyncFs.writeFile;
  vi.spyOn(asyncFs, "writeFile").mockImplementation(async (...args) => {
    await original(...args);
    if (String(args[0]).startsWith(file + ".")) {
      entered();
      await paused;
    }
  });
  const writing = writeZoteroCatalog(capability, {
    ...empty,
    libraries: {
      "user:1": {
        target: { type: "user", id: "1", name: "New catalog" },
        lastVersion: 0,
        refreshedAt: null,
        collections: [],
        records: {},
      },
    },
  });
  const rejected = expect(writing).rejects.toMatchObject({
    code: "unauthorized",
  });
  await started;
  const erase = await revokeTestProfile("reader");
  resume();
  await rejected;
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);
  await erase();
});
