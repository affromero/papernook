import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-reading-list-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function placePaper(
  topic: string,
  slug: string,
  title: string,
  text: string,
) {
  const papers = await import("@/lib/library/papers");
  const dataDir = await import("@/lib/data-dir");
  dataDir.ensureDataDirs();
  papers.writeMeta(topic, slug, {
    title,
    authors: ["Ada Lovelace"],
    year: 2024,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: `https://example.com/${slug}.pdf`,
    addedAt: new Date().toISOString(),
    addedBy: "andres",
  });
  papers.writeText(topic, slug, text);
  const pdf = papers.pdfPath(topic, slug);
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4 fake");
}

const ATTENTION_ENTRY =
  "[1] Vaswani, A., et al. Attention is all you need. NeurIPS 2017.";

describe("buildReadingList", () => {
  it("merges the same cited work across papers and lists both citers", async () => {
    await placePaper(
      "nlp",
      "bert",
      "BERT: Pre-training of Deep Bidirectional Transformers",
      `Body.\n\nReferences\n\n${ATTENTION_ENTRY}`,
    );
    await placePaper(
      "nlp",
      "gpt",
      "Improving Language Understanding by Generative Pre-Training",
      `Body.\n\nReferences\n\n${ATTENTION_ENTRY}`,
    );
    const { buildReadingList } =
      await import("@/lib/library/bibliography/reading-list");
    const items = buildReadingList();
    expect(items).toHaveLength(1);
    expect(items[0].count).toBe(2);
    expect(items[0].title).toBe("Attention is all you need");
    expect(items[0].entryText).toBe(ATTENTION_ENTRY);
    expect(items[0].citedBy.map((c) => c.slug).sort()).toEqual(["bert", "gpt"]);
    expect(items[0].citedBy.every((c) => c.topic === "nlp")).toBe(true);
  });

  it("excludes cited works that are already in the library", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "Body.\n\nReferences\n\n[1] Nothing relevant here at all.",
    );
    await placePaper(
      "nlp",
      "bert",
      "BERT: Pre-training of Deep Bidirectional Transformers",
      "Body.\n\nReferences\n\n" +
        `${ATTENTION_ENTRY}\n` +
        "[2] Peters, M., et al. Deep contextualized word representations. NAACL 2018.",
    );
    const { buildReadingList } =
      await import("@/lib/library/bibliography/reading-list");
    const titles = buildReadingList().map((item) => item.title);
    expect(titles).toContain("Deep contextualized word representations");
    expect(titles).not.toContain("Attention is all you need");
  });

  it("prefers a reader-scanned bibliography and caps the list at 50 items", async () => {
    await placePaper(
      "ml",
      "citer",
      "A Citing Paper",
      "Body.\n\nReferences\n\n[1] Only entry the text heuristic would see.",
    );
    const store = await import("@/lib/library/bibliography/store");
    store.writeBibliography("ml", "citer", {
      style: "numbered",
      entries: Array.from({ length: 60 }, (_, i) => ({
        pageNumber: 9,
        x: 40,
        y: 700,
        text: `[${i + 1}] Author, A. Study of unique research topic number ${i + 1} in modern systems. 2020.`,
        surname: "Author",
        year: "2020",
        suffix: null,
        number: i + 1,
      })),
    });
    const { buildReadingList, MAX_READING_LIST_ITEMS } =
      await import("@/lib/library/bibliography/reading-list");
    const items = buildReadingList();
    expect(items).toHaveLength(MAX_READING_LIST_ITEMS);
    // Scanned entries, not the text.txt heuristic, are the source.
    expect(
      items.some((item) => item.entryText.includes("text heuristic")),
    ).toBe(false);
    // Equal counts fall back to a stable title sort.
    const titles = items.map((item) => item.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  it("counts one vote per citing paper even when windows repeat an entry", async () => {
    await placePaper(
      "nlp",
      "wrapped",
      "A Paper With A Marker-Less List",
      "Body.\n\nReferences\n" +
        "Vaswani, A., Shazeer, N. Attention is all you need. NeurIPS 2017.\n" +
        "Vaswani, A., Shazeer, N. Attention is all you need. NeurIPS 2017.\n" +
        "Vaswani, A., Shazeer, N. Attention is all you need. NeurIPS 2017.\n" +
        "Vaswani, A., Shazeer, N. Attention is all you need. NeurIPS 2017.\n",
    );
    const { buildReadingList } =
      await import("@/lib/library/bibliography/reading-list");
    const attention = buildReadingList().filter(
      (item) => item.title === "Attention is all you need",
    );
    expect(attention).toHaveLength(1);
    expect(attention[0].count).toBe(1);
  });

  it("reflects a rewritten bibliography.json on the next build", async () => {
    await placePaper(
      "nlp",
      "citer",
      "A Citing Paper",
      "Body.\n\nReferences\n\n[1] Nothing relevant here at all.",
    );
    const store = await import("@/lib/library/bibliography/store");
    const entry = (text: string) => ({
      pageNumber: 9,
      x: 40,
      y: 700,
      text,
      surname: null,
      year: null,
      suffix: null,
      number: 1,
    });
    store.writeBibliography("nlp", "citer", {
      style: "numbered",
      entries: [entry(ATTENTION_ENTRY)],
    });
    const { buildReadingList } =
      await import("@/lib/library/bibliography/reading-list");
    expect(buildReadingList().map((item) => item.title)).toEqual([
      "Attention is all you need",
    ]);
    store.writeBibliography("nlp", "citer", {
      style: "numbered",
      entries: [
        entry(
          "[1] Peters, M., et al. Deep contextualized word representations. NAACL 2018.",
        ),
      ],
    });
    expect(buildReadingList().map((item) => item.title)).toEqual([
      "Deep contextualized word representations",
    ]);
  });

  it("returns an empty list for a library without bibliographies", async () => {
    const dataDir = await import("@/lib/data-dir");
    dataDir.ensureDataDirs();
    const { buildReadingList } =
      await import("@/lib/library/bibliography/reading-list");
    expect(buildReadingList()).toEqual([]);
  });
});

describe("reading-list route", () => {
  it("requires a session and returns items for a signed-in profile", async () => {
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => null,
    }));
    let route = await import("@/app/api/v1/reading-list/route");
    expect((await route.GET()).status).toBe(401);

    vi.doUnmock("@/lib/auth/session");
    vi.resetModules();
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => ({ username: "andres" }),
    }));
    await placePaper(
      "nlp",
      "bert",
      "BERT: Pre-training of Deep Bidirectional Transformers",
      `Body.\n\nReferences\n\n${ATTENTION_ENTRY}`,
    );
    route = await import("@/app/api/v1/reading-list/route");
    const response = await route.GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { title: string; count: number }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("Attention is all you need");
  });
});
