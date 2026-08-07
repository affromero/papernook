import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-zot-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/agent/registry");
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Item {
  key: string;
  version: number;
  data: Record<string, unknown>;
}

interface Library {
  itemVersion: number;
  deletedVersion: number;
  items: Item[];
  deleted: string[];
  files: Record<string, Buffer>;
  collections: {
    key: string;
    name: string;
    parentCollection?: string | false;
  }[];
}

function fixture(): Library {
  return {
    itemVersion: 42,
    deletedVersion: 42,
    items: [
      {
        key: "PARENT01",
        version: 41,
        data: {
          key: "PARENT01",
          version: 41,
          itemType: "journalArticle",
          title: "Attention Is All You Need",
          creators: [
            { creatorType: "author", firstName: "Ashish", lastName: "Vaswani" },
          ],
          date: "2017",
          DOI: "10.5555/3295222.3295349",
          url: "https://arxiv.org/abs/1706.03762",
          collections: ["COLL01"],
          tags: [{ tag: "Transformers" }],
        },
      },
      {
        key: "ATTACH01",
        version: 42,
        data: {
          key: "ATTACH01",
          version: 42,
          itemType: "attachment",
          parentItem: "PARENT01",
          contentType: "application/pdf",
          linkMode: "imported_file",
          filename: "attention.pdf",
        },
      },
      {
        key: "ANNOT001",
        version: 42,
        data: {
          key: "ANNOT001",
          version: 42,
          itemType: "annotation",
          parentItem: "ATTACH01",
          annotationType: "highlight",
          annotationText: "Attention replaces recurrence.",
          annotationComment: "Important architectural shift.",
          annotationPageLabel: "3",
          annotationSortIndex: "00003|00001",
        },
      },
    ],
    deleted: [],
    files: { ATTACH01: Buffer.from("%PDF-1.4 fake pdf") },
    collections: [{ key: "COLL01", name: "Foundation Models" }],
  };
}

function stubZotero(library: Library): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/collections")) {
      return new Response(
        JSON.stringify(library.collections.map((data) => ({ data }))),
      );
    }
    if (url.pathname.endsWith("/deleted")) {
      return new Response(JSON.stringify({ items: library.deleted }), {
        headers: { "Last-Modified-Version": String(library.deletedVersion) },
      });
    }
    const file = url.pathname.match(/\/items\/([A-Z0-9]+)\/file$/);
    if (file) {
      const bytes = library.files[file[1]];
      if (!bytes) return new Response("missing", { status: 404 });
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (url.pathname.endsWith("/items")) {
      const since = Number(url.searchParams.get("since") ?? 0);
      return new Response(
        JSON.stringify(library.items.filter((item) => item.version > since)),
        {
          headers: { "Last-Modified-Version": String(library.itemVersion) },
        },
      );
    }
    return new Response("not found", { status: 404 });
  });
  return calls;
}

