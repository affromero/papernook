import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AgentMetrics,
  profileMetricConsumer,
} from "@/lib/agent/platform/metrics";
import {
  createTestProfile,
  mockTestSession,
  testProfileCapability,
  testAccess,
} from "../../../helpers/access";

let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-metric-route-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Admin", undefined, true);
  await createTestProfile("Reader");
  const metrics = new AgentMetrics(directory);
  for (const username of ["admin", "reader"])
    metrics.collector.record({
      version: 1,
      id: username,
      timestamp: Date.now(),
      kind: "execution",
      operation: "generate",
      outcome: "success",
      consumerId: profileMetricConsumer(testProfileCapability(username)),
    });
  await metrics.collector.close();
});
afterEach(() => {
  vi.doUnmock("next/headers");
  vi.resetModules();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function query(username: string | null, search = "") {
  await mockTestSession(username);
  const { GET } = await import("@/app/api/v1/agent/metrics/route");
  return GET(new NextRequest("http://localhost/api/v1/agent/metrics" + search));
}

it("requires authentication and prevents household members from reading instance usage", async () => {
  expect((await query(null)).status).toBe(401);
  expect((await query("reader", "?scope=instance")).status).toBe(403);
});

it("returns only the selected profile and prevents ownership filters", async () => {
  const response = await query("reader");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.json();
  expect(body.events.map((event: { id: string }) => event.id)).toEqual([
    "reader",
  ]);
  expect(body.diagnostics).toBeUndefined();
  expect((await query("reader", "?consumerId=profile:admin:1")).status).toBe(
    400,
  );
});

it("allows the owner to inspect bounded instance usage and diagnostics", async () => {
  const response = await query("admin", "?scope=instance&limit=1");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.events).toHaveLength(1);
  expect(body.diagnostics).toHaveProperty("missingOwner");
  expect((await query("admin", "?limit=1001")).status).toBe(400);
  expect((await query("admin", "?scope=profile&scope=instance")).status).toBe(
    400,
  );
});

it("withholds instance usage if the owner logs out while storage is being read", async () => {
  const token = await mockTestSession("admin");
  const { access } = await testAccess();
  const { GET } = await import("@/app/api/v1/agent/metrics/route");
  const read = promises.readFile.bind(promises);
  let revoked = false;
  const fault = vi
    .spyOn(promises, "readFile")
    .mockImplementation(async (...args) => {
      const value = await read(...args);
      if (args[0] === path.join(directory, "metrics.json") && !revoked) {
        revoked = true;
        await access.logout(token!);
      }
      return value;
    });
  syncBuiltinESMExports();
  try {
    const response = await GET(
      new NextRequest("http://localhost/api/v1/agent/metrics?scope=instance"),
    );
    expect(revoked).toBe(true);
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("events");
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
});
