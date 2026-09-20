import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTestProfile,
  testAccess,
  testSession,
} from "../../../helpers/access";
import {
  readAiState,
  updateAgentConfig,
  selectDetectedProvider,
} from "@/lib/agent/config";
import { apiCredentials } from "@/lib/agent/api";
import { providerStatus } from "@/lib/agent/registry";
import { listOfferedModels } from "@/lib/agent/models";

let directory: string;
let token: string;
it("keeps rotated credentials and newer discovery results separate from a delayed old probe", async () => {
  await updateAgentConfig(
    { provider: "openai", baseUrl: "https://discovery.example/v1" },
    { token, expectedRevision: readAiState().revision },
    {
      apiKey: "old-fixture-key",
      compatibleApiKey: "old-fixture-key",
    },
  );
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const old =
        request.headers.get("authorization") === "Bearer old-fixture-key";
      if (old) {
        entered();
        await pending;
      } else
        expect(request.headers.get("authorization")).toBe(
          "Bearer new-fixture-key",
        );
      return Response.json({
        data: [{ id: old ? "old-model" : "new-model", object: "model" }],
        object: "list",
      });
    },
  );
  const snapshot = readAiState();
  const old = listOfferedModels("openai", snapshot);
  await started;
  await updateAgentConfig(
    {},
    { token, expectedRevision: readAiState().revision },
    {
      apiKey: "new-fixture-key",
      compatibleApiKey: "new-fixture-key",
    },
  );
  expect((await listOfferedModels("openai")).models).toEqual(["new-model"]);
  release();
  expect((await old).models).toEqual(["old-model"]);
  expect((await listOfferedModels("openai")).models).toEqual(["new-model"]);
});
it.each(["openai", "anthropic"] as const)(
  "recognizes stored %s credentials without environment keys",
  async (provider) => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_BASE_URL", undefined);
    vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
    vi.stubGlobal("fetch", async () => Response.json({ data: [] }));
    await updateAgentConfig(
      { provider },
      { token, expectedRevision: readAiState().revision },
      { apiKey: "stored-fixture-key" },
    );
    expect(await providerStatus(provider)).toBe("ready");
    fs.unlinkSync(path.join(directory, "provider-credentials.key"));
    await expect(providerStatus(provider)).rejects.toThrow("unavailable");
  },
);
it("keeps generic endpoint edits and selection coherent while encrypting credentials", async () => {
  await updateAgentConfig(
    { provider: "openai" },
    { token, expectedRevision: readAiState().revision },
    {
      baseUrl: "https://private.example/v1",
      compatibleApiKey: "private-test-secret",
      apiKey: "official-test-secret",
    },
  );
  expect(readAiState().selection.baseUrl).toBe("https://private.example/v1");
  expect(apiCredentials("openai").compatibleApiKey).toBe("private-test-secret");
  expect(JSON.stringify(readAiState())).not.toContain("private-test-secret");
  const before = readAiState();
  await expect(
    updateAgentConfig(
      { baseUrl: "https://other.example/v1" },
      { token, expectedRevision: before.revision },
      { baseUrl: "https://conflict.example/v1" },
    ),
  ).rejects.toThrow("Conflicting");
  expect(readAiState()).toEqual(before);
  await updateAgentConfig(
    { provider: "anthropic" },
    { token, expectedRevision: before.revision },
  );
  expect(apiCredentials("openai").baseUrl).toBeUndefined();
  expect(apiCredentials("openai").compatibleApiKey).toBeUndefined();
  expect(apiCredentials("openai").apiKey).toBe("official-test-secret");
});
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-ai-settings-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.stubEnv("AI_PROVIDER", undefined);
  await createTestProfile("Owner", undefined, true);
  token = await testSession("owner", true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("authenticates local readiness with the saved endpoint key and captured model", async () => {
  await updateAgentConfig(
    { provider: "vllm", model: "local-model" },
    { token, expectedRevision: readAiState().revision },
    {
      baseUrl: "https://local.example/v1",
      compatibleApiKey: "local-fixture-key",
    },
  );
  const captured = readAiState();
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://local.example/v1/models");
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-fixture-key",
      );
      await updateAgentConfig(
        { model: null },
        { token, expectedRevision: readAiState().revision },
      );
      return Response.json({ data: [] });
    },
  );
  expect(await providerStatus("vllm", captured)).toBe("ready");
  expect(readAiState().selection.model).toBeUndefined();
});