function mockAgent() {
  const execute = vi.fn(async () =>
    JSON.stringify({
      title: "AI title",
      authors: [],
      year: null,
      venue: null,
      bibtex: null,
      topic: "machine-learning",
      tags: ["ai"],
      summary: "A paper.",
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

async function connect(collectionKeys: string[] = []) {
  const users = await import("@/lib/auth/users");
  users.createProfile("Andres");
  users.setZoteroConfig("andres", {
    apiKey: "key",
    userId: "1234567",
    collectionKeys,
  });
}

describe("metadata-first Zotero sync", () => {
  it("catalogs metadata and annotations without downloading or invoking AI", async () => {
    const library = fixture();
    const calls = stubZotero(library);
    const execute = mockAgent();
    await connect();

    const { syncProfile } = await import("@/lib/capture/zotero");
    expect(await syncProfile("andres")).toMatchObject({
      imported: 0,
      discovered: 1,
      available: 1,
      failed: 0,
    });
    expect(calls.some((call) => call.endsWith("/file"))).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toEqual([]);
    expect(papers.listInbox()).toEqual([]);

    const { listCatalogItems } = await import("@/lib/capture/zotero-service");
    expect(await listCatalogItems("andres", "", 1, 20)).toMatchObject({
      total: 1,
      importable: 1,
      imported: 0,
      items: [
        {
          key: "PARENT01",
          annotationCount: 1,
          hasStoredPdf: true,
        },
      ],
    });
  });

  it("imports one explicit paper once and records the private association", async () => {
    const calls = stubZotero(fixture());
    const execute = mockAgent();
    await connect();
    const { syncProfile } = await import("@/lib/capture/zotero");
    await syncProfile("andres");
    const { importCatalogItem } = await import("@/lib/capture/zotero-service");

    const first = await importCatalogItem("andres", "PARENT01");
    expect(first.created).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((call) => call.endsWith("/ATTACH01/file")),
    ).toHaveLength(1);

    const second = await importCatalogItem("andres", "PARENT01");
    expect(second).toEqual({ ...first, created: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((call) => call.endsWith("/ATTACH01/file")),
    ).toHaveLength(1);
  });

  it("keeps the cursor at the safe lower snapshot version", async () => {
    const library = fixture();
    library.itemVersion = 43;
    library.deletedVersion = 42;
    const calls = stubZotero(library);
    mockAgent();
    await connect();
    const { syncProfile } = await import("@/lib/capture/zotero");
    await syncProfile("andres");
    await syncProfile("andres");
    expect(calls.some((call) => call.includes("/items?since=42"))).toBe(true);

    const catalog = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "users", "andres", "zotero-catalog.json"),
        "utf8",
      ),
    ) as { libraries: Record<string, { lastVersion: number }> };
    expect(catalog.libraries["user:1234567"].lastVersion).toBe(42);
  });

  it("rejects a catalog page sequence when Zotero changes mid-pagination", async () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      key: `ITEM${String(index).padStart(4, "0")}`,
      version: 42,
      data: {
        key: `ITEM${String(index).padStart(4, "0")}`,
        version: 42,
        itemType: "journalArticle",
        title: `Paper ${index}`,
      },
    }));
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/collections")) {
        return new Response("[]", {
          headers: { "Last-Modified-Version": "42" },
        });
      }
      if (url.pathname.endsWith("/deleted")) {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "Last-Modified-Version": "42" },
        });
      }
      if (url.pathname.endsWith("/items")) {
        const start = Number(url.searchParams.get("start") ?? 0);
        return new Response(JSON.stringify(items.slice(start, start + 100)), {
          headers: {
            "Last-Modified-Version": start === 0 ? "42" : "43",
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    mockAgent();
    await connect();
    const { syncProfile } = await import("@/lib/capture/zotero");

    await expect(syncProfile("andres")).rejects.toThrow(
      "changed during catalog pagination",
    );
  });

  it("includes descendant collections without importing their PDFs", async () => {
    const library = fixture();
    library.items[0].data.collections = ["CHILD01"];
    library.collections = [
      { key: "ROOT01", name: "Root" },
      { key: "CHILD01", name: "Child", parentCollection: "ROOT01" },
    ];
    const calls = stubZotero(library);
    mockAgent();
    await connect(["ROOT01"]);
    const { syncProfile } = await import("@/lib/capture/zotero");
    expect((await syncProfile("andres"))?.available).toBe(1);
    expect(calls.some((call) => call.endsWith("/file"))).toBe(false);
  });

  it("removes deleted catalog records without deleting imported papers", async () => {
    const library = fixture();
    stubZotero(library);
    mockAgent();
    await connect();
    const { syncProfile } = await import("@/lib/capture/zotero");
    const { importCatalogItem, listCatalogItems } =
      await import("@/lib/capture/zotero-service");
    await syncProfile("andres");
    await importCatalogItem("andres", "PARENT01");

    library.deleted = ["PARENT01", "ATTACH01", "ANNOT001"];
    library.deletedVersion = 43;
    library.itemVersion = 43;
    library.items = [];
    await syncProfile("andres");
    expect((await listCatalogItems("andres", "", 1, 20)).total).toBe(0);
    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toHaveLength(1);
  });

  it("refreshes source metadata without downloading or rewriting the PDF", async () => {
    const library = fixture();
    const calls = stubZotero(library);
    mockAgent();
    await connect();
    const { syncProfile } = await import("@/lib/capture/zotero");
    const { importCatalogItem } = await import("@/lib/capture/zotero-service");
    await syncProfile("andres");
    await importCatalogItem("andres", "PARENT01");
    const papers = await import("@/lib/library/papers");
    const before = papers.listPapers()[0];
    const pdf = fs.readFileSync(before.pdfPath);

    library.itemVersion = 43;
    library.deletedVersion = 43;
    library.items[0].version = 43;
    library.items[0].data.version = 43;
    library.items[0].data.title = "Attention Is Still All You Need";
    await syncProfile("andres");

    const after = papers.listPapers()[0];
    expect(after.meta.title).toBe("Attention Is Still All You Need");
    expect(fs.readFileSync(after.pdfPath)).toEqual(pdf);
    expect(
      calls.filter((call) => call.endsWith("/ATTACH01/file")),
    ).toHaveLength(1);
  });

  it("exposes annotations only through the owning profile association", async () => {
    stubZotero(fixture());
    mockAgent();
    await connect();
    const { syncProfile } = await import("@/lib/capture/zotero");
    const { importCatalogItem, annotationsForPaper } =
      await import("@/lib/capture/zotero-service");
    await syncProfile("andres");
    await importCatalogItem("andres", "PARENT01");
    const papers = await import("@/lib/library/papers");
    const paper = papers.listPapers()[0];
    expect(await annotationsForPaper("andres", paper)).toEqual([
      {
        pageLabel: "3",
        text: "Attention replaces recurrence.",
        comment: "Important architectural shift.",
      },
    ]);
    expect(await annotationsForPaper("guest", paper)).toEqual([]);
  });

  it("does not recreate profile data when erasure races a catalog refresh", async () => {
    const library = fixture();
    let releaseItems: (() => void) | undefined;
    let itemsStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      itemsStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseItems = resolve;
    });
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/collections")) {
        return new Response(
          JSON.stringify(library.collections.map((data) => ({ data }))),
        );
      }
      if (url.pathname.endsWith("/deleted")) {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "Last-Modified-Version": "42" },
        });
      }
      if (url.pathname.endsWith("/items")) {
        itemsStarted?.();
        await release;
        return new Response(JSON.stringify(library.items), {
          headers: { "Last-Modified-Version": "42" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    mockAgent();
    await connect();
    const zotero = await import("@/lib/capture/zotero");
    const syncing = zotero.syncProfile("andres");
    await started;

    const { beginProfileErasure } = await import("@/lib/auth/profile-activity");
    const erasure = beginProfileErasure("andres");
    zotero.cancelProfileSync("andres");
    releaseItems?.();
    expect(await syncing).toBeNull();
    const finishErasure = await erasure;
    const users = await import("@/lib/auth/users");
    users.deleteProfile("andres");
    finishErasure();

    expect(users.getProfile("andres")).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, "users", "andres"))).toBe(false);
  });
});
