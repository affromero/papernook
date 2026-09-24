import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestProfile,
  mockTestSession,
  testAccess,
} from "../../../helpers/access";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-model-route-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.resetModules();
  await testAccess("Admin");
  const { configureTestAgent } = await import("../../../helpers/agent");
  await configureTestAgent({ provider: "codex" });
});

afterEach(() => {
  vi.doUnmock("next/headers");
  vi.doUnmock("node:child_process");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it("keeps saved secrets write-only and rejects stale credential revisions", async () => {
  await createTestProfile("Admin", undefined, true);
  await mockTestSession("admin");
  const { GET, PUT } = await import("@/app/api/v1/agent/model/route");
  const initial = await (
    await GET(new NextRequest("http://localhost/api/v1/agent/model"))
  ).json();
  const save = (body: unknown) =>
    PUT(
      new NextRequest("http://localhost/api/v1/agent/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const saved = await save({
    provider: "openai",
    revision: initial.revision,
    credentials: { apiKey: "fixture-private-key" },
  });
  expect(saved.status).toBe(200);
  const body = await saved.json();
  expect(JSON.stringify(body)).not.toContain("fixture-private-key");
  expect(body.credentialFields).toContainEqual(
    expect.objectContaining({
      id: "apiKey",
      source: "stored",
      configured: true,
    }),
  );
  const stale = await save({
    revision: initial.revision,
    credentials: { apiKey: "stale-private-key" },
  });
  expect(stale.status).toBe(409);
  await createTestProfile("Member");
  await mockTestSession("member");
  const member = await (
    await GET(new NextRequest("http://localhost/api/v1/agent/model"))
  ).json();
  expect(member).not.toHaveProperty("credentialFields");
  expect(member).not.toHaveProperty("descriptor");
});

it("reports invalid credential fields without changing settings or exposing submitted values", async () => {
  await createTestProfile("Admin", undefined, true);
  await mockTestSession("admin");
  const { readAiState } = await import("@/lib/agent/config");
  const before = readAiState();
  const { PUT } = await import("@/app/api/v1/agent/model/route");
  const response = await PUT(
    new NextRequest("http://localhost/api/v1/agent/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        revision: before.revision,
        credentials: { unknownField: "private-submitted-value" },
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("private-submitted-value");
  expect(readAiState()).toEqual(before);
});

it.each(["change", "revoke"])(
  "revalidates configuration and admission after a delayed probe (%s)",
  async (action) => {
    await createTestProfile("Admin", undefined, true);
    const token = await mockTestSession("admin");
    vi.stubEnv("CLAUDE_HOME", tmpDir);
    vi.stubEnv("CODEX_HOME", path.join(tmpDir, "codex"));
    vi.stubEnv("CLAUDE_CODE_SSH_HOST", undefined);
    vi.stubEnv("CODEX_SSH_HOST", undefined);
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        const child = new EventEmitter();
        setImmediate(() => child.emit("close", 1));
        return child;
      },
    }));
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
        if (request.url.startsWith("https://old.example/")) {
          entered();
          await pending;
        }
        return Response.json({
          object: "list",
          data: [{ id: "old-model", object: "model" }],
          models: [],
        });
      },
    );
    const { readAiState, updateAgentConfig } =
      await import("@/lib/agent/config");
    await updateAgentConfig(
      {
        provider: "openai",
        model: "old-model",
        baseUrl: "https://old.example/v1",
      },
      { token: token!, expectedRevision: readAiState().revision },
    );
    const { GET } = await import("@/app/api/v1/agent/model/route");
    const response = GET(
      new NextRequest("http://localhost/api/v1/agent/model?probe=1"),
    );
    await started;
    if (action === "change")
      await updateAgentConfig(
        { provider: "anthropic", model: "new-model" },
        { token: token!, expectedRevision: readAiState().revision },
      );
    else await (await testAccess()).access.logout(token!);
    release();
    const result = await response;
    const body = await result.json();
    if (action === "revoke") {
      expect(result.status).toBe(401);
      expect(body).not.toHaveProperty("baseUrl");
      return;
    }
    expect(result.status).toBe(200);
    expect(body).toMatchObject({
      provider: "anthropic",
      model: "new-model",
      revision: readAiState().revision,
      liveList: false,
      baseUrl: null,
    });
    expect(body.suggestions).not.toContain("old-model");
    expect(body.discoveryError).toContain("changed during discovery");
  },
);

async function signedInRoute() {
  await createTestProfile("Admin", undefined, true);
  await mockTestSession("admin");
  vi.doMock("node:child_process", () => ({
    spawn: () => {
      throw new Error("Configuration requests must not start provider probes.");
    },
  }));
  return import("@/app/api/v1/agent/model/route");
}

describe("agent model settings route", () => {
  it("returns initial configuration without waiting for provider probes", async () => {
    const route = await signedInRoute();
    const response = await route.GET(
      new NextRequest("http://localhost/api/v1/agent/model"),
    );
    const body = (await response.json()) as {
      provider: string;
      statuses: Record<string, string>;
      suggestions: string[];
      effort: string | null;
      effortOptions: string[];
      webAccess: boolean;
      webCapable: boolean;
      credentialReloadAvailable: boolean;
    };

    expect(body.provider).toBe("codex");
    expect(body.suggestions).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(body.effort).toBeNull();
    expect(body.effortOptions).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(body.webAccess).toBe(true);
    expect(body.webCapable).toBe(true);
    expect(body.credentialReloadAvailable).toBe(false);
    expect(body.statuses).toMatchObject({
      google: "checking",
      openai: "checking",
      "claude-code": "checking",
    });
    expect(
      Object.values(body.statuses).every((status) => status === "checking"),
    ).toBe(true);
  });

  it("persists a selection without running provider probes", async () => {
    const route = await signedInRoute();
    const response = await route.PUT(
      new NextRequest("http://localhost/api/v1/agent/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-terra",
          effort: "high",
        }),
      }),
    );

    expect(response.ok).toBe(true);
    const { configuredEffort, configuredModel } =
      await import("@/lib/agent/config");
    expect(configuredModel()).toBe("gpt-5.6-terra");
    expect(configuredEffort()).toBe("high");
  });
});
