import { configureTestAgent } from "../../helpers/agent";
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
let webCalls: Array<{ name: string; argumentsValue: unknown }> = [];
let searchFailure = false;

beforeEach(async () => {
  webCalls = [];
  searchFailure = false;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-api-web-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  await configureTestAgent(
    { provider: "openai" },
    { apiKey: "test-openai-key" },
  );
  vi.resetModules();
  vi.stubGlobal("fetch", async () => {
    throw new Error("Unexpected HTTP request");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface WireChoice {
  index?: number;
  message?: { content?: string | null; tool_calls?: unknown[] };
  delta?: { content?: string; tool_calls?: unknown[] };
  finish_reason?: string | null;
}
function eventResponse(events: unknown[]): Response {
  return new Response(
    events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
function responseBody(value: unknown) {
  const result = value as {
    status?: string;
    output_text?: string;
    error?: unknown;
  };
  return {
    id: "response1",
    status: result.status ?? "completed",
    error: result.error,
    ...(result.status === "incomplete"
      ? { incomplete_details: { reason: "max_output_tokens" } }
      : {}),
    output: [
      {
        type: "message",
        id: "message1",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: result.output_text ?? "",
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}
function mockOpenAI(
  responseCalls: ApiCall[],
  chatCalls: ApiCall[],
  chatResponses: unknown[] = [],
  responseEvents: Array<{
    type: string;
    delta?: string;
    response?: unknown;
  }> = [{ type: "response.output_text.delta", delta: "streamed answer" }],
  responseResult: unknown = { output_text: "openai answer" },
): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/search") {
        webCalls.push({
          name: "web_search",
          argumentsValue: { query: url.searchParams.get("q") },
        });
        if (searchFailure) return new Response("", { status: 503 });
        return Response.json({
          results: [
            {
              title: "EDGS",
              url: "https://example.test/repo",
              content: "Source",
            },
          ],
        });
      }
      const body = (await request.json()) as ApiCall;
      if (request.url.endsWith("/responses")) {
        responseCalls.push(body);
        if (!body.stream) return Response.json(responseBody(responseResult));
        const events: unknown[] = [...responseEvents];
        if (
          !responseEvents.some((event) =>
            ["error", "response.failed", "response.incomplete"].includes(
              event.type,
            ),
          )
        ) {
          events.push({
            type: "response.completed",
            response: responseBody({
              output_text: responseEvents
                .map((event) => event.delta ?? "")
                .join(""),
            }),
          });
        }
        return eventResponse(events);
      }
      if (!request.url.endsWith("/chat/completions"))
        throw new Error("Unexpected provider URL");
      chatCalls.push(body);
      const value = chatResponses.shift();
      if (!value || typeof value !== "object")
        throw new Error("No mocked chat response remains.");
      if (Symbol.asyncIterator in value) {
        const chunks: unknown[] = [];
        let hasTools = false;
        for await (const chunk of value as AsyncIterable<{
          choices: WireChoice[];
        }>) {
          hasTools ||= chunk.choices.some((choice) =>
            Boolean(choice.delta?.tool_calls?.length),
          );
          chunks.push({
            id: "chat1",
            object: "chat.completion.chunk",
            choices: chunk.choices.map((choice) => ({ index: 0, ...choice })),
          });
        }
        chunks.push({
          id: "chat1",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: hasTools ? "tool_calls" : "stop",
            },
          ],
        });
        return eventResponse(chunks);
      }
      const completion = value as { choices: WireChoice[] };
      return Response.json({
        id: "chat1",
        object: "chat.completion",
        choices: completion.choices.map((choice) => ({
          index: 0,
          finish_reason: choice.message?.tool_calls?.length
            ? "tool_calls"
            : "stop",
          ...choice,
        })),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  );
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
    const toolCalls = webCalls;
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
    await configureTestAgent({ provider: "ollama", model: "qwen3:4b" });
    const { ollamaProvider } = await import("@/lib/agent/api");

    await expect(
      ollamaProvider.execute({
        system: "",
        prompt: "Find the repository.",
        allowWeb: true,
      }),
    ).resolves.toBe("Verified repository code.");

    expect(toolCalls).toEqual([
      { name: "web_search", argumentsValue: { query: "EDGS GitHub" } },
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
    await configureTestAgent({ provider: "ollama", model: "qwen3:4b" });
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
    searchFailure = true;
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
    await configureTestAgent({ provider: "ollama", model: "qwen3:4b" });
    const { ollamaProvider } = await import("@/lib/agent/api");

    const answer = await ollamaProvider.execute({
      system: "",
      prompt: "Find the repository.",
      allowWeb: true,
    });

    expect(answer).toContain("I could not verify the repository.");
    expect(answer).toContain(
      "Web access warning: web_search failed: web_search failed with status 503",
    );
    expect(chatCalls[1].messages?.at(-1)?.content).toContain(
      "web_search failed with status 503",
    );
  });

  it("streams local answers after accumulating streamed tool-call arguments", async () => {
    const toolCalls = webCalls;
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
    await configureTestAgent({ provider: "ollama", model: "qwen3:4b" });
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
      { name: "web_search", argumentsValue: { query: "EDGS" } },
    ]);
  });

  it("forces a tool-free final answer after the local tool-round limit", async () => {
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
    await configureTestAgent({ provider: "ollama", model: "qwen3:4b" });
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
    await configureTestAgent({ provider: "ollama", model: "qwen3:4b" });
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

    await expect(consume()).rejects.toThrow("provider failed");
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
