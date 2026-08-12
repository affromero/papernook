import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-avatar-route-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/session");
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function routeAs(username: "ana" | "ben" | null) {
  const users = await import("@/lib/auth/users");
  const ana = users.getProfile("ana") ?? users.createProfile("Ana", "jaguar");
  const ben = users.getProfile("ben") ?? users.createProfile("Ben", "toucan");
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () =>
      username === "ana" ? ana : username === "ben" ? ben : null,
  }));
  return import("@/app/api/v1/profiles/[username]/route");
}

function request(
  username: string,
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost/api/v1/profiles/${username}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const params = (username: string) => ({
  params: Promise.resolve({ username }),
});

describe("profile avatar settings route", () => {
  it("requires a signed-in owner", async () => {
    const anonymous = await routeAs(null);
    expect(
      (
        await anonymous.PATCH(
          request("ana", { avatarSlug: "frog" }),
          params("ana"),
        )
      ).status,
    ).toBe(401);
  });

  it("does not let another profile change the avatar", async () => {
    const route = await routeAs("ben");
    const response = await route.PATCH(
      request("ana", { avatarSlug: "frog" }),
      params("ana"),
    );

    expect(response.status).toBe(403);
    const users = await import("@/lib/auth/users");
    expect(users.getProfile("ana")?.avatarSlug).toBe("jaguar");
  });

  it("rejects cross-site and invalid avatar changes", async () => {
    const route = await routeAs("ana");
    const crossSite = await route.PATCH(
      request(
        "ana",
        { avatarSlug: "frog" },
        { Origin: "https://attacker.example" },
      ),
      params("ana"),
    );
    expect(crossSite.status).toBe(403);

    const invalid = await route.PATCH(
      request("ana", { avatarSlug: "unknown" }),
      params("ana"),
    );
    expect(invalid.status).toBe(400);
  });

  it("persists and returns the owner's selected avatar", async () => {
    const route = await routeAs("ana");
    const response = await route.PATCH(
      request("ana", { avatarSlug: "frog" }),
      params("ana"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile: { username: "ana", avatarSlug: "frog" },
    });
    const users = await import("@/lib/auth/users");
    expect(users.getProfile("ana")?.avatarSlug).toBe("frog");
  });
});
