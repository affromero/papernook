import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-zset-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/auth/session");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function signedInAs(username: string | null) {
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => {
      if (!username) return null;
      const { getProfile } = await import("@/lib/auth/users");
      return getProfile(username);
    },
  }));
}

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/settings/zotero", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("zotero settings route", () => {
  it("rejects unauthenticated requests", async () => {
    await signedInAs(null);
    const route = await import("@/app/api/v1/settings/zotero/route");
    expect((await route.GET()).status).toBe(401);
    expect(
      (await route.PUT(putRequest({ apiKey: "x".repeat(24) }))).status,
    ).toBe(401);
    expect((await route.POST()).status).toBe(401);
    expect((await route.DELETE()).status).toBe(401);
  });

  it("verifies the key with Zotero and never echoes it back", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ userID: 1234567, username: "andres" })),
    );

    const route = await import("@/app/api/v1/settings/zotero/route");
    const secret = "s3cretzoterokey-s3cretzoterokey";
    const res = await route.PUT(putRequest({ apiKey: secret }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      connected: true,
      userId: "1234567",
      syncing: false,
      lastResult: null,
    });
    expect(body).not.toContain(secret);
    expect(body).not.toContain("captureToken");

    // The key landed in the profile on disk, not in any response.
    expect(users.getProfile("andres")?.zotero?.apiKey).toBe(secret);
    const getBody = await (await route.GET()).text();
    expect(getBody).not.toContain(secret);

    const delRes = await route.DELETE();
    expect(((await delRes.json()) as { connected: boolean }).connected).toBe(
      false,
    );
    expect(users.getProfile("andres")?.zotero).toBeUndefined();
  });

  it("rejects malformed bodies and keys Zotero refuses, then rate-limits", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    vi.stubGlobal(
      "fetch",
      async () => new Response("forbidden", { status: 403 }),
    );

    const route = await import("@/app/api/v1/settings/zotero/route");
    expect((await route.PUT(putRequest({}))).status).toBe(400);
    expect((await route.PUT(putRequest({ apiKey: "short" }))).status).toBe(400);

    const bad = () => route.PUT(putRequest({ apiKey: "x".repeat(24) }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await bad()).status);
    expect(statuses.slice(0, 4)).toEqual([422, 422, 422, 422]);
    expect(statuses[4]).toBe(429);
    expect(users.getProfile("andres")?.zotero).toBeUndefined();
  });

  it("sync-now requires a connection and cools down", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    const route = await import("@/app/api/v1/settings/zotero/route");
    expect((await route.POST()).status).toBe(400);

    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });
    // Empty library: the background sync finishes with nothing to do.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify([]), {
          headers: { "Last-Modified-Version": "1" },
        }),
    );
    const first = await route.POST();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { syncing: boolean }).syncing).toBe(true);

    await vi.waitFor(async () => {
      const { isSyncing } = await import("@/lib/capture/zotero");
      expect(isSyncing("andres")).toBe(false);
    });
    expect((await route.POST()).status).toBe(429);
  });
});
