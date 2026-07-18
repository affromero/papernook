import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-cap-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("URL normalization matrix", () => {
  it("rewrites arxiv abs pages (plain, versioned, old-style) to pdf URLs", async () => {
    const { normalizeUrl } = await import("@/lib/capture/normalize");
    expect(normalizeUrl("https://arxiv.org/abs/1706.03762")).toEqual({
      url: "https://arxiv.org/pdf/1706.03762",
      expectsPdf: true,
      arxivId: "1706.03762",
    });
    expect(normalizeUrl("https://arxiv.org/abs/1706.03762v7").url).toBe(
      "https://arxiv.org/pdf/1706.03762v7",
    );
    expect(normalizeUrl("https://arxiv.org/pdf/1706.03762.pdf").arxivId).toBe(
      "1706.03762",
    );
    expect(normalizeUrl("http://www.arxiv.org/abs/2405.12345/").url).toBe(
      "https://arxiv.org/pdf/2405.12345",
    );
  });

  it("passes raw PDF urls through and flags HTML pages for inspection", async () => {
    const { normalizeUrl } = await import("@/lib/capture/normalize");
    const raw = normalizeUrl("https://example.com/papers/foo.PDF");
    expect(raw.expectsPdf).toBe(true);
    const page = normalizeUrl("https://dl.acm.org/doi/10.1145/3576915");
    expect(page.expectsPdf).toBe(false);
  });

  it("rewrites openreview forum links to their pdf endpoint", async () => {
    const { normalizeUrl } = await import("@/lib/capture/normalize");
    expect(normalizeUrl("https://openreview.net/forum?id=abc123").url).toBe(
      "https://openreview.net/pdf?id=abc123",
    );
  });

  it("throws on garbage input", async () => {
    const { normalizeUrl } = await import("@/lib/capture/normalize");
    expect(() => normalizeUrl("not a url")).toThrow();
  });

  it("extracts citation_pdf_url (both attribute orders) and anchor fallbacks", async () => {
    const { pdfUrlFromHtml } = await import("@/lib/capture/normalize");
    expect(
      pdfUrlFromHtml(
        `<meta name="citation_pdf_url" content="/pdf/x.pdf">`,
        "https://pub.example.com/page",
      ),
    ).toBe("https://pub.example.com/pdf/x.pdf");
    expect(
      pdfUrlFromHtml(
        `<meta content="https://cdn.example.com/x.pdf" name="citation_pdf_url">`,
        "https://pub.example.com/page",
      ),
    ).toBe("https://cdn.example.com/x.pdf");
    expect(
      pdfUrlFromHtml(
        `<a href="files/paper.pdf?dl=1">download</a>`,
        "https://pub.example.com/page/",
      ),
    ).toBe("https://pub.example.com/page/files/paper.pdf?dl=1");
    expect(pdfUrlFromHtml(`<p>nothing here</p>`, "https://x.com")).toBeNull();
  });
});

describe("analysis parsing", () => {
  const valid = {
    title: "Attention Is All You Need",
    authors: ["Vaswani"],
    year: 2017,
    venue: "NeurIPS",
    bibtex: null,
    topic: "transformers",
    tags: ["attention"],
    summary: "A summary.",
    related: [],
    starterQuestions: ["Why self-attention?"],
  };

  it("parses clean JSON and JSON wrapped in markdown fences or prose", async () => {
    const { parseAnalysis } = await import("@/lib/capture/analyze");
    expect(parseAnalysis(JSON.stringify(valid)).title).toBe(valid.title);
    expect(
      parseAnalysis("```json\n" + JSON.stringify(valid) + "\n```").topic,
    ).toBe("transformers");
    expect(
      parseAnalysis("Here is the filing:\n" + JSON.stringify(valid)).year,
    ).toBe(2017);
  });

  it("rejects responses missing required fields", async () => {
    const { parseAnalysis } = await import("@/lib/capture/analyze");
    expect(() => parseAnalysis(JSON.stringify({ title: "x" }))).toThrow();
    expect(() => parseAnalysis("no json at all")).toThrow();
  });
});

