import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-lib-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function libs() {
  const papers = await import("@/lib/library/papers");
  const index = await import("@/lib/library/index-db");
  const dataDir = await import("@/lib/data-dir");
  dataDir.ensureDataDirs();
  return { ...papers, ...index };
}

function meta(
  title: string,
  overrides: Partial<import("@/lib/library/papers").PaperMeta> = {},
) {
  return {
    title,
    authors: ["Ada Lovelace"],
    year: 2024,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: ["ml"],
    related: [],
    sourceUrl: "https://example.com/paper.pdf",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
    ...overrides,
  };
}

/** Simulate a capture landing on disk (inbox) or a confirmed paper. */
async function placePaper(
  topic: string | null,
  slug: string,
  title: string,
  tags?: string[],
) {
  const lib = await libs();
  lib.writeMeta(topic, slug, meta(title, tags ? { tags } : {}));
  lib.writeText(topic, slug, `${title} full text about transformers`);
  const pdf = lib.pdfPath(topic, slug);
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4 fake");
  return lib;
}

describe("metadata mutation lifecycle", () => {
  it.each([".meta.123.tmp", ".meta.11111111-1111-4111-8111-111111111111.tmp"])(
    "removes old ownership from interrupted metadata file %s even after main metadata was anonymized",
    async (filename) => {
      const lib = await placePaper("ml", "metadata-retry", "Shared");
      const directory = lib.companionDir("ml", "metadata-retry");
      fs.copyFileSync(
        path.join(directory, "meta.json"),
        path.join(directory, filename),
      );
      lib.updateMeta("ml", "metadata-retry", (current) => ({
        ...current,
        addedBy: "deleted-profile",
      }));
      lib.anonymizePapersByUser("andres");
      expect(fs.existsSync(path.join(directory, filename))).toBe(false);
      expect(lib.readMeta("ml", "metadata-retry")?.title).toBe("Shared");
    },
  );

  it("retains unresolved temporary metadata and reports incomplete erasure", async () => {
    const lib = await placePaper("ml", "metadata-corrupt", "Shared");
    const file = path.join(
      lib.companionDir("ml", "metadata-corrupt"),
      ".meta.123.tmp",
    );
    fs.writeFileSync(file, "{broken");
    expect(() => lib.anonymizePapersByUser("andres")).toThrow();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("erases a title-renamed private capture after a crash before metadata publication", async () => {
    const lib = await libs();
    const { writeCaptureOwner } = await import("@/lib/capture/jobs/ownership");
    const original = lib.companionDir(null, "original-handle");
    fs.mkdirSync(original);
    writeCaptureOwner(original, { username: "andres", generation: 1 });
    fs.writeFileSync(lib.pdfPath(null, "original-handle"), "Private PDF");
    const renamed = lib.companionDir(null, "title-after-analysis");
    fs.renameSync(original, renamed);
    lib.anonymizePapersByUser("andres");
    expect(fs.existsSync(renamed)).toBe(false);
  });

  it("clears capture ownership when anonymizing a confirmed paper", async () => {
    const lib = await placePaper("ml", "owned-paper", "Shared");
    const { writeCaptureOwner, readCaptureOwner } =
      await import("@/lib/capture/jobs/ownership");
    writeCaptureOwner(lib.companionDir("ml", "owned-paper"), {
      username: "andres",
      generation: 1,
    });
    lib.anonymizePapersByUser("andres");
    expect(lib.readMeta("ml", "owned-paper")?.addedBy).toBe("deleted-profile");
    expect(readCaptureOwner(lib.companionDir("ml", "owned-paper"))).toBeNull();
    expect(fs.existsSync(lib.pdfPath("ml", "owned-paper"))).toBe(true);
  });

  it("retains attachment ownership after a deletion failure and completes on retry", async () => {
    const lib = await placePaper("ml", "retry-chat", "Chat");
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "retry-chat", "andres", "Private");
    chats.appendMessage("ml", "retry-chat", "andres", chat.id, {
      role: "user",
      content: "Private",
      at: new Date().toISOString(),
      images: ["crops/retry.png"],
    });
    const directory = lib.companionDir("ml", "retry-chat");
    const image = path.join(directory, "crops", "retry.png");
    fs.mkdirSync(path.dirname(image));
    fs.writeFileSync(image, "Private attachment");
    const remove = fs.rmSync.bind(fs);
    const fault = vi
      .spyOn(fs, "rmSync")
      .mockImplementation((target, options) => {
        if (target === image)
          throw Object.assign(new Error("Attachment deletion failed"), {
            code: "EIO",
          });
        return remove(target, options);
      });
    try {
      expect(() => chats.deleteChatsByUser("andres")).toThrow(
        "Attachment deletion failed",
      );
      expect(
        fs.existsSync(
          path.join(directory, "chats", "andres", `${chat.id}.jsonl`),
        ),
      ).toBe(true);
    } finally {
      fault.mockRestore();
    }
    chats.deleteChatsByUser("andres");
    expect(fs.existsSync(image)).toBe(false);
    expect(fs.existsSync(path.join(directory, "chats", "andres"))).toBe(false);
  });

  it.each([".tmp", ".tmp-11111111-1111-4111-8111-111111111111"])(
    "erases attachments referenced only by an interrupted chat write %s",
    async (suffix) => {
      const lib = await placePaper("ml", "temporary-chat", "Chat");
      const chats = await import("@/lib/library/chats");
      const chat = chats.createChat(
        "ml",
        "temporary-chat",
        "andres",
        "Private",
      );
      chats.appendMessage("ml", "temporary-chat", "andres", chat.id, {
        role: "user",
        content: "Private",
        at: new Date().toISOString(),
        images: ["crops/temporary.png"],
      });
      const directory = lib.companionDir("ml", "temporary-chat");
      const file = path.join(directory, "chats", "andres", `${chat.id}.jsonl`);
      fs.renameSync(file, `${file}${suffix}`);
      fs.mkdirSync(path.join(directory, "crops"));
      fs.writeFileSync(
        path.join(directory, "crops", "temporary.png"),
        "Private attachment",
      );
      chats.deleteChatsByUser("andres");
      expect(
        fs.existsSync(path.join(directory, "crops", "temporary.png")),
      ).toBe(false);
      expect(fs.existsSync(path.join(directory, "chats", "andres"))).toBe(
        false,
      );
    },
  );

  it("removes private chats and attachments from interrupted paper moves", async () => {
    const lib = await placePaper("old", "chat-move", "Chat");
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("old", "chat-move", "andres", "Private");
    chats.appendMessage("old", "chat-move", "andres", chat.id, {
      role: "user",
      content: "Private",
      at: new Date().toISOString(),
      images: ["crops/private.png"],
    });
    const crops = path.join(lib.companionDir("old", "chat-move"), "crops");
    fs.mkdirSync(crops, { recursive: true });
    fs.writeFileSync(path.join(crops, "private.png"), "Private image");
    const target = lib.companionDir("new", "chat-move");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(lib.companionDir("old", "chat-move"), target);
    chats.deleteChatsByUser("andres");
    expect(fs.existsSync(path.join(target, "chats", "andres"))).toBe(false);
    expect(fs.existsSync(path.join(target, "crops", "private.png"))).toBe(
      false,
    );
  });

  it("keeps corrupt chat ownership records so attachment cleanup can be repaired", async () => {
    const lib = await placePaper("ml", "corrupt-chat", "Chat");
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "corrupt-chat", "andres", "Private");
    const file = path.join(
      lib.companionDir("ml", "corrupt-chat"),
      "chats",
      "andres",
      `${chat.id}.jsonl`,
    );
    fs.appendFileSync(file, "{broken\n");
    expect(() => chats.deleteChatsByUser("andres")).toThrow();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("recovers available papers and reports busy moves for retry", async () => {
    const lib = await placePaper(null, "busy-move", "Busy");
    await placePaper(null, "ready-move", "Ready");
    for (const slug of ["busy-move", "ready-move"]) {
      const target = lib.companionDir("ml", slug);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(lib.companionDir(null, slug), target);
    }
    const { acquireFileLockSync } = await import("thesidedoor-core/storage");
    const release = acquireFileLockSync(
      path.join(tmpDir, "locks", "papers", "busy-move.guard"),
    );
    try {
      expect(lib.recoverInterruptedMoves()).toEqual(["busy-move"]);
      expect(fs.existsSync(lib.pdfPath("ml", "ready-move"))).toBe(true);
      expect(fs.existsSync(lib.pdfPath("ml", "busy-move"))).toBe(false);
    } finally {
      release();
    }
    expect(lib.recoverInterruptedMoves()).toEqual([]);
    expect(fs.existsSync(lib.pdfPath("ml", "busy-move"))).toBe(true);
  });

  it("erases private companion files even when the captured PDF is missing", async () => {
    const lib = await placePaper(null, "partial-private", "Private title");
    fs.rmSync(lib.pdfPath(null, "partial-private"));
    fs.writeFileSync(
      path.join(lib.companionDir(null, "partial-private"), "private-chat.json"),
      "Private chat",
    );
    lib.anonymizePapersByUser("andres");
    expect(fs.existsSync(lib.companionDir(null, "partial-private"))).toBe(
      false,
    );
  });

  it("reports unreadable ownership instead of declaring erasure successful", async () => {
    const lib = await placePaper(null, "corrupt-private", "Private title");
    fs.writeFileSync(
      path.join(lib.companionDir(null, "corrupt-private"), "meta.json"),
      "{broken",
    );
    expect(() => lib.anonymizePapersByUser("andres")).toThrow();
    expect(fs.existsSync(lib.companionDir(null, "corrupt-private"))).toBe(true);
  });

  it("anonymizes companion metadata before an interrupted move is recovered", async () => {
    const lib = await placePaper("old", "partial", "Partial");
    const target = lib.companionDir("new", "partial");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(lib.companionDir("old", "partial"), target);
    fs.writeFileSync(
      path.join(tmpDir, "papers", "000-readme.txt"),
      "Library files",
    );
    lib.anonymizePapersByUser("andres");
    lib.recoverInterruptedMoves();
    expect(lib.readMeta("new", "partial")?.addedBy).toBe("deleted-profile");
    expect(fs.existsSync(lib.pdfPath("new", "partial"))).toBe(true);
    expect(fs.existsSync(lib.pdfPath("old", "partial"))).toBe(false);
  });

  it("does not recreate an inbox capture after deletion", async () => {
    const lib = await placePaper(null, "removed", "Removed");
    lib.discardInboxCapture("removed", "andres");
    expect(() =>
      lib.updateMeta(null, "removed", (current) => ({
        ...current,
        title: "Late",
      })),
    ).toThrow("No paper");
    expect(fs.existsSync(lib.companionDir(null, "removed"))).toBe(false);
  });

  it("does not recreate the previous location after a move", async () => {
    const lib = await placePaper("old", "moving", "Moving");
    lib.movePaper("old", "moving", "new");
    expect(() => lib.updateMeta("old", "moving", (current) => current)).toThrow(
      "No paper",
    );
    expect(fs.existsSync(lib.companionDir("old", "moving"))).toBe(false);
    expect(lib.readMeta("new", "moving")?.title).toBe("Moving");
  });

  it("preserves anonymized ownership during subsequent metadata refresh", async () => {
    const lib = await placePaper("ml", "shared", "Original");
    lib.anonymizePapersByUser("andres");
    lib.updateMeta("ml", "shared", (current) => ({
      ...current,
      title: "Refreshed",
    }));
    expect(lib.readMeta("ml", "shared")).toMatchObject({
      title: "Refreshed",
      addedBy: "deleted-profile",
    });
  });

  it("leaves metadata and location unchanged when another worker holds the paper lock", async () => {
    const lib = await placePaper("ml", "busy", "Original");
    const { acquireFileLockSync } = await import("thesidedoor-core/storage");
    const release = acquireFileLockSync(
      path.join(tmpDir, "locks", "papers", "busy.guard"),
    );
    try {
      expect(() =>
        lib.updateMeta("ml", "busy", (current) => ({
          ...current,
          title: "Changed",
        })),
      ).toThrow("protected files are busy");
      expect(() => lib.movePaper("ml", "busy", "new")).toThrow(
        "protected files are busy",
      );
      expect(lib.readMeta("ml", "busy")?.title).toBe("Original");
      expect(fs.existsSync(lib.companionDir("new", "busy"))).toBe(false);
    } finally {
      release();
    }
  });
});

describe("slugify", () => {
  it("normalizes titles into safe folder names", async () => {
    const { slugify } = await import("@/lib/library/slug");
    expect(slugify("Attention Is All You Need")).toBe(
      "attention-is-all-you-need",
    );
    expect(slugify("  Diffusion — Models: A Survey!! ")).toBe(
      "diffusion-models-a-survey",
    );
    expect(slugify("Café Décor²")).toBe("cafe-decor2");
  });

  it("caps length and never emits path separators", async () => {
    const { slugify } = await import("@/lib/library/slug");
    const long = slugify("x".repeat(300));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
  });

  it("assertSlug rejects traversal attempts", async () => {
    const { assertSlug } = await import("@/lib/library/slug");
    expect(() => assertSlug("../escape")).toThrow();
    expect(() => assertSlug("a/b")).toThrow();
    expect(() => assertSlug("")).toThrow();
  });
});

describe("index scanner filtering", () => {
  it("rebuilds only for files that affect searchable paper state", async () => {
    const { affectsIndex } = await import("@/lib/library/scanner");
    expect(affectsIndex("/data/library/nlp/paper/meta.json")).toBe(true);
    expect(affectsIndex("/data/library/nlp/paper/summary.md")).toBe(true);
    expect(affectsIndex("/data/library/nlp/paper/text.txt")).toBe(true);
    expect(affectsIndex("/data/papers/nlp/paper.pdf")).toBe(true);
    expect(affectsIndex("/data/papers/nlp/paper.exercises.pdf")).toBe(false);
    expect(affectsIndex("/data/library/nlp/paper/canvas.json")).toBe(false);
    expect(affectsIndex("/data/library/nlp/paper/chats/ana/a.jsonl")).toBe(
      false,
    );
  });
});

describe("paper CRUD on disk", () => {
  it("lists confirmed papers and inbox separately", async () => {
    await placePaper("nlp", "attention", "Attention Is All You Need");
    const lib = await placePaper(null, "new-capture", "Fresh Capture");
    expect(lib.listPapers().map((p) => p.slug)).toEqual(["attention"]);
    expect(lib.listInbox().map((p) => p.slug)).toEqual(["new-capture"]);
  });

  it("accepts an inbox capture into a topic (PDF + companion move together)", async () => {
    const lib = await placePaper(null, "fresh", "Fresh Capture");
    const accepted = lib.acceptFromInbox("fresh", "nlp");
    expect(accepted.topic).toBe("nlp");
    expect(fs.existsSync(lib.pdfPath("nlp", "fresh"))).toBe(true);
    expect(
      fs.existsSync(path.join(lib.companionDir("nlp", "fresh"), "meta.json")),
    ).toBe(true);
    expect(lib.listInbox()).toHaveLength(0);
  });

  it("recovers an acceptance interrupted before the WebDAV commit", async () => {
    const lib = await placePaper(null, "fresh", "Fresh Capture");
    const destination = lib.companionDir("nlp", "fresh");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(lib.companionDir(null, "fresh"), destination);

    expect(fs.existsSync(lib.pdfPath("nlp", "fresh"))).toBe(false);
    lib.recoverInterruptedMoves();

    expect(fs.existsSync(lib.pdfPath("nlp", "fresh"))).toBe(true);
    expect(lib.getPaper("nlp", "fresh")?.meta.title).toBe("Fresh Capture");
  });

  it("recovers a topic move interrupted before its PDF rename", async () => {
    const lib = await placePaper("old-topic", "paper", "Paper");
    const destination = lib.companionDir("new-topic", "paper");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(lib.companionDir("old-topic", "paper"), destination);

    lib.recoverInterruptedMoves();

    expect(fs.existsSync(lib.pdfPath("old-topic", "paper"))).toBe(false);
    expect(fs.existsSync(lib.pdfPath("new-topic", "paper"))).toBe(true);
    expect(lib.getPaper("new-topic", "paper")?.meta.title).toBe("Paper");
  });

  it("only lets the capturing profile accept an inbox paper", async () => {
    const lib = await placePaper(null, "fresh", "Fresh Capture");
    expect(() => lib.acceptInboxCapture("fresh", "nlp", "ana")).toThrow(
      /No pending capture/,
    );
    expect(lib.listInbox()).toHaveLength(1);
    expect(lib.acceptInboxCapture("fresh", "nlp", "andres").topic).toBe("nlp");
  });

  it("uniqueSlug avoids collisions across library and inbox", async () => {
    await placePaper("nlp", "attention", "Attention");
    const lib = await placePaper(null, "attention-2", "Attention again");
    expect(lib.uniqueSlug("attention")).toBe("attention-3");
    expect(lib.uniqueSlug("brand-new")).toBe("brand-new");
  });

  it("finds duplicate sources across confirmed papers and the inbox", async () => {
    await placePaper("nlp", "attention", "Attention");
    const lib = await placePaper(null, "pending", "Pending", []);
    lib.writeMeta("nlp", "attention", {
      ...lib.readMeta("nlp", "attention")!,
      arxivId: "1706.03762v7",
      sourceUrl: "https://arxiv.org/abs/1706.03762v7",
    });
    expect(
      lib.findPaperBySource("https://arxiv.org/pdf/1706.03762", "1706.03762")
        ?.slug,
    ).toBe("attention");
    expect(
      lib.findPaperBySource(
        "https://example.com/paper.pdf?utm_source=test",
        null,
        "andres",
      )?.slug,
    ).toBe("pending");
    expect(
      lib.findPaperBySource(
        "https://example.com/paper.pdf?utm_source=test",
        null,
        "ana",
      ),
    ).toBeNull();
    // A caller-supplied pool is the whole search space: matching against an
    // empty snapshot finds nothing even though the paper exists on disk.
    expect(
      lib.findPaperBySource(
        "https://arxiv.org/abs/1706.03762",
        null,
        "andres",
        [],
      ),
    ).toBeNull();
  });

  it("only lets the capture owner discard an inbox paper", async () => {
    const lib = await placePaper(null, "pending", "Pending");
    expect(() => lib.discardInboxCapture("pending", "ana")).toThrow(
      /No pending capture/,
    );
    expect(lib.getPaper(null, "pending")).not.toBeNull();
    lib.discardInboxCapture("pending", "andres");
    expect(lib.getPaper(null, "pending")).toBeNull();
  });
});

describe("index rebuild from disk", () => {
  it("indexes papers and finds them by title, tag, and full text", async () => {
    const lib = await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      ["transformers"],
    );
    lib.rebuildIndex();
    expect(lib.searchIndex("attention").map((p) => p.slug)).toEqual([
      "attention",
    ]);
    expect(lib.searchIndex("transformers").map((p) => p.slug)).toEqual([
      "attention",
    ]);
    expect(lib.searchIndex("nonexistent-term-xyz")).toHaveLength(0);
    expect(lib.allTags()).toEqual(["transformers"]);
  });

  it("survives a moved file: rebuild reflects the new topic (disk wins)", async () => {
    const lib = await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
    );
    lib.rebuildIndex();
    expect(lib.allIndexed()[0].topic).toBe("nlp");

    // Move the paper by hand, as WebDAV or Finder would.
    fs.mkdirSync(path.join(tmpDir, "papers", "classics"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "library", "classics"), { recursive: true });
    fs.renameSync(
      lib.pdfPath("nlp", "attention"),
      lib.pdfPath("classics", "attention"),
    );
    fs.renameSync(
      lib.companionDir("nlp", "attention"),
      lib.companionDir("classics", "attention"),
    );

    lib.rebuildIndex();
    const indexed = lib.allIndexed();
    expect(indexed).toHaveLength(1);
    expect(indexed[0].topic).toBe("classics");
  });

  it("a rebuilt index is identical after deleting index.db (disk is truth)", async () => {
    const lib = await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
    );
    lib.rebuildIndex();
    const before = lib.allIndexed();
    lib.closeIndex();
    fs.rmSync(path.join(tmpDir, "index.db"));
    lib.rebuildIndex();
    expect(lib.allIndexed()).toEqual(before);
  });

  it("search with FTS syntax characters never throws", async () => {
    const lib = await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
    );
    lib.rebuildIndex();
    expect(() => lib.searchIndex('att* AND "quo)tes" NEAR(')).not.toThrow();
  });

  it("searchChunks finds the passage for a question and survives FTS syntax", async () => {
    const lib = await placePaper("nlp", "attention", "Attention");
    lib.writeText(
      "nlp",
      "attention",
      `Introduction paragraph about sequence transduction.\n\n` +
        `The ablation on zebrafish imaging shows optical clearing helps.\n\n` +
        `Unrelated closing remarks about future work.`,
    );
    lib.rebuildIndex();
    const { searchChunks, chunkText } = await import("@/lib/library/index-db");
    const hits = searchChunks("attention", "zebrafish optical clearing?");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].body).toContain("zebrafish imaging");
    expect(() =>
      searchChunks("attention", 'zeb* AND "quo)tes" NEAR('),
    ).not.toThrow();
    // Offsets point back into the original text.
    const chunks = chunkText("aa\n\nbb\n\ncc");
    expect(chunks.map((c) => c.body)).toEqual(["aa\n\nbb\n\ncc"]);
    const long = chunkText(`${"x".repeat(1500)}\n\n${"y".repeat(100)}`);
    expect(long.length).toBeGreaterThan(1);
    expect(long[1].start).toBeGreaterThan(0);
  });

  it("shows inbox papers only when the inbox filter is selected", async () => {
    await placePaper("nlp", "confirmed", "Confirmed");
    const lib = await placePaper(null, "pending", "Pending");
    lib.rebuildIndex();
    const { matchesLibraryFilters } =
      await import("@/lib/library/citations/filters");
    const indexed = lib.allIndexed();
    const allPapers = indexed.filter((paper) =>
      matchesLibraryFilters(paper, { tag: null, topic: null }),
    );
    const inbox = indexed.filter((paper) =>
      matchesLibraryFilters(paper, { tag: null, topic: "_inbox" }),
    );
    expect(allPapers.map((paper) => paper.slug)).toEqual(["confirmed"]);
    expect(inbox.map((paper) => paper.slug)).toEqual(["pending"]);
  });

  it("shows confirmed papers and only the active profile's inbox metadata", async () => {
    await placePaper("nlp", "confirmed", "Confirmed", ["shared"]);
    await placePaper(null, "andres-pending", "Andres pending", ["andres-tag"]);
    const lib = await placePaper(null, "ana-pending", "Ana pending", [
      "private-tag",
    ]);
    lib.writeMeta(null, "ana-pending", {
      ...lib.readMeta(null, "ana-pending")!,
      addedBy: "ana",
    });
    lib.rebuildIndex();
    const { isPaperVisibleToProfile } =
      await import("@/lib/library/citations/filters");

    expect(
      lib
        .allIndexed()
        .filter((paper) => isPaperVisibleToProfile(paper, "andres"))
        .map((paper) => paper.slug)
        .sort(),
    ).toEqual(["andres-pending", "confirmed"]);
    expect(lib.allTags("andres")).toEqual(["andres-tag", "shared"]);
    expect(lib.allTags("ana")).toEqual(["private-tag", "shared"]);
  });
});

describe("library graph", () => {
  it("connects papers to authors, topic, tags, and related papers", async () => {
    const lib = await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      ["transformers"],
    );
    await placePaper("nlp", "bert", "BERT");
    lib.writeMeta("nlp", "attention", {
      ...lib.readMeta("nlp", "attention")!,
      related: ["bert", "nonexistent"],
    });
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    const graph = buildLibraryGraph();
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain("paper:attention");
    expect(ids).toContain("paper:bert");
    expect(ids).toContain("topic:nlp");
    expect(ids).toContain("author:ada lovelace");
    expect(ids).toContain("tag:transformers");
    expect(
      graph.edges.some(
        (e) =>
          e.kind === "related" &&
          e.source === "paper:attention" &&
          e.target === "paper:bert",
      ),
    ).toBe(true);
    // related links to papers outside the library are dropped
    expect(graph.edges.every((e) => e.target !== "paper:nonexistent")).toBe(
      true,
    );
    const paper = graph.nodes.find((n) => n.id === "paper:attention");
    expect(paper?.href).toBe("/paper/nlp/attention");
  });
});
