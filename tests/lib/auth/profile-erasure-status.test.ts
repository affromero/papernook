import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTestProfile,
  mockTestSession,
  mockHouseholdAdmission,
  revokeTestProfile,
  testAccess,
} from "../../helpers/access";

let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-erasure-status-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
  await createTestProfile("Owner", undefined, true);
  await createTestProfile("Reader");
  await revokeTestProfile("reader");
});
afterEach(() => {
  vi.doUnmock("next/headers");
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("shows persisted erasures to an authenticated owner with private cache control", async () => {
  await mockTestSession("owner");
  const { GET } = await import("@/app/api/v1/profiles/route");
  const response = await GET();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const { identity } = await testAccess();
  expect(await response.json()).toMatchObject({
    owner: true,
    erasures: {
      workerRunning: false,
      profiles: (await identity.read()).erasures.map((marker) => ({
        ...marker,
        status: "pending",
      })),
    },
  });
});

it("does not expose erasures to household admission or signed-out visitors", async () => {
  await mockHouseholdAdmission();
  const { GET } = await import("@/app/api/v1/profiles/route");
  const household = await (await GET()).json();
  expect(household.owner).toBe(false);
  expect(household).not.toHaveProperty("erasures");
  await mockTestSession(null);
  const signedOut = await (await GET()).json();
  expect(signedOut.owner).toBe(false);
  expect(signedOut).not.toHaveProperty("erasures");
});

it("does not expose erasures after the owner's session is revoked", async () => {
  const token = await mockTestSession("owner");
  const { identity, access } = await testAccess();
  await access.logout(token!);
  const { GET } = await import("@/app/api/v1/profiles/route");
  const response = await GET();
  expect(await response.json()).not.toHaveProperty("erasures");
  expect((await identity.read()).erasures).toHaveLength(1);
});
