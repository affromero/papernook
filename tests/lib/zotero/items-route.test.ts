import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { ZoteroCatalog } from "@/lib/capture/zotero-catalog";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-zitems-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/agent/registry");
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

async function prepareCatalog() {
  const users = await import("@/lib/auth/users");
  users.createProfile("Andres");
  users.setZoteroConfig("andres", {
    apiKey: "private-api-key",
    userId: "1234567",
  });
  const catalog: ZoteroCatalog = {
    formatVersion: 1,
    libraries: {
      "user:1234567": {
        target: { type: "user", id: "1234567", name: "My Library" },
        lastVersion: 4,
        refreshedAt: "2026-07-19T12:00:00.000Z",
        collections: [],
        records: {
          PARENT01: {
            key: "PARENT01",
            version: 3,
            itemType: "journalArticle",
            title: "A Private Annotated Paper",
            creators: [{ firstName: "Ada", lastName: "Lovelace" }],
            date: "2025",
          },
          ATTACH01: {
            key: "ATTACH01",
            version: 4,
            itemType: "attachment",
            parentItem: "PARENT01",
            contentType: "application/pdf",
            linkMode: "imported_file",
          },
          ANNOT001: {
            key: "ANNOT001",
            version: 4,
            itemType: "annotation",
            parentItem: "ATTACH01",
            annotationText: "secret annotation body",
          },
        },
      },
    },
    associations: {},
  };
  const { writeZoteroCatalog } = await import("@/lib/capture/zotero-catalog");
  await writeZoteroCatalog("andres", catalog);
}

function request(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function mockAgent() {
  const execute = vi.fn(async () =>
    JSON.stringify({
      title: "AI title",
      authors: [],
      year: null,
      venue: null,
      bibtex: null,
      topic: "computing-history",
      tags: [],
      summary: "A summary.",
      related: [],
      starterQuestions: ["Why?"],
    }),
  );
  vi.doMock("@/lib/agent/registry", () => ({
    hasConfiguredProvider: () => true,
    getProvider: () => ({
      id: "test",
      execute,
      stream: async function* () {},
    }),
  }));
  return execute;
}

describe("Zotero catalog items route", () => {
  it("cancels streamed bodies that cross the byte limit", async () => {
    const { readBoundedResponse, ResponseTooLargeError } =
      await import("@/lib/capture/bounded-response");
    let reads = 0;
    let cancelled = false;
    const response = {
      headers: { get: () => null },
      body: {
        cancel: async () => {
          cancelled = true;
        },
        getReader: () => ({
          read: async () => {
            reads += 1;
            return reads === 1
              ? { done: false, value: new Uint8Array([1, 2, 3, 4, 5, 6]) }
              : { done: true };
          },
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    };
    await expect(readBoundedResponse(response, 5)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    expect(cancelled).toBe(true);
  });

  it("requires authentication and bounds query inputs", async () => {
    await signedInAs(null);
    const route = await import("@/app/api/v1/settings/zotero/items/route");
    expect(
      (
        await route.GET(
          request("http://localhost/api/v1/settings/zotero/items"),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await route.POST(
          request("http://localhost/api/v1/settings/zotero/items", {
            itemKey: "PARENT01",
          }),
        )
      ).status,
    ).toBe(401);

    await prepareCatalog();
    await signedInAs("andres");
    vi.resetModules();
    const authenticated =
      await import("@/app/api/v1/settings/zotero/items/route");
    expect(
      (
        await authenticated.GET(
          request(
            "http://localhost/api/v1/settings/zotero/items?limit=500&q=x",
          ),
        )
      ).status,
    ).toBe(400);
  });

  it("returns a strict searchable projection without private annotation text", async () => {
    await prepareCatalog();
    await signedInAs("andres");
    const route = await import("@/app/api/v1/settings/zotero/items/route");
    const response = await route.GET(
      request(
        "http://localhost/api/v1/settings/zotero/items?q=lovelace&page=1&limit=20",
      ),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("private-api-key");
    expect(text).not.toContain("secret annotation body");
    expect(JSON.parse(text)).toMatchObject({
      total: 1,
      importable: 1,
      items: [
        {
          key: "PARENT01",
          title: "A Private Annotated Paper",
          authors: ["Ada Lovelace"],
          annotationCount: 1,
        },
      ],
    });
  });

  it("imports one item and returns the existing association on retry", async () => {
    await prepareCatalog();
    await signedInAs("andres");
    const execute = mockAgent();
    const fileCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      fileCalls.push(url.pathname);
      return new Response(new Uint8Array(Buffer.from("%PDF-1.4 route")), {
        headers: { "Content-Type": "application/pdf" },
      });
    });
    const route = await import("@/app/api/v1/settings/zotero/items/route");
    const first = await route.POST(
      request("http://localhost/api/v1/settings/zotero/items", {
        itemKey: "PARENT01",
      }),
    );
    expect(first.status).toBe(201);
    const second = await route.POST(
      request("http://localhost/api/v1/settings/zotero/items", {
        itemKey: "PARENT01",
      }),
    );
    expect(second.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      fileCalls.filter((pathname) => pathname.endsWith("/ATTACH01/file")),
    ).toHaveLength(1);
  });

  it("rejects oversized PDFs before AI analysis or artifact creation", async () => {
    await prepareCatalog();
    await signedInAs("andres");
    const execute = mockAgent();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(new Uint8Array(Buffer.from("%PDF-1.4 too large")), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(100 * 1024 * 1024 + 1),
          },
        }),
    );
    const route = await import("@/app/api/v1/settings/zotero/items/route");
    const response = await route.POST(
      request("http://localhost/api/v1/settings/zotero/items", {
        itemKey: "PARENT01",
      }),
    );
    expect(response.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toEqual([]);
    expect(papers.listInbox()).toEqual([]);
  });
});
