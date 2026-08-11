import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ApiCall {
  model?: string;
  tools?: Array<{ type: string }>;
  store?: boolean;
  stream?: boolean;
  messages?: Array<{ role: string; content?: unknown }>;
  tool_choice?: string;
  response_format?: { type: string };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-api-web-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("openai");
  vi.doUnmock("@/lib/agent/web/tools");
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mockOpenAI(
  responseCalls: ApiCall[],
  chatCalls: ApiCall[],
  chatResponses: unknown[] = [],
  responseEvents: unknown[] = [
    { type: "response.output_text.delta", delta: "streamed answer" },
  ],
  responseResult: unknown = { output_text: "openai answer" },
): void {
  vi.doMock("openai", () => ({
    default: class MockOpenAI {
      responses = {
        create: async (body: ApiCall) => {
          responseCalls.push(body);
          if (body.stream) {
            return {
              async *[Symbol.asyncIterator]() {
                for (const event of responseEvents) yield event;
              },
            };
          }
          return responseResult;
        },
      };

      chat = {
        completions: {
          create: async (body: ApiCall) => {
            chatCalls.push(body);
            const next = chatResponses.shift();
            if (!next) throw new Error("No mocked chat response remains.");
            return next;
          },
        },
      };
    },
  }));
}

describe("API provider web access", () => {
  it("uses the OpenAI Responses web-search tool without storing the response", async () => {
    const responseCalls: ApiCall[] = [];
    mockOpenAI(responseCalls, []);
    const { openaiProvider } = await import("@/lib/agent/api");

    await expect(
      openaiProvider.execute({
        system: "Ground answers in sources.",
        prompt: "Find the implementation repository.",
        allowWeb: true,
      }),
    ).resolves.toBe("openai answer");

    expect(responseCalls).toHaveLength(1);
    expect(responseCalls[0].store).toBe(false);
    expect(responseCalls[0].tools).toEqual([{ type: "web_search" }]);

    const chunks: string[] = [];
    for await (const chunk of openaiProvider.stream({
      system: "Ground answers in sources.",
      prompt: "Find the implementation repository.",
      allowWeb: true,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("streamed answer");
    expect(responseCalls[1].stream).toBe(true);
    expect(responseCalls[1].tools).toEqual([{ type: "web_search" }]);
  });

  it("runs local-model web tools until the model returns an answer", async () => {
    const toolCalls: Array<{ name: string; argumentsValue: unknown }> = [];
    vi.doMock("@/lib/agent/web/tools", () => ({
      WEB_TOOLS: [
        {
          type: "function",
          function: { name: "web_search", parameters: { type: "object" } },
        },
      ],
      executeWebTool: async (name: string, argumentsValue: unknown) => {
        toolCalls.push({ name, argumentsValue });
        return '[{"title":"EDGS","url":"https://example.test/repo"}]';
      },
    }));
    const chatCalls: ApiCall[] = [];
    mockOpenAI([], chatCalls, [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "search-1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: '{"query":"EDGS GitHub"}',
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "Verified repository code." } }] },
    ]);
    const config = await import("@/lib/agent/config");
    config.updateAgentConfig({ provider: "ollama", model: "qwen3:4b" });
    const { ollamaProvider } = await import("@/lib/agent/api");

    await expect(
      ollamaProvider.execute({
        system: "",
        prompt: "Find the repository.",
        allowWeb: true,
      }),
    ).resolves.toBe("Verified repository code.");

    expect(toolCalls).toEqual([
      { name: "web_search", argumentsValue: '{"query":"EDGS GitHub"}' },
    ]);
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[1].messages?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("does not send web tools when a local-model turn disables web access", async () => {
    const chatCalls: ApiCall[] = [];
    mockOpenAI([], chatCalls, [
      { choices: [{ message: { content: "Offline answer." } }] },
    ]);
    const config = await import("@/lib/agent/config");
    config.updateAgentConfig({ provider: "ollama", model: "qwen3:4b" });
    const { ollamaProvider } = await import("@/lib/agent/api");

    await expect(
      ollamaProvider.execute({
        system: "",
        prompt: "Answer.",
        allowWeb: false,
      }),
    ).resolves.toBe("Offline answer.");

    expect(chatCalls[0].tools).toBeUndefined();
  });

  it("returns a visible warning when a local web tool fails", async () => {
    vi.doMock("@/lib/agent/web/tools", () => ({
      WEB_TOOLS: [{ type: "function", function: { name: "web_search" } }],
      executeWebTool: async () => {
        throw new Error("search service unavailable");
      },
    }));
    const chatCalls: ApiCall[] = [];
    mockOpenAI([], chatCalls, [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "search-1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: '{"query":"EDGS"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { message: { content: "I could not verify the repository." } },
        ],
      },
    ]);
    const config = await import("@/lib/agent/config");
    config.updateAgentConfig({ provider: "ollama", model: "qwen3:4b" });
    const { ollamaProvider } = await import("@/lib/agent/api");

    const answer = await ollamaProvider.execute({
      system: "",
      prompt: "Find the repository.",
      allowWeb: true,
    });

    expect(answer).toContain("I could not verify the repository.");
    expect(answer).toContain(
      "Web access warning: web_search failed: search service unavailable",
    );
    expect(chatCalls[1].messages?.at(-1)?.content).toContain(
      "search service unavailable",
    );
  });

  it("streams local answers after accumulating streamed tool-call arguments", async () => {
    const toolCalls: Array<{ name: string; argumentsValue: unknown }> = [];
    vi.doMock("@/lib/agent/web/tools", () => ({
      WEB_TOOLS: [{ type: "function", function: { name: "web_search" } }],
      executeWebTool: async (name: string, argumentsValue: unknown) => {
        toolCalls.push({ name, argumentsValue });
        return "[]";
      },
    }));
    const firstStream = {
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "search-1",
                    type: "function",
                    function: { name: "web_search", arguments: '{"query":' },
                  },
                ],
              },
            },
          ],
        };
        yield {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"EDGS"}' } }],
              },
            },
          ],
        };
      },
    };
    const answerStream = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "Verified " } }] };
        yield { choices: [{ delta: { content: "repository." } }] };
      },
    };
    const chatCalls: ApiCall[] = [];
    mockOpenAI([], chatCalls, [firstStream, answerStream]);
    const config = await import("@/lib/agent/config");
    config.updateAgentConfig({ provider: "ollama", model: "qwen3:4b" });
    const { ollamaProvider } = await import("@/lib/agent/api");

    const chunks: string[] = [];
    for await (const chunk of ollamaProvider.stream({
      system: "",
      prompt: "Find the repository.",
      allowWeb: true,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Verified ", "repository."]);
    expect(toolCalls).toEqual([
      { name: "web_search", argumentsValue: '{"query":"EDGS"}' },
    ]);
  });

  it("forces a tool-free final answer after the local tool-round limit", async () => {
    vi.doMock("@/lib/agent/web/tools", () => ({
      WEB_TOOLS: [{ type: "function", function: { name: "web_search" } }],
      executeWebTool: async () => "[]",
    }));
    const toolResponses = Array.from({ length: 6 }, (_, index) => ({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: `search-${index}`,
                type: "function",
                function: { name: "web_search", arguments: '{"query":"EDGS"}' },
              },
            ],
          },
        },
      ],
    }));
    const chatCalls: ApiCall[] = [];
    mockOpenAI([], chatCalls, [
      ...toolResponses,
      { choices: [{ message: { content: "Final answer." } }] },
    ]);
    const config = await import("@/lib/agent/config");
    config.updateAgentConfig({ provider: "ollama", model: "qwen3:4b" });
    const { ollamaProvider } = await import("@/lib/agent/api");

    const answer = await ollamaProvider.execute({
      system: "",
      prompt: "Find the repository.",
      allowWeb: true,
    });

    expect(chatCalls).toHaveLength(7);
    expect(chatCalls[6].tools).toBeUndefined();
    expect(answer).toContain("Final answer.");
    expect(answer).toContain("web tool limit reached (6 rounds)");
  });

  it("applies JSON response formatting only to the tool-free final request", async () => {
    const chatCalls: ApiCall[] = [];
    mockOpenAI([], chatCalls, [
      { choices: [{ message: { content: "draft" } }] },
      { choices: [{ message: { content: '{"result":"final"}' } }] },
    ]);
    const config = await import("@/lib/agent/config");
    config.updateAgentConfig({ provider: "ollama", model: "qwen3:4b" });
    const { ollamaProvider } = await import("@/lib/agent/api");

    await expect(
      ollamaProvider.execute({
        system: "Return JSON.",
        prompt: "Classify this paper.",
        allowWeb: true,
        responseFormat: "json_object",
      }),
    ).resolves.toBe('{"result":"final"}');

    expect(chatCalls[0].response_format).toBeUndefined();
    expect(chatCalls[1].response_format).toEqual({ type: "json_object" });
    expect(chatCalls[1].tools).toBeUndefined();
  });

  it("surfaces OpenAI streaming failures", async () => {
    mockOpenAI(
      [],
      [],
      [],
      [
        {
          type: "response.failed",
          response: { error: { message: "upstream unavailable" } },
        },
      ],
    );
    const { openaiProvider } = await import("@/lib/agent/api");

    const consume = async () => {
      for await (const chunk of openaiProvider.stream({
        system: "",
        prompt: "Search.",
        allowWeb: true,
      })) {
        void chunk;
      }
    };

    await expect(consume()).rejects.toThrow("openai: upstream unavailable");
  });

  it("surfaces incomplete non-streaming OpenAI responses", async () => {
    mockOpenAI([], [], [], undefined, {
      status: "incomplete",
      output_text: "partial answer",
    });
    const { openaiProvider } = await import("@/lib/agent/api");

    await expect(
      openaiProvider.execute({
        system: "",
        prompt: "Search.",
        allowWeb: true,
      }),
    ).rejects.toThrow("openai: response incomplete");
  });
});
