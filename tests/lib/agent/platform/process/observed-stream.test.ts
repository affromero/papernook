import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeAgentStream } from "@/lib/agent/platform/observed-stream";
import { AgentMetrics } from "@/lib/agent/platform/metrics";
import {
  createTestProfile,
  testProfileCapability,
  testAccess,
} from "../../../../helpers/access";
import { executeCodex } from "@/lib/agent/codex";
import { executeClaudeCode } from "@/lib/agent/claude-code";

it.each([
  ["codex", executeCodex],
  ["claude-code", executeClaudeCode],
] as const)(
  "records %s configuration admission failure before launching a process",
  async (provider, execute) => {
    const capability = testProfileCapability("reader");
    const { identity } = await testAccess();
    await identity.transact((state) => {
      state.ai.imports = [];
    });
    await expect(
      execute({
        system: "",
        prompt: "private question",
        metricOwner: capability,
      }),
    ).rejects.toThrow("migration");
    const events = await new AgentMetrics(directory).queryProfile(capability);
    expect(events).toMatchObject([
      {
        provider,
        operation: "prepare",
        outcome: "error",
        inputTokens: null,
        outputTokens: null,
        errorCode: "preparation_failed",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private question");
  },
);

let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-observed-stream-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Reader");
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("awaits persistence despite cleanup failure and preserves the caller's thrown value", async () => {
  const capability = testProfileCapability("reader");
  const primary = new Error("caller stopped");
  const stream = observeAgentStream(
    "codex",
    { system: "", prompt: "", metricOwner: capability },
    () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: "answer" };
          },
          async return(): Promise<IteratorResult<string>> {
            throw new Error("cleanup failed");
          },
        };
      },
    }),
  );
  await stream.next();
  let release: () => void = () => {
    throw new Error("Gate not initialized");
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let readingMetrics = false;
  let settled = false;
  const read = promises.readFile.bind(promises);
  const fault = vi
    .spyOn(promises, "readFile")
    .mockImplementation(async (...args) => {
      if (args[0] === path.join(directory, "metrics.json")) {
        readingMetrics = true;
        await gate;
      }
      return read(...args);
    });
  syncBuiltinESMExports();
  const completion = stream
    .throw(primary)
    .then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await vi.waitFor(() => expect(readingMetrics).toBe(true));
    expect(settled).toBe(false);
  } finally {
    release();
    await completion;
    fault.mockRestore();
    syncBuiltinESMExports();
  }
  expect((await completion).error).toBe(primary);
  expect(
    await new AgentMetrics(directory).queryProfile(capability),
  ).toMatchObject([{ outcome: "error", errorCode: "cleanup_failed" }]);
});
