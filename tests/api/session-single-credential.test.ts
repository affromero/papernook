import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The instance password is the only credential papernook has. There must be
 * no request shape, host, or configuration under which a session cookie is
 * issued without it — the old PUBLIC_EXPOSURE flag gated exactly that, and a
 * flag left unset meant anyone reaching the port became any profile.
 */

const ACCESS_PASSWORD = "correct-horse-battery-staple";

let tmpDir: string;

function login(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://papernook.test/api/v1/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-session-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.stubEnv("PAPERNOOK_PASSWORD", ACCESS_PASSWORD);
  vi.stubEnv("SESSION_SECRET", "s".repeat(64));
  vi.resetModules();
  // A first-time visitor: no gate cookie, no session cookie.
  vi.doMock("next/headers", () => ({
    cookies: async () => ({ get: () => undefined }),
  }));
});

afterEach(() => {
  vi.doUnmock("next/headers");
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedProfile(): Promise<string> {
  const users = await import("@/lib/auth/users");
  return users.createProfile("Ana").username;
}

describe("session issuance requires the instance password", () => {
  it("refuses a bare username, with no flag able to weaken it", async () => {
    const username = await seedProfile();
    const route = await import("@/app/api/v1/session/route");

    const response = await route.POST(login({ username }));

    expect(response.status).toBe(401);
    expect(response.cookies.get("papernook_session")).toBeUndefined();
  });

  it("refuses a wrong access password", async () => {
    const username = await seedProfile();
    const route = await import("@/app/api/v1/session/route");

    const response = await route.POST(
      login({ username, accessPassword: "not-the-password" }),
    );

    expect(response.status).toBe(401);
    expect(response.cookies.get("papernook_session")).toBeUndefined();
  });

  it("issues a session once the access password is proven", async () => {
    const username = await seedProfile();
    const route = await import("@/app/api/v1/session/route");

    const response = await route.POST(
      login({ username, accessPassword: ACCESS_PASSWORD }),
    );

    expect(response.status).toBe(200);
    expect(response.cookies.get("papernook_session")?.value).toBeTruthy();
  });

  it("fails closed when no access password is configured at all", async () => {
    vi.stubEnv("PAPERNOOK_PASSWORD", "");
    const username = await seedProfile();
    const route = await import("@/app/api/v1/session/route");

    const response = await route.POST(login({ username }));

    expect(response.status).toBe(503);
    expect(response.cookies.get("papernook_session")).toBeUndefined();
  });
});
