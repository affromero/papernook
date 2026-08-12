import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
const execute = vi.fn<() => Promise<string>>();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-agent-test-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  execute.mockResolvedValue("Papernook model test passed");
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/agent/registry");
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function routeAs(role: "admin" | "member" | "anonymous") {
  const users = await import("@/lib/auth/users");
  const admin = users.getProfile("admin") ?? users.createProfile("Admin");
  const member = users.getProfile("member") ?? users.createProfile("Member");
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () =>
      role === "admin" ? admin : role === "member" ? member : null,
  }));
  vi.doMock("@/lib/agent/registry", () => ({
    configuredProviderId: () => "codex",
    getProvider: () => ({ execute }),
  }));
  return import("@/app/api/v1/agent/test/route");
}

function request(password?: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/agent/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

describe("selected model test route", () => {
  it("requires a signed-in admin", async () => {
    const anonymous = await routeAs("anonymous");
    expect((await anonymous.POST(request())).status).toBe(401);

    vi.resetModules();
    const member = await routeAs("member");
    expect((await member.POST(request())).status).toBe(403);

    expect(execute).not.toHaveBeenCalled();
  });

  it("tests only the selected provider with a bounded non-web prompt", async () => {
    const route = await routeAs("admin");
    const response = await route.POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      provider: "codex",
      reply: "Papernook model test passed",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        allowWeb: false,
        timeoutMs: 45_000,
        maxOutputTokens: 512,
        maxOutputChars: 512,
      }),
    );
  });
});
