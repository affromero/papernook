import { afterEach, expect, it, vi } from "vitest";
import {
  clearOfflineForAuthentication,
  listOffline,
  readOffline,
} from "@/lib/offline/storage";
afterEach(() => {
  vi.unstubAllGlobals();
});
it("allows authentication cleanup when IndexedDB is denied and keeps private downloads revoked", async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("dispatchEvent", () => true);
  await expect(clearOfflineForAuthentication()).resolves.toBeUndefined();
  expect(await listOffline()).toEqual([]);
  expect(await readOffline("conversation:private")).toBeNull();
});
it("retains revocation through a cookie when both IndexedDB and local storage are denied", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new DOMException("Denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("Denied", "SecurityError");
    },
  });
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("dispatchEvent", () => true);
  await expect(clearOfflineForAuthentication()).resolves.toBeUndefined();
  expect(await listOffline()).toEqual([]);
  expect(await readOffline("paper:private:source")).toBeNull();
});
