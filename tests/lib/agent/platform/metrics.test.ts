import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AgentMetrics,
  profileMetricConsumer,
} from "@/lib/agent/platform/metrics";
import { provider } from "@/lib/agent/api";
import { configureTestAgent } from "../../../helpers/agent";
import {
  createTestProfile,
  revokeTestProfile,
  testProfileCapability,
  testAccess,
} from "../../../helpers/access";

let directory: string;
let metrics: AgentMetrics;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-metrics-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Reader");
  metrics = new AgentMetrics(directory);
});
afterEach(async () => {
  await metrics.collector.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(directory, { recursive: true, force: true });
});
function record(id: string, consumerId: string) {
  expect(
    metrics.collector.record({
      version: 1,
      id,
      timestamp: Date.now(),
      kind: "execution",
      operation: "generate",
      outcome: "success",
      consumerId,
      inputTokens: null,
      estimatedCost: null,
    }),
  ).toBe(true);
}

it("isolates profile usage from another profile and instance activity", async () => {
  const reader = testProfileCapability("reader");
  await createTestProfile("Other");
  const other = testProfileCapability("other");
  record("reader", profileMetricConsumer(reader));
  record("other", profileMetricConsumer(other));
  record("background", "instance");
  await metrics.collector.flush();
  expect((await metrics.queryProfile(reader)).map((event) => event.id)).toEqual(
    ["reader"],
  );
  expect((await metrics.queryProfile(other)).map((event) => event.id)).toEqual([
    "other",
  ]);
  expect(await metrics.queryInstance()).toHaveLength(3);
});

it("erases persisted usage and prevents buffered events from resurrecting a deleted profile", async () => {
  const old = testProfileCapability("reader");
  record("persisted", profileMetricConsumer(old));
  await metrics.collector.flush();
  record("buffered", profileMetricConsumer(old));
  const cleanup = await revokeTestProfile("reader");
  await cleanup();
  await createTestProfile("Reader");
  await metrics.collector.flush();
  expect(await metrics.queryInstance()).toEqual([]);
  expect(metrics.status().revoked).toBe(1);
  await expect(metrics.queryProfile(old)).rejects.toMatchObject({
    code: "unauthorized",
  });
  expect(await metrics.queryProfile(testProfileCapability("reader"))).toEqual(
    [],
  );
});

it("rejects invalid ownership without discarding valid events in the same batch", async () => {
  record("unowned", "unexpected");
  record("valid", profileMetricConsumer(testProfileCapability("reader")));
  await metrics.collector.flush();
  expect(metrics.status()).toMatchObject({ failures: 0, invalidOwnership: 1 });
  expect((await metrics.queryInstance()).map((event) => event.id)).toEqual([
    "valid",
  ]);
});

it("retains the erasure tombstone until metric deletion succeeds", async () => {
  record("persisted", profileMetricConsumer(testProfileCapability("reader")));
  await metrics.collector.flush();
  const cleanup = await revokeTestProfile("reader");
  const file = path.join(directory, "metrics.json");
  const backup = path.join(directory, "saved-metrics.json");
  fs.renameSync(file, backup);
  fs.mkdirSync(file);
  try {
    await expect(cleanup()).rejects.toThrow();
    const { identity } = await testAccess();
    expect((await identity.read()).erasures).toEqual([
      expect.objectContaining({ username: "reader" }),
    ]);
  } finally {
    fs.rmdirSync(file);
    fs.renameSync(backup, file);
  }
  await cleanup();
  expect(await metrics.queryInstance()).toEqual([]);
  const { identity } = await testAccess();
  expect((await identity.read()).erasures).toEqual([]);
});

it("persists reported API usage for the admitted profile before returning its answer", async () => {
  await configureTestAgent(
    { provider: "openai", model: "test-model" },
    { apiKey: "test-only-key" },
  );
  vi.stubGlobal("fetch", async () =>
    Response.json({
      id: "response1",
      status: "completed",
      output: [
        {
          type: "message",
          id: "message1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    }),
  );
  const capability = testProfileCapability("reader");
  expect(
    await provider("openai").execute({
      system: "Private instructions",
      prompt: "Private question",
      metricOwner: capability,
    }),
  ).toBe("answer");
  const events = await metrics.queryProfile(capability);
  expect(events).toMatchObject([
    {
      outcome: "success",
      provider: "openai",
      inputTokens: 12,
      outputTokens: 3,
      estimatedCost: null,
      consumerId: profileMetricConsumer(capability),
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("Private");
  expect(JSON.stringify(events)).not.toContain("test-only-key");
});

it("records attachment preparation failure without claiming provider token usage", async () => {
  await configureTestAgent(
    { provider: "openai", model: "test-model" },
    { apiKey: "test-only-key" },
  );
  const capability = testProfileCapability("reader");
  await expect(
    provider("openai").execute({
      system: "",
      prompt: "question",
      metricOwner: capability,
      images: [path.join(directory, "missing-private-image.png")],
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const events = await metrics.queryProfile(capability);
  expect(events).toMatchObject([
    {
      operation: "prepare",
      outcome: "error",
      inputTokens: null,
      outputTokens: null,
      estimatedCost: null,
      errorCode: "preparation_failed",
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("missing-private-image");
});
