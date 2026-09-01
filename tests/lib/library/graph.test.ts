import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-graph-"));
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

function citesEdges(graph: {
  edges: { source: string; target: string; kind: string }[];
}) {
  return graph.edges
    .filter((e) => e.kind === "cites")
    .map((e) => `${e.source}->${e.target}`);
}

describe("library graph citation edges", () => {
  it("draws a directed cites edge from the citing paper's bibliography", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "We propose the Transformer.\n\nReferences\n\n[1] Some unrelated work on parsing.",
    );
    await placePaper(
      "nlp",
      "bert",
      "BERT: Pre-training of Deep Bidirectional Transformers",
      "BERT builds on the Transformer.\n\nReferences\n\n" +
        "[1] Vaswani, A., et al. Attention is all you need. NeurIPS 2017.\n" +
        "[2] Peters, M., et al. Deep contextualized word representations.",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    const edges = citesEdges(buildLibraryGraph());
    expect(edges).toEqual(["paper:bert->paper:attention"]);
  });

  it("ignores a title mentioned only in the body, not the reference list", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "nlp",
      "survey",
      "A Survey of Sequence Models",
      "Attention is all you need, as the saying goes in the intro.\n" +
        "Lots of body text follows here to push the mention out of the tail.\n".repeat(
          20,
        ) +
        "References\n\n[1] Sutskever, I. Sequence to sequence learning.",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([]);
  });

  it("does not cite a paper whose title words are scattered across different entries", async () => {
    await placePaper(
      "cv",
      "resnet",
      "Deep Residual Learning for Image Recognition",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "cv",
      "later-work",
      "Some Later Vision Work",
      "Body.\n\nReferences\n\n" +
        "[1] He, K. Identity mappings in deep residual networks.\n" +
        "[2] Krizhevsky, A. ImageNet classification with deep convolutional networks.\n" +
        "[3] Simonyan, K. Very deep convolutional networks for large-scale image recognition.\n" +
        "[4] LeCun, Y. Gradient-based learning applied to document recognition.",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([]);
  });

  it("matches a title wrapped across lines when entries have no markers", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "nlp",
      "follow-up",
      "A Follow-Up Study",
      "Body.\n\nReferences\n" +
        "Vaswani, A., Shazeer, N., Parmar, N. Attention is all\n" +
        "you need. In NeurIPS, 2017.\n" +
        "Devlin, J. Pre-training of deep bidirectional transformers.\n" +
        "Peters, M. Deep contextualized word representations.\n",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([
      "paper:follow-up->paper:attention",
    ]);
  });

  it("does not cite across entries of an author-year list split by a page break", async () => {
    await placePaper(
      "cv",
      "resnet",
      "Deep Residual Learning for Image Recognition",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "cv",
      "later-work",
      "Some Later Vision Work",
      "Body.\n\nReferences\n" +
        "Kaiming He, Xiangyu Zhang, Shaoqing Ren, and Jian Sun. 2016. Identity mappings\n" +
        "in deep residual networks. In ECCV.\n" +
        "Alex Krizhevsky, Ilya Sutskever, and Geoffrey Hinton. 2012. ImageNet classification\n" +
        "with deep convolutional neural networks. In NeurIPS.\n" +
        "Karen Simonyan and Andrew Zisserman. 2015. Very deep convolutional networks for\n" +
        "large-scale image recognition. In ICLR.\n" +
        "Yann LeCun, Léon Bottou, Yoshua Bengio, and Patrick Haffner. 1998. Gradient-based\n" +
        "learning applied to document recognition. Proceedings of the IEEE.\n" +
        "\f\n" +
        "Ashish Vaswani, Noam Shazeer, and Niki Parmar. 2017. Attention is all you\n" +
        "need. In NeurIPS.\n",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([]);
  });

  it("matches a wrapped title in a marker-less list that also spans a page break", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "nlp",
      "follow-up",
      "A Follow-Up Study",
      "Body.\n\nReferences\n" +
        "Devlin, J. Pre-training of deep bidirectional transformers.\n" +
        "Peters, M. Deep contextualized word representations.\n" +
        "\f\n" +
        "Radford, A. Language models are unsupervised multitask learners.\n" +
        "Sutskever, I. Sequence to sequence learning with neural networks.\n" +
        "Vaswani, A., Shazeer, N., Parmar, N. Attention is all\n" +
        "you need. In NeurIPS, 2017.\n" +
        "Wu, Y. Google's neural machine translation system.\n",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([
      "paper:follow-up->paper:attention",
    ]);
  });

  it("requires the exact phrase for short titles instead of a bag of words", async () => {
    await placePaper(
      "ml",
      "deep-learning",
      "Deep Learning",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "ml",
      "vision",
      "Some Vision Work",
      "Body.\n\nReferences\n\n" +
        "[1] Simonyan, K. Very deep convolutional networks for representation learning.\n",
    );
    await placePaper(
      "ml",
      "review",
      "A Review",
      "Body.\n\nReferences\n\n" +
        "[1] LeCun, Y., Bengio, Y., Hinton, G. Deep learning. Nature 521, 2015.\n",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([
      "paper:review->paper:deep-learning",
    ]);
  });

  it("uses the main bibliography, not a repeated running header on its last page", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "nlp",
      "long-paper",
      "A Long Paper",
      "Body text about many things in the introduction.\n".repeat(10) +
        "References\n" +
        "[1] Vaswani, A. Attention is all you need. NeurIPS 2017.\n" +
        "\f\n" +
        "References\n" +
        "[2] Sutskever, I. Sequence to sequence learning with neural networks.\n",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([
      "paper:long-paper->paper:attention",
    ]);
  });

  it("reflects a rewritten text.txt on the next build", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "nlp",
      "draft",
      "A Draft",
      "Body.\n\nReferences\n\n[1] Nothing yet.",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([]);
    const papers = await import("@/lib/library/papers");
    papers.writeText(
      "nlp",
      "draft",
      "Body.\n\nReferences\n\n[1] Vaswani, A. Attention is all you need. NeurIPS 2017.",
    );
    expect(citesEdges(buildLibraryGraph())).toEqual([
      "paper:draft->paper:attention",
    ]);
  });

  it("prefers a reader-scanned bibliography.json over the text heuristic", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    // The citing paper's text.txt bibliography names nothing; only the
    // scanned bibliography.json carries the real entry.
    await placePaper(
      "nlp",
      "citer",
      "A Citing Paper",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    const store = await import("@/lib/library/bibliography/store");
    store.writeBibliography("nlp", "citer", {
      style: "numbered",
      entries: [
        {
          pageNumber: 9,
          x: 40,
          y: 700,
          text: "[1] Vaswani, A., et al. Attention is all you need. NeurIPS 2017.",
          surname: "Vaswani",
          year: "2017",
          suffix: null,
          number: 1,
        },
      ],
    });
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([
      "paper:citer->paper:attention",
    ]);
  });

  it("falls back to the text heuristic when bibliography.json is corrupt", async () => {
    await placePaper(
      "nlp",
      "attention",
      "Attention Is All You Need",
      "Body.\n\nReferences\n\n[1] Nothing relevant.",
    );
    await placePaper(
      "nlp",
      "citer",
      "A Citing Paper",
      "Body.\n\nReferences\n\n[1] Vaswani, A. Attention is all you need. NeurIPS 2017.",
    );
    const store = await import("@/lib/library/bibliography/store");
    fs.writeFileSync(store.bibliographyPath("nlp", "citer"), "{not json");
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([
      "paper:citer->paper:attention",
    ]);
  });

  it("falls back to the tail of the text when no References heading exists", async () => {
    await placePaper("nlp", "attention", "Attention Is All You Need", "Body.");
    await placePaper(
      "nlp",
      "gpt",
      "Improving Language Understanding by Generative Pre-Training",
      "Body text about language models.\n".repeat(40) +
        "[1] Vaswani et al. Attention is all you need. 2017.",
    );
    const { buildLibraryGraph } = await import("@/lib/library/graph");
    expect(citesEdges(buildLibraryGraph())).toEqual([
      "paper:gpt->paper:attention",
    ]);
  });
});

