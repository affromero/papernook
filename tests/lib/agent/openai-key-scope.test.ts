import { configureTestAgent } from "../../helpers/agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OPENAI_API_KEY authenticates api.openai.com. An admin can point the
 * provider at any endpoint from Settings, so the key must not follow it
 * there — that would hand the credential to whatever host was typed in.
 */

const REAL_KEY = "sk-real-openai-secret";

let tmpDir: string;
let clientOptions: Array<{ apiKey?: string; baseURL?: string }>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-openai-key-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  await configureTestAgent({ provider: "openai" }, { apiKey: REAL_KEY });
  clientOptions = [];
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      clientOptions.push({
        apiKey: request.headers.get("authorization")?.replace(/^Bearer /, ""),
        baseURL: request.url,
      });
      if (request.url.endsWith("/models"))
        return Response.json({
          object: "list",
          data: [{ id: "custom-model", object: "model" }],
        });
      if (request.url.endsWith("/responses"))
        return Response.json({
          id: "response1",
          status: "completed",
          output: [
            {
              type: "message",
              id: "message1",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "answer", annotations: [] },
              ],
            },
          ],
        });
      return Response.json({
        id: "chat1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "answer" },
            finish_reason: "stop",
          },
        ],
      });
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function answerOneTurn(): Promise<void> {
  const { openaiProvider } = await import("@/lib/agent/api");
  await openaiProvider.execute({ system: "", prompt: "hello" });
}

describe("openai credential scope", () => {
  it("authenticates readiness with the custom endpoint credential", async () => {
    await configureTestAgent(
      {
        provider: "openai",
        baseUrl: "https://models.example/v1",
      },
      { compatibleApiKey: "probe-endpoint-key" },
    );
    const { providerStatus } = await import("@/lib/agent/registry");
    expect(await providerStatus("openai")).toBe("ready");
    expect(clientOptions).toEqual([
      {
        apiKey: "probe-endpoint-key",
        baseURL: "https://models.example/v1/models",
      },
    ]);
  });

  it("uses the custom endpoint credential for model discovery", async () => {
    await configureTestAgent(
      {
        provider: "openai",
        baseUrl: "https://models.example/proxy/v1",
      },
      { compatibleApiKey: "model-endpoint-key" },
    );
    const { listOfferedModels } = await import("@/lib/agent/models");
    expect(await listOfferedModels("openai")).toEqual({
      models: ["custom-model"],
      live: true,
    });
    expect(clientOptions).toEqual([
      {
        apiKey: "model-endpoint-key",
        baseURL: "https://models.example/proxy/v1/models",
      },
    ]);
  });

  it("shows a safe discovery error without disclosing endpoint response details", async () => {
    await configureTestAgent(
      { provider: "openai", baseUrl: "https://models.example/v1" },
      { compatibleApiKey: "discovery-key" },
    );
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { message: REAL_KEY } }, { status: 401 }),
    );
    const { listOfferedModels } = await import("@/lib/agent/models");
    const result = await listOfferedModels("openai");
    expect(result.live).toBe(false);
    expect(result.discoveryError).toContain("Check the provider connection");
    expect(JSON.stringify(result)).not.toContain(REAL_KEY);
  });

  it("does not send the official key to an endpoint set in Settings", async () => {
    await configureTestAgent({
      provider: "openai",
      baseUrl: "https://attacker.example/v1",
    });

    await answerOneTurn();

    expect(clientOptions.at(-1)).toEqual({
      apiKey: "unused",
      baseURL: "https://attacker.example/v1/chat/completions",
    });
  });

  it("uses a Settings endpoint's own credential when one is configured", async () => {
    await configureTestAgent(
      {
        provider: "openai",
        baseUrl: "https://router.example/v1",
      },
      { compatibleApiKey: "sk-endpoint-specific" },
    );

    await answerOneTurn();

    expect(clientOptions.at(-1)?.apiKey).toBe("sk-endpoint-specific");
  });

  it("uses the stored provider credential for the default endpoint", async () => {
    await answerOneTurn();

    expect(clientOptions.at(-1)?.apiKey).toBe(REAL_KEY);
  });
});
