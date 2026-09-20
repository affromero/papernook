import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createTestProfile, testSession } from "../helpers/access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
const browser = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "papernook_access" && browser.token
        ? { value: browser.token }
        : undefined,
  }),
}));

function request(body: unknown, token = browser.token) {
  return new NextRequest("http://localhost/api/v1/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      ...(token ? { Cookie: `papernook_access=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-session-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.stubEnv("PAPERNOOK_URL", "http://localhost");
  vi.resetModules();
  browser.token = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("profile selection", () => {
  it("requires a canonical Sidedoor session", async () => {
    const profile = await createTestProfile("Ana");
    const route = await import("@/app/api/v1/session/route");
    const response = await route.POST(
      request({ username: profile.username }, null),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("selects a household profile after admission", async () => {
    const profile = await createTestProfile("Ana");
    browser.token = await testSession("fixture-owner");
    const route = await import("@/app/api/v1/session/route");
    const response = await route.POST(request({ username: profile.username }));
    expect(response.status).toBe(200);
    expect((await response.json()).profile.username).toBe(profile.username);
  });

  it("keeps an individual account bound to its own profile", async () => {
    const owner = await createTestProfile("Owner", undefined, true);
    const other = await createTestProfile("Reader");
    browser.token = await testSession(owner.username, true);
    const route = await import("@/app/api/v1/session/route");
    expect(
      (await route.POST(request({ username: owner.username }))).status,
    ).toBe(200);
    expect(
      (await route.POST(request({ username: other.username }))).status,
    ).toBe(403);
  });

  it("rejects extra credential fields", async () => {
    const profile = await createTestProfile("Ana");
    browser.token = await testSession("fixture-owner");
    const route = await import("@/app/api/v1/session/route");
    expect(
      (
        await route.POST(
          request({ username: profile.username, accessPassword: "unused" }),
        )
      ).status,
    ).toBe(400);
  });

  it("revokes the persisted session on sign out", async () => {
    await createTestProfile("Ana");
    const token = await testSession("fixture-owner");
    browser.token = token;
    const route = await import("@/app/api/v1/session/route");
    const response = await route.DELETE(
      new NextRequest("http://localhost/api/v1/session", {
        method: "DELETE",
        headers: {
          Cookie: `papernook_access=${token}`,
          Origin: "http://localhost",
        },
      }),
    );
    expect(response.status).toBe(200);
    const { sharedAccess } = await import("@/lib/auth/access");
    await expect(
      sharedAccess().access.authenticate(token),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
