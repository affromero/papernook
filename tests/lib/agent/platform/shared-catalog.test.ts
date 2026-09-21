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
