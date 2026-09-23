import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestProfile, mockTestSession } from "../../helpers/access";

let directory: string | undefined;
afterEach(() => {
  vi.doUnmock("next/headers");
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

it("updates authorization on an already imported route when browser credentials change", async () => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-browser-session-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Owner", undefined, true);
  await createTestProfile("Reader");
  await mockTestSession("owner");
  const route = await import("@/app/api/v1/session/route");
  expect((await (await route.GET()).json()).profile).toMatchObject({
    username: "owner",
    isAdmin: true,
  });
  await mockTestSession("reader");
  expect((await (await route.GET()).json()).profile).toMatchObject({
    username: "reader",
    isAdmin: false,
  });
  await mockTestSession(null);
  expect(await (await route.GET()).json()).toEqual({ profile: null });
});
