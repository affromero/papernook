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

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/settings/zotero", {
    method: "PATCH",
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
    expect(
      (
        await route.PATCH(
          patchRequest({
            target: { type: "user", id: "1" },
            collectionKeys: [],
          }),
        )
      ).status,
    ).toBe(401);
    expect((await route.POST()).status).toBe(401);
    expect((await route.DELETE()).status).toBe(401);
  });

  it("verifies the key with Zotero and never echoes it back", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/keys/current") {
        return new Response(
          JSON.stringify({
            userID: 1234567,
            username: "andres",
            access: {
              user: { library: true, files: true },
              groups: {},
            },
          }),
        );
      }
      if (url.pathname === "/users/1234567/groups") {
        return new Response(JSON.stringify([]));
      }
      return new Response("not found", { status: 404 });
    });

    const route = await import("@/app/api/v1/settings/zotero/route");
    const secret = "s3cretzoterokey-s3cretzoterokey";
    const res = await route.PUT(putRequest({ apiKey: secret }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      connected: true,
      userId: "1234567",
      target: { type: "user", id: "1234567", name: "My Library" },
      collectionKeys: [],
      syncing: false,
      lastResult: null,
    });
    expect(body).not.toContain(secret);
    expect(body).not.toContain("captureToken");

    // The key landed in the profile on disk, not in any response.
    expect(users.getProfile("andres")?.zotero).toMatchObject({
      apiKey: secret,
      userId: "1234567",
      target: { type: "user", id: "1234567" },
      collectionKeys: [],
    });
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

  it("allows metadata-only connection without personal file permission", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/keys/current") {
        return new Response(
          JSON.stringify({
            userID: 1234567,
            access: { user: { library: true, files: false } },
          }),
        );
      }
      if (url.pathname === "/users/1234567/groups") {
        return new Response(JSON.stringify([]));
      }
      return new Response("not found", { status: 404 });
    });

    const route = await import("@/app/api/v1/settings/zotero/route");
    const response = await route.PUT(putRequest({ apiKey: "x".repeat(24) }));
    expect(response.status).toBe(200);
    expect(users.getProfile("andres")?.zotero?.target).toMatchObject({
      type: "user",
      id: "1234567",
    });
  });

  it("lists accessible libraries and validates group collection filters", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", {
      apiKey: "secret-key",
      userId: "1234567",
    });
    await signedInAs("andres");
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/keys/current") {
        return new Response(
          JSON.stringify({
            userID: 1234567,
            access: { user: { library: true, files: true } },
          }),
        );
      }
      if (url.pathname === "/users/1234567/groups") {
        return new Response(
          JSON.stringify([{ id: 77, data: { name: "Research Group" } }]),
        );
      }
      if (url.pathname === "/groups/77/collections") {
        return new Response(
          JSON.stringify([
            {
              data: {
                key: "GROUPCOLL",
                name: "Shared Reading",
                parentCollection: false,
              },
            },
          ]),
        );
      }
      if (url.pathname === "/users/1234567/collections") {
        return new Response(JSON.stringify([]));
      }
      return new Response("not found", { status: 404 });
    });

    const route = await import("@/app/api/v1/settings/zotero/route");
    const options = await route.GET(
      new NextRequest(
        "http://localhost/api/v1/settings/zotero?options=1&libraryType=group&libraryId=77",
      ),
    );
    expect(options.status).toBe(200);
    const optionsText = await options.text();
    expect(optionsText).not.toContain("secret-key");
    const optionsBody = JSON.parse(optionsText) as {
      libraries: { name: string }[];
      collections: { key: string }[];
    };
    expect(optionsBody.libraries.map((library) => library.name)).toEqual([
      "My Library",
      "Research Group",
    ]);
    expect(optionsBody.collections).toEqual([
      {
        key: "GROUPCOLL",
        name: "Shared Reading",
        parentCollection: null,
      },
    ]);

    const update = await route.PATCH(
      patchRequest({
        target: { type: "group", id: "77" },
        collectionKeys: ["GROUPCOLL"],
      }),
    );
    expect(update.status).toBe(200);
    expect(users.getProfile("andres")?.zotero).toMatchObject({
      target: { type: "group", id: "77", name: "Research Group" },
      collectionKeys: ["GROUPCOLL"],
    });

    expect(
      (
        await route.PATCH(
          patchRequest({
            target: { type: "group", id: "77" },
            collectionKeys: ["FOREIGN"],
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await route.PATCH(
          patchRequest({
            target: { type: "group", id: "999" },
            collectionKeys: [],
          }),
        )
      ).status,
    ).toBe(422);
  });

  it("connects a group-only key to its first accessible group", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/keys/current") {
        return new Response(
          JSON.stringify({
            userID: 1234567,
            access: {
              user: { library: false, files: false },
              groups: { all: { library: true } },
            },
          }),
        );
      }
      if (url.pathname === "/users/1234567/groups") {
        return new Response(
          JSON.stringify([{ id: 77, data: { name: "Research Group" } }]),
        );
      }
      return new Response("not found", { status: 404 });
    });

    const route = await import("@/app/api/v1/settings/zotero/route");
    const response = await route.PUT(
      putRequest({ apiKey: "group-only-key-with-enough-length" }),
    );
    expect(response.status).toBe(200);
    expect(users.getProfile("andres")?.zotero?.target).toEqual({
      type: "group",
      id: "77",
      name: "Research Group",
    });
  });

  it("sync-now requires a connection and cools down", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    await signedInAs("andres");
    const route = await import("@/app/api/v1/settings/zotero/route");
    expect((await route.POST()).status).toBe(400);

    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });
    let releaseCollections: ((response: Response) => void) | null = null;
    const pendingCollections = new Promise<Response>((resolve) => {
      releaseCollections = resolve;
    });
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/collections")) return pendingCollections;
      if (url.pathname.endsWith("/deleted")) {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "Last-Modified-Version": "1" },
        });
      }
      return new Response(JSON.stringify([]), {
        headers: { "Last-Modified-Version": "1" },
      });
    });
    const first = await route.POST();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { syncing: boolean }).syncing).toBe(true);
    expect((await route.DELETE()).status).toBe(409);
    expect(
      (
        await route.PATCH(
          patchRequest({
            target: { type: "user", id: "1234567" },
            collectionKeys: [],
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await route.PUT(
          putRequest({ apiKey: "replacement-key-with-enough-length" }),
        )
      ).status,
    ).toBe(409);
    releaseCollections!(
      new Response(JSON.stringify([]), {
        headers: { "Last-Modified-Version": "1" },
      }),
    );

    await vi.waitFor(async () => {
      const { isSyncing } = await import("@/lib/capture/zotero");
      expect(isSyncing("andres")).toBe(false);
    });
    expect((await route.POST()).status).toBe(429);
  });
});
