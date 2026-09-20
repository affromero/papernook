import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  startMetricRetention,
  stopMetricRetention,
  metricRetentionStatus,
} from "@/lib/agent/platform/metric-retention";
import {
  AgentMetrics,
  profileMetricConsumer,
} from "@/lib/agent/platform/metrics";
import {
  createTestProfile,
  testProfileCapability,
  revokeTestProfile,
} from "../../../helpers/access";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-retention-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
});
afterEach(async () => {
  await stopMetricRetention();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("physically removes expired metrics while preserving recent records without new AI activity", async () => {
  const event = {
    version: 1,
    kind: "execution",
    operation: "generate",
    outcome: "success",
    consumerId: "instance",
  };
  const file = path.join(directory, "metrics.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      events: [
        {
          ...event,
          id: "expired",
          timestamp: Date.now() - 31 * 24 * 60 * 60 * 1000,
        },
        { ...event, id: "recent", timestamp: Date.now() },
      ],
    }),
  );
  startMetricRetention();
  await vi.waitFor(() =>
    expect(metricRetentionStatus().lastSuccess).not.toBeNull(),
  );
  expect(
    JSON.parse(fs.readFileSync(file, "utf8")).events.map(
      (entry: { id: string }) => entry.id,
    ),
  ).toEqual(["recent"]);
  await stopMetricRetention();
  expect(metricRetentionStatus().running).toBe(false);
});

it("does not create runtime storage during production builds", async () => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build");
  startMetricRetention();
  await stopMetricRetention();
  expect(metricRetentionStatus().running).toBe(false);
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("reports a failed prune without destroying malformed storage or leaking its contents", async () => {
  const file = path.join(directory, "metrics.json");
  fs.writeFileSync(file, "private malformed contents");
  startMetricRetention();
  await vi.waitFor(() => expect(metricRetentionStatus().failures).toBe(1));
  expect(metricRetentionStatus()).toMatchObject({
    running: true,
    lastSuccess: null,
  });
  expect(fs.readFileSync(file, "utf8")).toBe("private malformed contents");
  expect(JSON.stringify(metricRetentionStatus())).not.toContain("private");
});

it("requires shutdown to finish before restarting and starts again afterward", async () => {
  startMetricRetention();
  const stopping = stopMetricRetention();
  expect(() => startMetricRetention()).toThrow("shutdown");
  await stopping;
  startMetricRetention();
  await vi.waitFor(() =>
    expect(metricRetentionStatus().lastSuccess).not.toBeNull(),
  );
  expect(metricRetentionStatus()).toMatchObject({
    running: true,
    failed: false,
  });
});

it("preserves erasure when pruning runs concurrently", async () => {
  await createTestProfile("Reader");
  const metrics = new AgentMetrics(directory);
  metrics.collector.record({
    version: 1,
    id: "private",
    timestamp: Date.now(),
    kind: "execution",
    operation: "generate",
    outcome: "success",
    consumerId: profileMetricConsumer(testProfileCapability("reader")),
  });
  await metrics.collector.close();
  const cleanup = await revokeTestProfile("reader");
  startMetricRetention();
  await Promise.all([cleanup(), stopMetricRetention()]);
  expect(await metrics.queryInstance()).toEqual([]);
  expect(
    JSON.parse(fs.readFileSync(path.join(directory, "metrics.json"), "utf8"))
      .events,
  ).toEqual([]);
});