describe("chat store round-trip", () => {
  it("creates, appends, reads back, and lists per-account chats", async () => {
    const { ensureDataDirs } = await import("@/lib/data-dir");
    ensureDataDirs();
    const chats = await import("@/lib/library/chats");

    const header = chats.createChat("nlp", "attention", "andres", "Starter");
    chats.appendMessage("nlp", "attention", "andres", header.id, {
      role: "user",
      content: "What is multi-head attention?",
      at: new Date().toISOString(),
    });
    chats.appendMessage("nlp", "attention", "andres", header.id, {
      role: "assistant",
      content: "It splits queries...",
      images: ["crops/1.png"],
      at: new Date().toISOString(),
    });

    const chat = chats.readChat("nlp", "attention", "andres", header.id);
    expect(chat?.messages).toHaveLength(2);
    expect(chat?.messages[1].images).toEqual(["crops/1.png"]);

    // Listing is per-account: another profile sees nothing.
    expect(chats.listChats("nlp", "attention", "andres")).toHaveLength(1);
    expect(chats.listChats("nlp", "attention", "ana")).toHaveLength(0);
  });

  it("rejects invalid chat ids (no traversal via chat id)", async () => {
    const chats = await import("@/lib/library/chats");
    expect(() =>
      chats.appendMessage("nlp", "attention", "andres", "../../evil", {
        role: "user",
        content: "x",
        at: "",
      }),
    ).toThrow(/Invalid chat id/);
  });
});

describe("capture orchestration (mocked download + agent)", () => {
  it("lands in the inbox with meta, summary, seeded chat; accept moves it", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4 fake pdf");
    vi.doMock("@/lib/capture/download", () => ({
      CaptureError: class extends Error {},
      downloadPdf: async () => ({
        bytes: pdfBytes,
        finalUrl: "https://arxiv.org/pdf/1706.03762",
        arxivId: "1706.03762",
      }),
    }));
    vi.doMock("@/lib/agent/registry", () => ({
      getProvider: () => ({
        id: "claude-code",
        execute: async () =>
          JSON.stringify({
            title: "Attention Is All You Need",
            authors: ["Vaswani et al."],
            year: 2017,
            venue: "NeurIPS",
            bibtex: null,
            topic: "Transformers & Attention",
            tags: ["attention", "transformers"],
            summary: "The transformer paper.",
            related: [],
            starterQuestions: ["Why attention?", "What is the complexity?"],
          }),
        stream: async function* () {},
      }),
    }));

    const { capture } = await import("@/lib/capture");
    const result = await capture("https://arxiv.org/abs/1706.03762", "andres");

    expect(result.slug).toBe("attention-is-all-you-need");
    expect(result.proposedTopic).toBe("transformers-attention");

    const papers = await import("@/lib/library/papers");
    const inbox = papers.listInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].meta.addedBy).toBe("andres");
    expect(inbox[0].meta.arxivId).toBe("1706.03762");
    expect(inbox[0].summary).toContain("transformer");

    const chats = await import("@/lib/library/chats");
    const seeded = chats.listChats(null, result.slug, "andres");
    expect(seeded).toHaveLength(1);
    expect(seeded[0].title).toBe("Starter questions");

    // Accept into the proposed topic — PDF appears in the WebDAV tree.
    papers.acceptFromInbox(result.slug, result.proposedTopic);
    expect(
      fs.existsSync(papers.pdfPath("transformers-attention", result.slug)),
    ).toBe(true);
    expect(papers.listInbox()).toHaveLength(0);
    expect(
      chats.listChats("transformers-attention", result.slug, "andres"),
    ).toHaveLength(1);

    vi.doUnmock("@/lib/capture/download");
    vi.doUnmock("@/lib/agent/registry");
  });
});
