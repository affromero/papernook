import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-lock-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("filesystem operation locks", () => {
  it("does not let an old owner release a replacement lock", async () => {
    const { withZoteroLock, zoteroLockPath } =
      await import("@/lib/capture/zotero-lock");
    const key = "profile:andres";
    const lock = zoteroLockPath(key);

    await withZoteroLock(key, 0, async () => {
      fs.writeFileSync(
        path.join(lock, "owner.json"),
        JSON.stringify({ token: "replacement-owner" }),
      );
    });

    expect(fs.existsSync(lock)).toBe(true);
  });
});

describe("Zotero catalog limits", () => {
  it("rejects oversized metadata before serializing the full catalog", async () => {
    const { writeZoteroCatalog } = await import("@/lib/capture/zotero-catalog");
    const records: Record<
      string,
      {
        key: string;
        version: number;
        itemType: string;
        abstractNote: string;
      }
    > = {};
    const abstractNote = "x".repeat(50_000);
    for (let index = 0; index < 1_400; index += 1) {
      const key = `ITEM${String(index).padStart(6, "0")}`;
      records[key] = {
        key,
        version: 1,
        itemType: "journalArticle",
        abstractNote,
      };
    }

    await expect(
      writeZoteroCatalog("andres", {
        formatVersion: 1,
        libraries: {
          "user:1234567": {
            target: { type: "user", id: "1234567", name: "My Library" },
            lastVersion: 1,
            refreshedAt: null,
            collections: [],
            records,
          },
        },
        associations: {},
      }),
    ).rejects.toThrow("64 MB metadata limit");
    expect(
      fs.existsSync(
        path.join(tmpDir, "users", "andres", "zotero-catalog.json"),
      ),
    ).toBe(false);
  });
});
