import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-model-route-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.stubEnv("AI_PROVIDER", "codex");
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("node:child_process");
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function signedInRoute() {
  const users = await import("@/lib/auth/users");
  const admin = users.createProfile("Admin");
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => admin,
  }));
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
    };

    expect(body.provider).toBe("codex");
    expect(body.suggestions).toEqual(["gpt-5.5", "gpt-5.5-mini"]);
    expect(Object.values(body.statuses)).toEqual(Array(7).fill("checking"));
  });

  it("persists a selection without running provider probes", async () => {
    const route = await signedInRoute();
    const response = await route.PUT(
      new NextRequest("http://localhost/api/v1/agent/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5" }),
      }),
    );

    expect(response.ok).toBe(true);
    const { configuredModel } = await import("@/lib/agent/config");
    expect(configuredModel("codex")).toBe("gpt-5.5");
  });
});