it("commits owner selection and revision together without writing the retired config file", async () => {
  const revision = readAiState().revision;
  await updateAgentConfig(
    {
      provider: "codex",
      model: "custom-model",
      effort: "high",
      webAccess: false,
    },
    { token, expectedRevision: revision },
  );
  expect(readAiState().selection).toEqual({
    provider: "codex",
    model: "custom-model",
    effort: "high",
    webAccess: false,
  });
  expect(readAiState().revision).toBe(revision + 1);
  expect(fs.existsSync(path.join(directory, "agent-config.json"))).toBe(false);
  await updateAgentConfig(
    { provider: "openai" },
    { token, expectedRevision: revision + 1 },
  );
  expect(readAiState().selection).toEqual({
    provider: "openai",
    webAccess: false,
  });
});

it("requires recent owner verification to change secrets", async () => {
  const { identity } = await testAccess();
  await identity.transact((state) => {
    for (const session of state.access.sessions)
      session.authenticatedAt = Date.now() - 6 * 60 * 1000;
  });
  const before = readAiState();
  await expect(
    updateAgentConfig(
      { provider: "openai" },
      { token, expectedRevision: before.revision },
      { apiKey: "fixture-secret" },
    ),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(readAiState()).toEqual(before);
});

it("explicitly removes unreadable credentials without replacing a missing encryption key", async () => {
  await updateAgentConfig(
    { provider: "openai" },
    { token, expectedRevision: readAiState().revision },
    { apiKey: "fixture-secret" },
  );
  fs.unlinkSync(path.join(directory, "provider-credentials.key"));
  expect(() => apiCredentials("openai")).toThrow();
  await updateAgentConfig(
    {},
    { token, expectedRevision: readAiState().revision },
    undefined,
    true,
  );
  expect(readAiState().credentials.providers).toEqual([]);
  expect(fs.existsSync(path.join(directory, "provider-credentials.key"))).toBe(
    false,
  );
});

it("rejects a revoked owner without changing configuration", async () => {
  const before = readAiState();
  await (await testAccess()).access.logout(token);
  await expect(
    updateAgentConfig(
      { provider: "codex" },
      { token, expectedRevision: before.revision },
    ),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(readAiState()).toEqual(before);
});

it("accepts one concurrent revision and reports the other save as a conflict", async () => {
  const revision = readAiState().revision;
  const results = await Promise.allSettled([
    updateAgentConfig(
      { model: "first" },
      { token, expectedRevision: revision },
    ),
    updateAgentConfig(
      { model: "second" },
      { token, expectedRevision: revision },
    ),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "conflict" },
  });
  expect(readAiState().revision).toBe(revision + 1);
  expect(["first", "second"]).toContain(readAiState().selection.model);
});

it("preserves automatic CLI setup while respecting a selection made during the probe", async () => {
  await selectDetectedProvider(token, "codex");
  const selected = readAiState();
  await selectDetectedProvider(token, "claude-code");
  expect(readAiState()).toEqual(selected);
  expect(selected.selection.provider).toBe("codex");
});

it("does not automatically select a CLI after owner revocation or over a configured provider", async () => {
  await updateAgentConfig(
    { provider: "anthropic" },
    { token, expectedRevision: readAiState().revision },
  );
  const before = readAiState();
  await selectDetectedProvider(token, "codex");
  expect(readAiState()).toEqual(before);
  await (await testAccess()).access.logout(token);
  await expect(selectDetectedProvider(token, "codex")).rejects.toMatchObject({
    code: "unauthorized",
  });
  expect(readAiState()).toEqual(before);
});
