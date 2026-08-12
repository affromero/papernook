import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
const reloadProviderCredentials = vi.fn<() => Promise<void>>();
let reloadAvailable = true;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-credential-route-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.stubEnv("PAPERNOOK_CREDENTIAL_SYNC_DIR", path.join(tmpDir, "sync"));
  vi.stubEnv("AI_PROVIDER", "claude-code");
  reloadProviderCredentials.mockResolvedValue(undefined);
  reloadAvailable = true;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/agent/credentials");
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
  vi.doMock("@/lib/agent/credentials", () => ({
    credentialReloadAvailable: () => reloadAvailable,
    reloadProviderCredentials,
  }));
  vi.doMock("@/lib/agent/registry", () => ({
    configuredProviderId: () => "claude-code",
    providerStatus: async () => "ready",
    resetProviderStatusCache: vi.fn(),
  }));
  return import("@/app/api/v1/settings/credentials/route");
}

function request(password?: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/settings/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

describe("credential reload settings route", () => {
  it("requires a signed-in admin", async () => {
    const anonymous = await routeAs("anonymous");
    const anonymousResponse = await anonymous.POST(request());
    expect(anonymousResponse.status).toBe(401);
    expect(anonymousResponse.headers.get("cache-control")).toBe("no-store");

    vi.resetModules();
    const member = await routeAs("member");
    expect((await member.POST(request())).status).toBe(403);
    expect(reloadProviderCredentials).not.toHaveBeenCalled();
  });

  it("rejects providers whose credentials are not local", async () => {
    reloadAvailable = false;
    const route = await routeAs("admin");
    const response = await route.POST(request());

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(reloadProviderCredentials).not.toHaveBeenCalled();
  });

  it("reloads credentials and reports provider readiness", async () => {
    const route = await routeAs("admin");
    const response = await route.POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      provider: "claude-code",
      readiness: "ready",
    });
    expect(reloadProviderCredentials).toHaveBeenCalledWith("claude-code");
  });
});
