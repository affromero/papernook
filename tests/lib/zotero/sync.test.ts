import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

function mockAgent(title: string) {
  vi.doMock("@/lib/agent/registry", () => ({
    getProvider: () => ({
      id: "claude-code",
      execute: async () =>
        JSON.stringify({
          title,
          authors: ["AI Guess"],
          year: null,
          venue: null,
          bibtex: null,
          topic: "Synced Topic",
          tags: ["synced"],
          summary: "A synced paper.",
          related: [],
          starterQuestions: ["Why?"],
        }),
      stream: async function* () {},
    }),
  }));
}

interface ZoteroLibrary {
  version: number;
  items: {
    key: string;
    version: number;
    data: Record<string, unknown>;
  }[];
  files: Record<string, Buffer>;
  collections?: {
    key: string;
    name: string;
    parentCollection?: string | false;
  }[];
}

/** Serve a canned Zotero library over the fetch boundary. */
function stubZoteroApi(library: ZoteroLibrary) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/collections")) {
      return new Response(
        JSON.stringify((library.collections ?? []).map((data) => ({ data }))),
      );
    }
    const childrenMatch = url.pathname.match(/\/items\/([A-Z0-9]+)\/children$/);
    if (childrenMatch) {
      return new Response(
        JSON.stringify(
          library.items.filter(
            (item) => item.data.parentItem === childrenMatch[1],
          ),
        ),
      );
    }
    const fileMatch = url.pathname.match(/\/items\/([A-Z0-9]+)\/file$/);
    if (fileMatch) {
      const bytes = library.files[fileMatch[1]];
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(bytes));
    }
    const itemMatch = url.pathname.match(/\/items\/([A-Z0-9]+)$/);
    if (itemMatch) {
      const item = library.items.find((i) => i.key === itemMatch[1]);
      if (!item) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(item), {
        headers: { "Last-Modified-Version": String(library.version) },
      });
    }
    const since = Number(url.searchParams.get("since") ?? 0);
    const changed = library.items.filter((i) => i.version > since);
    return new Response(JSON.stringify(changed), {
      headers: { "Last-Modified-Version": String(library.version) },
    });
  });
  return calls;
}

function paperLibrary(
  arxivUrl = "https://arxiv.org/abs/1706.03762",
): ZoteroLibrary {
  return {
    version: 42,
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
          date: "2017-06-12",
          publicationTitle: "NeurIPS",
          DOI: "10.5555/3295222.3295349",
          volume: "30",
          issue: "4",
          pages: "5998-6008",
          publisher: "Curran Associates",
          place: "Red Hook, NY",
          abstractNote: "Introduces the Transformer architecture.",
          language: "en",
          ISSN: "1049-5258",
          tags: [{ tag: "Transformers" }, { tag: "Deep Learning" }],
          collections: ["COLL01"],
          url: arxivUrl,
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
          title: "Full Text PDF",
        },
      },
    ],
    files: { ATTACH01: Buffer.from("%PDF-1.4 fake pdf") },
    collections: [{ key: "COLL01", name: "Foundation Models" }],
  };
}

