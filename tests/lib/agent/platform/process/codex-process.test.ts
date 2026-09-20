import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeCodex, streamCodex } from "@/lib/agent/codex";
import { configureTestAgent } from "../../../../helpers/agent";
import {
  createTestProfile,
  testProfileCapability,
} from "../../../../helpers/access";
import { AgentMetrics } from "@/lib/agent/platform/metrics";

let directory: string;
function executable(body: string, complete = true) {
  fs.writeFileSync(
    path.join(directory, "codex"),
    `#!${process.execPath}\nconst answer = value => console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:String(value)}}));
    ${complete ? "process.on('beforeExit', () => console.log(JSON.stringify({type:'turn.completed',usage:{}})));" : ""}
    ${body}`,
    { mode: 0o700 },
  );
}
beforeEach(async () => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-codex-process-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.stubEnv("PATH", directory + path.delimiter + process.env.PATH);
  vi.stubEnv("CODEX_SSH_HOST", "");
  await configureTestAgent({ provider: "codex", effort: "xhigh" });
});

it.each([0, 1])(
  "persists final Codex usage without counting cache twice (exit %s)",
  async (exitCode) => {
    await createTestProfile("Reader");
    const capability = testProfileCapability("reader");
    executable(
      `console.log(JSON.stringify({type:'item.completed',item:{id:'tool',type:'command_execution',aggregated_output:'private tool output'}}));
    answer('answer');
    process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,cache_write_input_tokens:10,output_tokens:30,reasoning_output_tokens:20}}));
    process.exitCode=${exitCode};`,
      false,
    );
    const result = executeCodex({
      system: "",
      prompt: "private question",
      metricOwner: capability,
    });
    if (exitCode) await expect(result).rejects.toThrow("codex");
    else expect(await result).toBe("answer");
    const events = await new AgentMetrics(directory).queryProfile(capability);
    expect(events).toMatchObject([
      {
        inputTokens: 100,
        outputTokens: 30,
        cachedInputTokens: 40,
        cacheWriteTokens: 10,
        reasoningTokens: 20,
        outcome: exitCode ? "error" : "success",
        estimatedCost: null,
      },
    ]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private");
  },
);

it("keeps usage-limit guidance when Codex reports failure on JSON stdout", async () => {
  executable(
    `console.log(JSON.stringify({type:'turn.failed',error:{message:'usage limit reached'}}));`,
    false,
  );
  await expect(
    executeCodex({ system: "", prompt: "question" }),
  ).rejects.toThrow("usage limit");
});

it("rejects an answer whose successful process omitted terminal completion", async () => {
  executable(`answer('partial');`, false);
  await expect(
    executeCodex({ system: "", prompt: "question" }),
  ).rejects.toThrow("completion");
});

it("preserves execution and attachment cleanup failures together", async () => {
  vi.stubEnv("CODEX_SSH_HOST", "fixture.invalid");
  fs.writeFileSync(
    path.join(directory, "image.png"),
    Buffer.from([137, 80, 78, 71]),
  );
  fs.writeFileSync(
    path.join(directory, "scp"),
    `#!${process.execPath}\nprocess.exitCode=0;`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(directory, "ssh"),
    `#!${process.execPath}
    const command=process.argv.at(-1);
    if(command.startsWith("'mkdir'")) process.exitCode=0;
    else if(command.startsWith("'rm'")) {process.stderr.write('cleanup denied');process.exitCode=2;}
    else {process.stderr.write('usage limit reached');setTimeout(()=>process.exit(1),30);}
  `,
    { mode: 0o700 },
  );
  await expect(
    executeCodex({
      system: "",
      prompt: "question",
      images: [path.join(directory, "image.png")],
    }),
  ).rejects.toMatchObject({
    name: "AggregateError",
    errors: [
      expect.objectContaining({
        message: expect.stringContaining("usage limit"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("cleanup denied"),
      }),
    ],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("preserves configured effort, web selection and prompt input through the shared runner", async () => {
  executable(`let input = ''; process.stdin.on('data', value => input += value);
    process.stdin.on('end', () => answer(JSON.stringify({ args: process.argv.slice(2), input })));`);
  const local = JSON.parse(
    await executeCodex({ system: "rules", prompt: "question" }),
  );
  expect(local.input).toBe("rules\n\nquestion");
  expect(local.args).toEqual(
    expect.arrayContaining([
      'model_reasoning_effort="xhigh"',
      'web_search="disabled"',
    ]),
  );
  const web = JSON.parse(
    await executeCodex({ system: "", prompt: "search", allowWeb: true }),
  );
  expect(web.args).toContain('web_search="live"');
});

it("terminates the actual child before an aborted stream finishes", async () => {
  executable(`answer(process.pid); setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const stream = streamCodex({
    system: "",
    prompt: "question",
    signal: controller.signal,
  });
  const first = await stream.next();
  const pid = Number(first.value?.trim());
  expect(pid).toBeGreaterThan(0);
  const pending = stream.next();
  controller.abort(new Error("request cancelled"));
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(() => process.kill(pid, 0)).toThrow();
});

it("terminates the actual child when the consumer stops reading", async () => {
  executable(`answer(process.pid); setInterval(() => {}, 1000);`);
  const stream = streamCodex({ system: "", prompt: "question" });
  const first = await stream.next();
  const pid = Number(first.value?.trim());
  await stream.return(undefined);
  expect(() => process.kill(pid, 0)).toThrow();
});

it("rejects output beyond the character limit even when the child exits successfully", async () => {
  executable(`answer('excess output');`);
  await expect(
    executeCodex({ system: "", prompt: "question", maxOutputChars: 3 }),
  ).rejects.toMatchObject({ code: "output_limit" });
});

it("preserves actionable usage-limit diagnostics from a failing child", async () => {
  executable(
    `process.stderr.write('usage limit reached'); process.exitCode = 1;`,
  );
  await expect(
    executeCodex({ system: "", prompt: "question" }),
  ).rejects.toThrow("usage limit");
});

it("records one profile-owned execution with unknown CLI usage before returning", async () => {
  await createTestProfile("Reader");
  const capability = testProfileCapability("reader");
  executable(`answer('answer');`);
  expect(
    await executeCodex({
      system: "",
      prompt: "question",
      metricOwner: capability,
    }),
  ).toBe("answer");
  const events = await new AgentMetrics(directory).queryProfile(capability);
  expect(events).toMatchObject([
    {
      provider: "codex",
      operation: "cli",
      outcome: "success",
      firstOutputMs: expect.any(Number),
      inputTokens: null,
      outputTokens: null,
      estimatedCost: null,
    },
  ]);
});

it("interrupts a pending read on return and persists cancellation after child cleanup", async () => {
  await createTestProfile("Reader");
  const capability = testProfileCapability("reader");
  executable(`answer(process.pid); setInterval(() => {}, 1000);`);
  const stream = streamCodex({
    system: "",
    prompt: "question",
    metricOwner: capability,
  });
  const first = await stream.next();
  const pid = Number(first.value?.trim());
  const pending = stream.next();
  const returned = stream.return(undefined);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await expect(returned).resolves.toMatchObject({ done: true });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(
    await new AgentMetrics(directory).queryProfile(capability),
  ).toMatchObject([{ provider: "codex", outcome: "cancelled" }]);
});

it("uses the same captured model for execution and usage when settings change during execution", async () => {
  await createTestProfile("Reader");
  const capability = testProfileCapability("reader");
  await configureTestAgent({
    provider: "codex",
    model: "original-model",
    effort: "high",
  });
  executable(`answer(JSON.stringify(process.argv.slice(2)));`);
  const stream = streamCodex({
    system: "",
    prompt: "question",
    metricOwner: capability,
  });
  let answer = (await stream.next()).value!;
  await configureTestAgent({
    provider: "codex",
    model: "replacement-model",
    effort: "low",
  });
  for await (const chunk of stream) answer += chunk;
  const args = JSON.parse(answer);
  expect(args).toContain("original-model");
  expect(args).toContain('model_reasoning_effort="high"');
  expect(args).not.toContain("replacement-model");
  expect(
    await new AgentMetrics(directory).queryProfile(capability),
  ).toMatchObject([{ model: "original-model", outcome: "success" }]);
});
