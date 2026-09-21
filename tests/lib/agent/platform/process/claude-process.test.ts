import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  executeClaudeCode,
  streamClaudeCode,
  resetClaudeCredentialsCache,
} from "@/lib/agent/claude-code";
import { AgentMetrics } from "@/lib/agent/platform/metrics";
import { configureTestAgent } from "../../../../helpers/agent";
import {
  createTestProfile,
  testProfileCapability,
} from "../../../../helpers/access";

let directory: string;
function executable(body: string) {
  fs.writeFileSync(
    path.join(directory, "claude"),
    `#!${process.execPath}\n${body}`,
    { mode: 0o700 },
  );
}
beforeEach(async () => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-claude-process-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.stubEnv("PATH", directory + path.delimiter + process.env.PATH);
  vi.stubEnv("CLAUDE_HOME", directory);
  vi.stubEnv("CLAUDE_CODE_SSH_HOST", "");
  vi.stubEnv("CLAUDE_CODE_CREDENTIALS_JSON", "");
  resetClaudeCredentialsCache();
  await configureTestAgent({ provider: "claude-code", model: "test-model" });
  await createTestProfile("Reader");
});
afterEach(() => {
  resetClaudeCredentialsCache();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("persists terminal token totals for text execution without duplicating the answer", async () => {
  executable(`process.stdin.resume(); process.stdin.on('end', () => {
    if (!process.argv.includes('stream-json')) process.exit(2);
    console.log(JSON.stringify({type:'assistant', message:{content:[{type:'text',text:'  answer  '}],usage:{input_tokens:999}}}));
    console.log(JSON.stringify({type:'result',result:'  answer  ',usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:7}}));
  });`);
  const capability = testProfileCapability("reader");
  expect(
    await executeClaudeCode({
      system: "",
      prompt: "private question",
      metricOwner: capability,
    }),
  ).toBe("answer");
  const events = await new AgentMetrics(directory).queryProfile(capability);
  expect(events).toMatchObject([
    {
      provider: "claude-code",
      outcome: "success",
      inputTokens: 35,
      outputTokens: 7,
      cachedInputTokens: 20,
      cacheWriteTokens: 5,
      reasoningTokens: null,
      estimatedCost: null,
    },
  ]);
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("private question");
});

it("preserves image stdin and records only one execution when execute uses JSON streaming", async () => {
  executable(`let input = ''; process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const message = JSON.parse(input);
      if (message.message.content[0].source.type !== 'base64') process.exit(2);
      console.log(JSON.stringify({type:'result', result:'image answer'}));
    });`);
  const image = path.join(directory, "image.png");
  fs.writeFileSync(image, Buffer.from([137, 80, 78, 71]));
  const capability = testProfileCapability("reader");
  expect(
    await executeClaudeCode({
      system: "",
      prompt: "question",
      images: [image],
      metricOwner: capability,
    }),
  ).toBe("image answer");
  expect(
    await new AgentMetrics(directory).queryProfile(capability),
  ).toMatchObject([
    { provider: "claude-code", model: "test-model", outcome: "success" },
  ]);
});

it("kills the child and removes isolated credentials before cancelled streaming returns", async () => {
  fs.mkdirSync(path.join(directory, ".claude"));
  fs.writeFileSync(path.join(directory, ".claude", ".credentials.json"), "{}");
  executable(`console.log(JSON.stringify({type:'result', result:JSON.stringify({pid:process.pid, config:process.env.CLAUDE_CONFIG_DIR})}));
    setInterval(() => {}, 1000);`);
  const capability = testProfileCapability("reader");
  const stream = streamClaudeCode({
    system: "",
    prompt: "question",
    metricOwner: capability,
  });
  const first = await stream.next();
  const child = JSON.parse(first.value!);
  expect(fs.existsSync(child.config)).toBe(true);
  const pending = stream.next();
  const returned = stream.return(undefined);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await returned;
  expect(() => process.kill(child.pid, 0)).toThrow();
  expect(fs.existsSync(child.config)).toBe(false);
  expect(
    await new AgentMetrics(directory).queryProfile(capability),
  ).toMatchObject([{ outcome: "cancelled" }]);
});

it("rejects a failed exit even after partial streamed output", async () => {
  executable(
    `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'partial'}]}}));
    console.log(JSON.stringify({type:'result',result:'provider unavailable',is_error:true,usage:{input_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:3}})); process.stderr.write('provider unavailable'); process.exitCode=1;`,
  );
  const capability = testProfileCapability("reader");
  const stream = streamClaudeCode({
    system: "",
    prompt: "question",
    metricOwner: capability,
  });
  expect((await stream.next()).value).toBe("partial");
  await expect(stream.next()).rejects.toThrow("provider unavailable");
  expect(
    await new AgentMetrics(directory).queryProfile(capability),
  ).toMatchObject([{ outcome: "error", inputTokens: 10, outputTokens: 3 }]);
});

it("keeps later assistant messages after an earlier message streamed", async () => {
  executable(`const events = [
    {type:'stream_event',event:{type:'message_start',message:{id:'first'}}},
    {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'  first'}}},
    {type:'assistant',message:{id:'first',content:[{type:'text',text:'  first'}]}},
    {type:'assistant',message:{id:'second',content:[{type:'text',text:' second  '}]}},
    {type:'result',result:'  first second  '}
  ]; for (const event of events) console.log(JSON.stringify(event));`);
  let text = "";
  for await (const chunk of streamClaudeCode({
    system: "",
    prompt: "question",
  }))
    text += chunk;
  expect(text).toBe("  first second  ");
});

it("surfaces a quota failure even when the CLI exits successfully", async () => {
  executable(
    `console.log(JSON.stringify({type:'result',is_error:true,errors:['Usage limit reached. Try again later.']}));`,
  );
  await expect(
    executeClaudeCode({ system: "", prompt: "question" }),
  ).rejects.toThrow("Usage limit reached");
});

it("ignores non-object JSON records before valid streamed output", async () => {
  executable(
    `console.log('null'); console.log('42'); console.log('[]'); console.log(JSON.stringify({type:'result',result:'answer'}));`,
  );
  let text = "";
  for await (const chunk of streamClaudeCode({
    system: "",
    prompt: "question",
  }))
    text += chunk;
  expect(text).toBe("answer");
});

it.each([0, 1])(
  "preserves failed terminal usage without a trailing newline (exit %s)",
  async (exitCode) => {
    executable(`console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'partial'}]}}));
    process.stdout.write(JSON.stringify({type:'result',is_error:true,subtype:'error_during_execution',usage:{input_tokens:8,cache_read_input_tokens:2,cache_creation_input_tokens:0,output_tokens:4}}));
    process.exitCode=${exitCode};`);
    const capability = testProfileCapability("reader");
    await expect(
      executeClaudeCode({
        system: "",
        prompt: "question",
        metricOwner: capability,
      }),
    ).rejects.toThrow("claude-code");
    expect(
      await new AgentMetrics(directory).queryProfile(capability),
    ).toMatchObject([{ outcome: "error", inputTokens: 10, outputTokens: 4 }]);
  },
);
