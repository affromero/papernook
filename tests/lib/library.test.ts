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

  it("uniqueSlug avoids collisions across library and inbox", async () => {
    await placePaper("nlp", "attention", "Attention");
    const lib = await placePaper(null, "attention-2", "Attention again");
    expect(lib.uniqueSlug("attention")).toBe("attention-3");
    expect(lib.uniqueSlug("brand-new")).toBe("brand-new");
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
