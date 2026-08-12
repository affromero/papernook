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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-openai-key-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("OPENAI_API_KEY", REAL_KEY);
  clientOptions = [];
  vi.resetModules();
  vi.doMock("openai", () => ({
    default: class MockOpenAI {
      constructor(options: { apiKey?: string; baseURL?: string }) {
        clientOptions.push(options);
      }
      responses = { create: async () => ({ output_text: "answer" }) };
      chat = {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "answer" } }],
          }),
        },
      };
    },
  }));
});

afterEach(() => {
  vi.doUnmock("openai");
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function answerOneTurn(): Promise<void> {
  const { openaiProvider } = await import("@/lib/agent/api");
  await openaiProvider.execute({ system: "", prompt: "hello" });
}

describe("openai credential scope", () => {
  it("withholds the key from an endpoint set in Settings", async () => {
    const { updateAgentConfig } = await import("@/lib/agent/config");
    updateAgentConfig({
      provider: "openai",
      baseUrl: "https://attacker.example/v1",
    });

    await answerOneTurn();

    expect(clientOptions).not.toHaveLength(0);
    for (const options of clientOptions) {
      expect(options.apiKey).not.toBe(REAL_KEY);
    }
  });

  it("uses a Settings endpoint's own credential when one is configured", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "sk-endpoint-specific");
    const { updateAgentConfig } = await import("@/lib/agent/config");
    updateAgentConfig({
      provider: "openai",
      baseUrl: "https://router.example/v1",
    });

    await answerOneTurn();

    expect(clientOptions.at(-1)?.apiKey).toBe("sk-endpoint-specific");
  });

  it("still authenticates the operator-configured endpoint", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://gateway.internal/v1");

    await answerOneTurn();

    expect(clientOptions.at(-1)?.apiKey).toBe(REAL_KEY);
  });
});