describe("bibliographyEntries", () => {
  it("splits on blank lines and numbered markers", async () => {
    const { bibliographyEntries } = await import("@/lib/library/graph");
    expect(
      bibliographyEntries(
        "\n[1] First entry\ncontinued.\n[2] Second entry.\n\nThird entry.\n12. Fourth entry.",
      ),
    ).toEqual([
      "[1] First entry\ncontinued.",
      "[2] Second entry.",
      "Third entry.",
      "12. Fourth entry.",
    ]);
  });

  it("falls back to sliding line windows when no separator exists", async () => {
    const { bibliographyEntries } = await import("@/lib/library/graph");
    expect(bibliographyEntries("a\nb\nc\nd")).toEqual(["a b c", "b c d"]);
    expect(bibliographyEntries("a\nb")).toEqual(["a b"]);
  });

  it("caps a runaway marker-less bibliography instead of windowing every line", async () => {
    const { bibliographyEntries, MAX_BIBLIOGRAPHY_ENTRIES } =
      await import("@/lib/library/graph");
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const entries = bibliographyEntries(lines.join("\n"));
    expect(entries).toHaveLength(MAX_BIBLIOGRAPHY_ENTRIES);
    expect(entries[0]).toBe("line 0 line 1 line 2");
    const numbered = Array.from({ length: 3_000 }, (_, i) => `[${i}] entry`);
    expect(bibliographyEntries(numbered.join("\n"))).toHaveLength(
      MAX_BIBLIOGRAPHY_ENTRIES,
    );
  });

  it("windows each long marker-less chunk on its own, keeping marker entries whole", async () => {
    const { bibliographyEntries } = await import("@/lib/library/graph");
    expect(
      bibliographyEntries("a\nb\nc\nd\n\f\ne\nf\n\n[1] g\nh\ni\nj"),
    ).toEqual(["a b c", "b c d", "e f", "[1] g\nh\ni\nj"]);
  });
});

describe("graph route", () => {
  it("requires a session and throttles repeated rebuilds", async () => {
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => null,
    }));
    let route = await import("@/app/api/v1/graph/route");
    expect((await route.GET()).status).toBe(401);

    vi.doUnmock("@/lib/auth/session");
    vi.resetModules();
    vi.doMock("@/lib/auth/session", () => ({
      activeProfile: async () => ({ username: "andres" }),
    }));
    route = await import("@/app/api/v1/graph/route");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await route.GET()).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("bibliographyText", () => {
  it("slices from the first References heading in the second half", async () => {
    const { bibliographyText } = await import("@/lib/library/graph");
    expect(
      bibliographyText(
        "intro\nReferences\nearly mention\n7 References\n[1] real",
      ),
    ).toBe("\n[1] real");
    expect(
      bibliographyText(
        "x".repeat(60) + "\nReferences\n[1] real\nReferences\n[2] more",
      ),
    ).toBe("\n[1] real\nReferences\n[2] more");
  });

  it("falls back to the last heading when every heading is in the first half", async () => {
    const { bibliographyText } = await import("@/lib/library/graph");
    expect(bibliographyText("Contents\nReferences\n" + "x".repeat(40))).toBe(
      "\n" + "x".repeat(40),
    );
  });
});
