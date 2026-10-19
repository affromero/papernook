import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureTestAgent } from "../../../helpers/agent";

let directory: string;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-catalog-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
  await configureTestAgent(
    { provider: "google" },
    { apiKey: "test-google-key" },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("uses a catalog provider with its own credentials and native web search", async () => {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.url.includes("/v1beta/models?"))
        return Response.json({ models: [{ name: "models/gemini-2.5-flash" }] });
      return Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Grounded answer" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
      });
    },
  );
  const { getProvider, providerIds, providerStatus } =
    await import("@/lib/agent/registry");
  expect(providerIds()).toContain("google");
  expect(await providerStatus("google")).toBe("ready");
  expect(
    await getProvider().execute({
      system: "Explain clearly",
      prompt: "Find a paper",
      allowWeb: true,
    }),
  ).toBe("Grounded answer");
  const request = requests.at(-1)!;
  expect(request.url).toContain(
    "generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
  expect(request.headers.get("x-goog-api-key")).toBe("test-google-key");
  expect(await request.json()).toMatchObject({ tools: [{ googleSearch: {} }] });
});

it("reports a missing catalog credential before generation", async () => {
  await configureTestAgent({ provider: "google" }, { apiKey: null });
  const { providerStatus } = await import("@/lib/agent/registry");
  expect(await providerStatus("google")).toBe("no_key");
});

it.each([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
])("uses %s with adaptive thinking and native web search", async (model) => {
  await configureTestAgent(
    { provider: "anthropic", model },
    { apiKey: "test-claude-key" },
  );
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return Response.json({
        id: "message1",
        type: "message",
        role: "assistant",
        model,
        content: [
          { type: "thinking", thinking: "", signature: "thinking-signature" },
          { type: "text", text: "Grounded Claude answer" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  );
  const { getProvider } = await import("@/lib/agent/registry");
  expect(
    await getProvider().execute({
      system: "Explain clearly",
      prompt: "Find a paper",
      allowWeb: true,
    }),
  ).toBe("Grounded Claude answer");
  const request = requests.at(-1)!;
  expect(request.url).toBe("https://api.anthropic.com/v1/messages");
  expect(request.headers.get("x-api-key")).toBe("test-claude-key");
  const body = await request.json();
  expect(body).toMatchObject({
    model,
    thinking: { type: "adaptive" },
    tools: expect.arrayContaining([
      expect.objectContaining({ name: "web_search" }),
    ]),
  });
  expect(body).not.toHaveProperty("temperature");
});
