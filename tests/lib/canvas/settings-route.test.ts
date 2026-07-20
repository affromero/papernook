import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-canvas-settings-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.stubEnv("TLDRAW_LICENSE_KEY", "");
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function routeAs(role: "admin" | "member" | "anonymous") {
  const users = await import("@/lib/auth/users");
  const admin = users.createProfile("Admin");
  const member = users.createProfile("Member");
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () =>
      role === "admin" ? admin : role === "member" ? member : null,
  }));
  return import("@/app/api/v1/settings/canvas/route");
}

function putRequest(licenseKey: string | null) {
  return new NextRequest("http://localhost/api/v1/settings/canvas", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ licenseKey }),
  });
}

function getRequest(
  url = "http://localhost/api/v1/settings/canvas",
  headers?: HeadersInit,
) {
  return new NextRequest(url, { headers });
}

describe("canvas settings route", () => {
  it("requires a session and keeps responses uncached", async () => {
    const route = await routeAs("anonymous");
    const response = await route.GET(getRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("lets members see readiness without changing the instance key", async () => {
    vi.stubEnv("TLDRAW_LICENSE_KEY", "tldraw-environment-key");
    const route = await routeAs("member");
    const read = await route.GET(getRequest());

    expect(await read.json()).toEqual({
      configured: true,
      source: "environment",
      admin: false,
      requiredForThisOrigin: false,
    });
    expect((await route.PUT(putRequest("replacement"))).status).toBe(403);
  });

  it("lets admins save and remove the filesystem override", async () => {
    vi.stubEnv("TLDRAW_LICENSE_KEY", "tldraw-environment-key");
    const route = await routeAs("admin");

    const saved = await route.PUT(putRequest("tldraw-stored-key"));
    expect(await saved.json()).toEqual({
      configured: true,
      source: "file",
      admin: true,
      requiredForThisOrigin: false,
      licenseKey: "tldraw-stored-key",
    });

    const removed = await route.PUT(putRequest(null));
    expect(await removed.json()).toEqual({
      configured: true,
      source: "environment",
      admin: true,
      requiredForThisOrigin: false,
      licenseKey: "tldraw-environment-key",
    });
  });

  it("reports invalid saved configuration instead of masking it", async () => {
    fs.writeFileSync(path.join(tmpDir, "canvas-config.json"), "{broken");
    const route = await routeAs("admin");
    const response = await route.GET(getRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "The saved canvas configuration is invalid.",
    });
  });

  it("reports whether the current origin requires a key", async () => {
    const route = await routeAs("admin");
    vi.stubEnv("NODE_ENV", "production");
    const response = await route.GET(
      getRequest("http://localhost/api/v1/settings/canvas", {
        host: "papernook.example",
        "x-forwarded-proto": "https",
      }),
    );

    expect(await response.json()).toMatchObject({
      configured: false,
      requiredForThisOrigin: true,
    });
  });
});