describe("zotero sync", () => {
  it("imports a new PDF item, auto-files it, and advances the cursor", async () => {
    mockAgent("A Guessed Title");
    stubZoteroApi(paperLibrary());
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });

    const { syncProfile } = await import("@/lib/capture/zotero");
    const result = await syncProfile("andres");
    expect(result).toEqual({
      imported: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });

    const papers = await import("@/lib/library/papers");
    expect(papers.listInbox()).toHaveLength(0);
    const filed = papers.getPaper("synced-topic", "attention-is-all-you-need");
    expect(filed).not.toBeNull();
    // Zotero metadata wins over the AI guess.
    expect(filed?.meta.title).toBe("Attention Is All You Need");
    expect(filed?.meta.authors).toEqual(["Ashish Vaswani"]);
    expect(filed?.meta.year).toBe(2017);
    expect(filed?.meta.venue).toBe("NeurIPS");
    expect(filed?.meta.arxivId).toBe("1706.03762");
    expect(filed?.meta.addedBy).toBe("andres");
    expect(filed?.meta.needsReview).toBe(true);
    expect(filed?.meta.tags).toEqual([
      "synced",
      "Transformers",
      "Deep Learning",
    ]);
    expect(filed?.meta.citation).toMatchObject({
      type: "article-journal",
      DOI: "10.5555/3295222.3295349",
      containerTitle: "NeurIPS",
      volume: "30",
      issue: "4",
      pages: "5998-6008",
      publisher: "Curran Associates",
      publisherPlace: "Red Hook, NY",
      language: "en",
      ISSN: "1049-5258",
      authors: [{ given: "Ashish", family: "Vaswani" }],
    });
    expect(filed?.meta.source).toEqual({
      provider: "zotero",
      key: "PARENT01",
      version: 41,
      libraryType: "user",
      libraryId: "1234567",
      collectionKeys: ["COLL01"],
      collections: ["Foundation Models"],
      tags: ["Transformers", "Deep Learning"],
    });

    const cursor = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "users", "andres", "zotero-sync.json"),
        "utf8",
      ),
    );
    expect(cursor.lastVersion).toBe(42);
    expect(cursor.imported.PARENT01).toBe("attention-is-all-you-need");
  });

  it("prefers stored PDFs over linked attachments for the same item", async () => {
    mockAgent("A Guessed Title");
    const library = paperLibrary();
    library.items[1].data.linkMode = "imported_file";
    library.items.push({
      key: "AAAA0001",
      version: 42,
      data: {
        key: "AAAA0001",
        version: 42,
        itemType: "attachment",
        parentItem: "PARENT01",
        contentType: "application/pdf",
        linkMode: "linked_file",
        title: "Linked PDF",
      },
    });
    const calls = stubZoteroApi(library);
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });

    const { syncProfile } = await import("@/lib/capture/zotero");
    expect(await syncProfile("andres")).toEqual({
      imported: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
    expect(calls.some((call) => call.includes("ATTACH01/file"))).toBe(true);
    expect(calls.some((call) => call.includes("AAAA0001/file"))).toBe(false);
  });

  it("re-running is idempotent: nothing past the cursor imports nothing", async () => {
    mockAgent("A Guessed Title");
    const calls = stubZoteroApi(paperLibrary());
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });

    const { syncProfile } = await import("@/lib/capture/zotero");
    await syncProfile("andres");
    const again = await syncProfile("andres");
    expect(again).toEqual({
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    });

    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toHaveLength(1);
    // Second run asked only for items since the stored cursor.
    expect(calls.some((c) => c.includes("since=42"))).toBe(true);
  });

  it("skips a paper another profile already imported (arxiv dedup)", async () => {
    mockAgent("A Guessed Title");
    stubZoteroApi(paperLibrary());
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });
    users.createProfile("Guest");
    users.setZoteroConfig("guest", { apiKey: "key2", userId: "7654321" });

    const { syncProfile } = await import("@/lib/capture/zotero");
    await syncProfile("andres");
    const second = await syncProfile("guest");
    expect(second).toEqual({
      imported: 0,
      updated: 0,
      skipped: 1,
      failed: 0,
    });

    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toHaveLength(1);
  });

  it("returns null for profiles without a Zotero connection", async () => {
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    const { syncProfile } = await import("@/lib/capture/zotero");
    expect(await syncProfile("andres")).toBeNull();
    expect(await syncProfile("../evil")).toBeNull();
  });

  it("keeps the cursor behind failures and retries only failed imports", async () => {
    mockAgent("A Guessed Title");
    const library = paperLibrary();
    library.items.push(
      {
        key: "PARENT02",
        version: 41,
        data: {
          key: "PARENT02",
          version: 41,
          itemType: "report",
          title: "A Second Paper",
          creators: [{ creatorType: "author", name: "Research Lab" }],
          date: "2025",
        },
      },
      {
        key: "ATTACH02",
        version: 42,
        data: {
          key: "ATTACH02",
          version: 42,
          itemType: "attachment",
          parentItem: "PARENT02",
          contentType: "application/pdf",
        },
      },
    );
    const calls = stubZoteroApi(library);
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });

    const { syncProfile } = await import("@/lib/capture/zotero");
    expect(await syncProfile("andres")).toEqual({
      imported: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
    });
    const cursorFile = path.join(tmpDir, "users", "andres", "zotero-sync.json");
    expect(JSON.parse(fs.readFileSync(cursorFile, "utf8")).lastVersion).toBe(0);

    library.files.ATTACH02 = Buffer.from("%PDF-1.4 second");
    expect(await syncProfile("andres")).toEqual({
      imported: 1,
      updated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(JSON.parse(fs.readFileSync(cursorFile, "utf8")).lastVersion).toBe(
      42,
    );
    expect(calls.filter((call) => call.includes("ATTACH01/file"))).toHaveLength(
      1,
    );
  });

  it("recognizes an empty-string dedup marker as already handled", async () => {
    mockAgent("A Guessed Title");
    const calls = stubZoteroApi(paperLibrary());
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });
    const cursorDir = path.join(tmpDir, "users", "andres");
    fs.writeFileSync(
      path.join(cursorDir, "zotero-sync.json"),
      JSON.stringify({ lastVersion: 0, imported: { PARENT01: "" } }),
    );

    const { syncProfile } = await import("@/lib/capture/zotero");
    expect(await syncProfile("andres")).toEqual({
      imported: 0,
      updated: 0,
      skipped: 1,
      failed: 0,
    });
    expect(calls.some((call) => call.includes("ATTACH01/file"))).toBe(false);
  });

  it("does not recreate profile data when deletion races an active sync", async () => {
    let releaseAnalysis: (() => void) | undefined;
    let analysisStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      analysisStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseAnalysis = resolve;
    });
    vi.doMock("@/lib/agent/registry", () => ({
      getProvider: () => ({
        id: "codex",
        execute: async () => {
          analysisStarted?.();
          await release;
          return JSON.stringify({
            title: "Deleted profile import",
            authors: ["Researcher"],
            year: 2026,
            venue: null,
            bibtex: null,
            topic: "Synced Topic",
            tags: ["synced"],
            summary: "Must be removed.",
            related: [],
            starterQuestions: ["Why?"],
          });
        },
        stream: async function* () {},
      }),
    }));
    stubZoteroApi(paperLibrary());
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });
    const zotero = await import("@/lib/capture/zotero");

    const syncing = zotero.syncProfile("andres");
    await started;
    zotero.cancelProfileSync("andres");
    users.deleteProfile("andres");
    releaseAnalysis?.();

    expect(await syncing).toBeNull();
    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toEqual([]);
    expect(papers.listInbox()).toEqual([]);
    expect(users.getProfile("andres")).toBeNull();
  });

  it("scopes the same item key independently in personal and group libraries", async () => {
    mockAgent("A Guessed Title");
    const library = paperLibrary("https://example.org/paper");
    const calls = stubZoteroApi(library);
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", {
      apiKey: "key",
      userId: "1234567",
    });

    const { syncProfile } = await import("@/lib/capture/zotero");
    expect((await syncProfile("andres"))?.imported).toBe(1);
    users.setZoteroConfig("andres", {
      apiKey: "key",
      userId: "1234567",
      target: { type: "group", id: "77", name: "Research Group" },
    });
    expect((await syncProfile("andres"))?.imported).toBe(1);

    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toHaveLength(2);
    expect(
      papers
        .listPapers()
        .map((paper) => paper.meta.source?.libraryId)
        .sort(),
    ).toEqual(["1234567", "77"]);
    expect(calls.some((call) => call.startsWith("/users/1234567/items"))).toBe(
      true,
    );
    expect(calls.some((call) => call.startsWith("/groups/77/items"))).toBe(
      true,
    );
    expect(
      calls.some((call) => call === "/groups/77/items/ATTACH01/file"),
    ).toBe(true);
  });

  it("includes descendant collections and resets scope when filters broaden", async () => {
    mockAgent("A Guessed Title");
    const library = paperLibrary("https://example.org/first");
    library.items[0].data.collections = ["CHILD01"];
    library.items.push(
      {
        key: "PARENT02",
        version: 41,
        data: {
          key: "PARENT02",
          version: 41,
          itemType: "report",
          title: "Sibling Collection Paper",
          creators: [{ creatorType: "author", name: "Research Lab" }],
          date: "2025",
          collections: ["SIBLING"],
          url: "https://example.org/second",
        },
      },
      {
        key: "ATTACH02",
        version: 42,
        data: {
          key: "ATTACH02",
          version: 42,
          itemType: "attachment",
          parentItem: "PARENT02",
          contentType: "application/pdf",
        },
      },
    );
    library.files.ATTACH02 = Buffer.from("%PDF-1.4 sibling");
    library.collections = [
      { key: "ROOT01", name: "Root" },
      { key: "CHILD01", name: "Child", parentCollection: "ROOT01" },
      { key: "SIBLING", name: "Sibling" },
    ];
    stubZoteroApi(library);
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", {
      apiKey: "key",
      userId: "1234567",
      collectionKeys: ["ROOT01"],
    });

    const { syncProfile } = await import("@/lib/capture/zotero");
    expect(await syncProfile("andres")).toMatchObject({
      imported: 1,
      skipped: 1,
    });
    users.setZoteroConfig("andres", {
      apiKey: "key",
      userId: "1234567",
      collectionKeys: [],
    });
    expect(await syncProfile("andres")).toMatchObject({
      imported: 1,
      updated: 1,
    });
    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toHaveLength(2);
  });

  it("refreshes Zotero metadata without touching the paper artifacts", async () => {
    mockAgent("A Guessed Title");
    const library = paperLibrary("https://example.org/paper");
    const calls = stubZoteroApi(library);
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });

    const { syncProfile } = await import("@/lib/capture/zotero");
    await syncProfile("andres");
    const papers = await import("@/lib/library/papers");
    const before = papers.listPapers()[0];
    const pdfBefore = fs.readFileSync(before.pdfPath);
    const summaryBefore = before.summary;
    const addedAtBefore = before.meta.addedAt;

    library.version = 43;
    library.items[0].version = 43;
    library.items[0].data.version = 43;
    library.items[0].data.title = "Attention Is Still All You Need";
    library.items[0].data.tags = [{ tag: "Transformers Updated" }];
    const result = await syncProfile("andres");
    expect(result).toEqual({
      imported: 0,
      updated: 1,
      skipped: 0,
      failed: 0,
    });

    const after = papers.listPapers()[0];
    expect(after.slug).toBe(before.slug);
    expect(after.topic).toBe(before.topic);
    expect(after.meta.title).toBe("Attention Is Still All You Need");
    expect(after.meta.tags).toEqual(["synced", "Transformers Updated"]);
    expect(after.meta.addedAt).toBe(addedAtBefore);
    expect(after.summary).toBe(summaryBefore);
    expect(fs.readFileSync(after.pdfPath)).toEqual(pdfBefore);
    expect(calls.filter((call) => call.includes("ATTACH01/file"))).toHaveLength(
      1,
    );
  });

  it("discovers an unchanged PDF when a parent enters a selected collection", async () => {
    mockAgent("A Guessed Title");
    const library = paperLibrary("https://example.org/first");
    library.items[0].data.collections = ["INCLUDED"];
    library.items.push(
      {
        key: "PARENT02",
        version: 41,
        data: {
          key: "PARENT02",
          version: 41,
          itemType: "report",
          title: "Moves Into Scope",
          creators: [{ creatorType: "author", name: "Research Lab" }],
          date: "2025",
          collections: ["OTHER"],
          url: "https://example.org/second",
        },
      },
      {
        key: "ATTACH02",
        version: 42,
        data: {
          key: "ATTACH02",
          version: 42,
          itemType: "attachment",
          parentItem: "PARENT02",
          contentType: "application/pdf",
        },
      },
    );
    library.files.ATTACH02 = Buffer.from("%PDF-1.4 later");
    library.collections = [
      { key: "INCLUDED", name: "Included" },
      { key: "OTHER", name: "Other" },
    ];
    const calls = stubZoteroApi(library);
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", {
      apiKey: "key",
      userId: "1234567",
      collectionKeys: ["INCLUDED"],
    });

    const { syncProfile } = await import("@/lib/capture/zotero");
    expect((await syncProfile("andres"))?.imported).toBe(1);
    library.version = 43;
    library.items[2].version = 43;
    library.items[2].data.version = 43;
    library.items[2].data.collections = ["INCLUDED"];
    expect(await syncProfile("andres")).toMatchObject({ imported: 1 });
    expect(
      calls.some((call) =>
        call.startsWith("/users/1234567/items/PARENT02/children"),
      ),
    ).toBe(true);
  });

  it("refreshes collection display names through stable collection keys", async () => {
    mockAgent("A Guessed Title");
    const library = paperLibrary("https://example.org/paper");
    stubZoteroApi(library);
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    users.setZoteroConfig("andres", { apiKey: "key", userId: "1234567" });

    const { syncProfile } = await import("@/lib/capture/zotero");
    await syncProfile("andres");
    library.version = 43;
    library.collections![0].name = "Renamed Models";
    expect(await syncProfile("andres")).toMatchObject({ updated: 1 });

    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()[0].meta.source?.collectionKeys).toEqual([
      "COLL01",
    ]);
    expect(papers.listPapers()[0].meta.source?.collections).toEqual([
      "Renamed Models",
    ]);
  });
});
