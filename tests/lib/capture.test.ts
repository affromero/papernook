import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-cap-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
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

describe("capture error page", () => {
  it("escapes and preserves multiline diagnostic output", async () => {
    const { errorPage } = await import("@/app/add/pages");
    const html = errorPage("line one\n<script>alert('&')</script>");

    expect(html).toContain('class="error-details"');
    expect(html).toContain("white-space: pre-wrap");
    expect(html).toContain(
      "line one\n&lt;script&gt;alert(&#39;&amp;&#39;)&lt;/script&gt;",
    );
    expect(html).not.toContain("<script>");
  });
});

describe("capture download boundary", () => {
  interface LookupAddress {
    address: string;
    family: number;
  }

  type ConnectLookup = (
    hostname: string,
    options: { all?: boolean },
    callback: (
      error: Error | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => void;

  function mockNetwork(
    fetchMock = vi.fn(),
    address: string | string[] = "93.184.216.34",
  ) {
    const lookupCalls: ConnectLookup[] = [];
    vi.doMock("node:dns/promises", () => ({
      lookup: async () =>
        (Array.isArray(address) ? address : [address]).map((address) => ({
          address,
        })),
    }));
    vi.doMock("undici", () => ({
      fetch: fetchMock,
      Agent: class {
        constructor(options: { connect: { lookup: ConnectLookup } }) {
          lookupCalls.push(options.connect.lookup);
        }

        async close() {}
      },
    }));
    return { fetchMock, lookupCalls };
  }

  it("rejects private network targets before issuing a fetch", async () => {
    const { fetchMock } = mockNetwork();
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(downloadPdf("http://127.0.0.1/private.pdf")).rejects.toThrow(
      /public internet addresses/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects bracketed IPv6 loopback literals before issuing a fetch", async () => {
    const { fetchMock } = mockNetwork();
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(downloadPdf("http://[::1]/private.pdf")).rejects.toThrow(
      /public internet addresses/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects URLs with unsupported schemes or embedded credentials", async () => {
    const { fetchMock } = mockNetwork();
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(downloadPdf("file:///etc/passwd")).rejects.toThrow(
      /HTTP or HTTPS/,
    );
    await expect(
      downloadPdf("https://token@papers.example/paper.pdf"),
    ).rejects.toThrow(/cannot include credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects hostnames that resolve to a private network address", async () => {
    const { fetchMock } = mockNetwork(vi.fn(), "10.0.0.8");
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(
      downloadPdf("https://papers.example/paper.pdf"),
    ).rejects.toThrow(/public internet addresses/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    const { fetchMock } = mockNetwork(vi.fn(), ["93.184.216.34", "10.0.0.8"]);
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(
      downloadPdf("https://papers.example/paper.pdf"),
    ).rejects.toThrow(/public internet addresses/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["::7f00:1", "::ffff:7f00:1", "::ffff:127.0.0.1"])(
    "rejects IPv6 loopback forms (%s)",
    async (address) => {
      const { fetchMock } = mockNetwork(vi.fn(), address);
      const { downloadPdf } = await import("@/lib/capture/download");

      await expect(
        downloadPdf("https://papers.example/paper.pdf"),
      ).rejects.toThrow(/public internet addresses/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("pins the connection lookup to the public address it validated", async () => {
    const { lookupCalls } = mockNetwork(
      vi.fn().mockResolvedValue(
        new Response("%PDF-1.4", {
          headers: { "content-type": "application/pdf" },
        }),
      ),
      "93.184.216.34",
    );
    const { downloadPdf } = await import("@/lib/capture/download");

    await downloadPdf("https://papers.example/paper.pdf");
    let result: [Error | null, string | LookupAddress[], number?] | undefined;
    lookupCalls[0]("papers.example", {}, (...args) => {
      result = args;
    });
    expect(result).toEqual([null, "93.184.216.34", 4]);
  });

  it("returns the pinned address list when the connector requests all results", async () => {
    const { lookupCalls } = mockNetwork(
      vi.fn().mockResolvedValue(
        new Response("%PDF-1.4", {
          headers: { "content-type": "application/pdf" },
        }),
      ),
      "93.184.216.34",
    );
    const { downloadPdf } = await import("@/lib/capture/download");

    await downloadPdf("https://papers.example/paper.pdf");
    let result: [Error | null, string | LookupAddress[], number?] | undefined;
    lookupCalls[0]("papers.example", { all: true }, (...args) => {
      result = args;
    });
    expect(result).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });

  it("rejects redirects into a private network", async () => {
    const { fetchMock } = mockNetwork(
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private.pdf" },
        }),
      ),
    );
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(
      downloadPdf("https://papers.example/paper.pdf"),
    ).rejects.toThrow(/public internet addresses/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns network failures into safe capture errors", async () => {
    const networkError = new Error("socket reset");
    mockNetwork(vi.fn().mockRejectedValue(networkError));
    const { downloadPdf } = await import("@/lib/capture/download");

    const capture = downloadPdf("https://papers.example/paper.pdf");
    await expect(capture).rejects.toThrow(/Fetch failed/);
    await expect(capture).rejects.toHaveProperty("cause", networkError);
  });

  it("rejects oversized HTML before buffering it", async () => {
    mockNetwork(
      vi.fn().mockResolvedValue(
        new Response("", {
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        }),
      ),
    );
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(downloadPdf("https://papers.example/paper")).rejects.toThrow(
      /too large/,
    );
  });

  it("rejects oversized PDFs from their declared content length", async () => {
    mockNetwork(
      vi.fn().mockResolvedValue(
        new Response("%PDF-1.4", {
          headers: {
            "content-type": "application/pdf",
            "content-length": String(100 * 1024 * 1024 + 1),
          },
        }),
      ),
    );
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(
      downloadPdf("https://papers.example/paper.pdf"),
    ).rejects.toThrow(/too large/);
  });

  it("stops a streamed HTML response once it exceeds its byte limit", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    mockNetwork(
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );
    const { downloadPdf } = await import("@/lib/capture/download");

    await expect(downloadPdf("https://papers.example/paper")).rejects.toThrow(
      /too large/,
    );
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
  it("does not analyze or create a second capture for the same source", async () => {
    const papers = await import("@/lib/library/papers");
    papers.writeMeta("nlp", "existing", {
      title: "Existing",
      authors: [],
      year: null,
      venue: null,
      arxivId: "1706.03762",
      bibtex: null,
      tags: [],
      related: [],
      sourceUrl: "https://arxiv.org/abs/1706.03762",
      addedAt: new Date().toISOString(),
      addedBy: "andres",
    });
    const existingPdf = papers.pdfPath("nlp", "existing");
    fs.mkdirSync(path.dirname(existingPdf), { recursive: true });
    fs.writeFileSync(existingPdf, "%PDF-1.4");
    vi.doMock("@/lib/agent/registry", () => ({
      hasConfiguredProvider: () => true,
      getProvider: () => ({
        id: "test",
        execute: async () => {
          throw new Error("analysis should not run");
        },
        stream: async function* () {},
      }),
    }));
    const { capturePdf } = await import("@/lib/capture");
    await expect(
      capturePdf(Buffer.from("%PDF-1.4 duplicate"), {
        sourceUrl: "https://arxiv.org/pdf/1706.03762",
        arxivId: "1706.03762v2",
        username: "andres",
      }),
    ).rejects.toThrow(/already in your library/i);
    expect(papers.listPapers()).toHaveLength(1);
    expect(papers.listInbox()).toHaveLength(0);
    vi.doUnmock("@/lib/agent/registry");
  });

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
      hasConfiguredProvider: () => true,
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

  it("capturePdf autoFile skips the inbox and stamps source + needsReview", async () => {
    vi.doMock("@/lib/agent/registry", () => ({
      hasConfiguredProvider: () => true,
      getProvider: () => ({
        id: "claude-code",
        execute: async () =>
          JSON.stringify({
            title: "A Guessed Title",
            authors: ["AI Guess"],
            year: 2016,
            venue: null,
            bibtex: null,
            topic: "Transformers & Attention",
            tags: ["attention"],
            summary: "Synced paper summary.",
            related: [],
            starterQuestions: ["Why?"],
          }),
        stream: async function* () {},
      }),
    }));

    const { capturePdf } = await import("@/lib/capture");
    const result = await capturePdf(Buffer.from("%PDF-1.4 fake pdf"), {
      sourceUrl: "https://example.org/paper",
      username: "andres",
      autoFile: true,
      source: { provider: "zotero", key: "ABCD1234", version: 42 },
      overrides: { title: "Attention Is All You Need", year: 2017 },
    });

    const papers = await import("@/lib/library/papers");
    // Trusted metadata wins over the AI guess; slug follows the real title.
    expect(result.slug).toBe("attention-is-all-you-need");
    expect(papers.listInbox()).toHaveLength(0);
    const filed = papers.getPaper(result.proposedTopic, result.slug);
    expect(filed).not.toBeNull();
    expect(filed?.meta.title).toBe("Attention Is All You Need");
    expect(filed?.meta.year).toBe(2017);
    expect(filed?.meta.authors).toEqual(["AI Guess"]);
    expect(filed?.meta.source).toEqual({
      provider: "zotero",
      key: "ABCD1234",
      version: 42,
    });
    expect(filed?.meta.needsReview).toBe(true);
    expect(
      fs.existsSync(papers.pdfPath(result.proposedTopic, result.slug)),
    ).toBe(true);

    vi.doUnmock("@/lib/agent/registry");
  });

  it("waits for an active capture to clean up before profile erasure completes", async () => {
    let analysisStarted: (() => void) | undefined;
    let releaseAnalysis: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      analysisStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseAnalysis = resolve;
    });
    vi.doMock("@/lib/agent/registry", () => ({
      hasConfiguredProvider: () => true,
      getProvider: () => ({
        id: "codex",
        execute: async () => {
          analysisStarted?.();
          await release;
          return JSON.stringify({
            title: "Erased capture",
            authors: [],
            year: 2026,
            venue: null,
            bibtex: null,
            topic: "Private",
            tags: [],
            summary: "Private",
            related: [],
            starterQuestions: [],
          });
        },
        stream: async function* () {},
      }),
    }));
    const users = await import("@/lib/auth/users");
    users.createProfile("Andres");
    const { capturePdf } = await import("@/lib/capture");
    const capturePromise = capturePdf(Buffer.from("%PDF-1.4 fake pdf"), {
      sourceUrl: "https://example.test/private.pdf",
      username: "andres",
    });
    await started;

    const { beginProfileErasure } = await import("@/lib/auth/profile-activity");
    const erasure = beginProfileErasure("andres");
    releaseAnalysis?.();
    await expect(capturePromise).rejects.toThrow(/profile was deleted/i);
    const finishErasure = await erasure;
    users.deleteProfile("andres");
    finishErasure();

    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toEqual([]);
    expect(papers.listInbox()).toEqual([]);
    expect(users.getProfile("andres")).toBeNull();
    vi.doUnmock("@/lib/agent/registry");
  });

  it("serializes concurrent captures so title-derived slugs stay distinct", async () => {
    vi.doMock("@/lib/agent/registry", () => ({
      hasConfiguredProvider: () => true,
      getProvider: () => ({
        id: "test",
        execute: async () =>
          JSON.stringify({
            title: "Concurrent Paper",
            authors: [],
            year: null,
            venue: null,
            bibtex: null,
            topic: "Concurrency",
            tags: [],
            summary: "A concurrent capture.",
            related: [],
            starterQuestions: ["What is the contribution?"],
          }),
        stream: async function* () {},
      }),
    }));
    const { capturePdf } = await import("@/lib/capture");
    const results = await Promise.all([
      capturePdf(Buffer.from("%PDF-1.4 first"), {
        sourceUrl: "https://example.org/first",
        username: "andres",
        autoFile: true,
      }),
      capturePdf(Buffer.from("%PDF-1.4 second"), {
        sourceUrl: "https://example.org/second",
        username: "ana",
        autoFile: true,
      }),
    ]);

    expect(new Set(results.map((result) => result.slug)).size).toBe(2);
    const papers = await import("@/lib/library/papers");
    expect(papers.listPapers()).toHaveLength(2);
    expect(
      papers
        .listPapers()
        .every((paper) => fs.readFileSync(paper.pdfPath).length > 0),
    ).toBe(true);
    vi.doUnmock("@/lib/agent/registry");
  });

  it("removes inbox artifacts when AI analysis fails", async () => {
    vi.doMock("@/lib/agent/registry", () => ({
      hasConfiguredProvider: () => true,
      getProvider: () => ({
        id: "test",
        execute: async () => {
          throw new Error("provider unavailable");
        },
        stream: async function* () {},
      }),
    }));
    const { capturePdf } = await import("@/lib/capture");
    await expect(
      capturePdf(Buffer.from("%PDF-1.4 failed"), {
        sourceUrl: "https://example.org/failing-paper",
        username: "andres",
        autoFile: true,
      }),
    ).rejects.toThrow("provider unavailable");
    const papers = await import("@/lib/library/papers");
    expect(papers.listInbox()).toEqual([]);
    expect(papers.listPapers()).toEqual([]);
    vi.doUnmock("@/lib/agent/registry");
  });
});

describe("capture confirmation authorization", () => {
  it("does not let one valid capture token file another profile's inbox paper", async () => {
    const users = await import("@/lib/auth/users");
    const papers = await import("@/lib/library/papers");
    const { POST } = await import("@/app/add/confirm/route");
    const owner = users.createProfile("Owner");
    const other = users.createProfile("Other");
    papers.writeMeta(null, "private-capture", {
      title: "Private Capture",
      authors: [],
      year: null,
      venue: null,
      arxivId: null,
      bibtex: null,
      tags: [],
      related: [],
      sourceUrl: "https://example.com/paper.pdf",
      addedAt: new Date().toISOString(),
      addedBy: owner.username,
    });
    const pdf = papers.pdfPath(null, "private-capture");
    fs.writeFileSync(pdf, "%PDF-1.4");

    const form = new FormData();
    form.set("token", other.captureToken);
    form.set("slug", "private-capture");
    form.set("topic", "nlp");
    const response = await POST(
      new NextRequest("http://papernook.test/add/confirm", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(404);
    expect(papers.getPaper(null, "private-capture")).not.toBeNull();
    expect(fs.existsSync(papers.pdfPath("nlp", "private-capture"))).toBe(false);

    form.set("token", owner.captureToken);
    const ownerResponse = await POST(
      new NextRequest("http://papernook.test/add/confirm", {
        method: "POST",
        body: form,
      }),
    );
    expect(ownerResponse.status).toBe(200);
    expect(papers.getPaper("nlp", "private-capture")).not.toBeNull();
  });
});

describe("capture without an AI provider (no-AI mode)", () => {
  const noProviderRegistry = () => ({
    hasConfiguredProvider: () => false,
    getProvider: () => {
      throw new Error("getProvider must not run in no-AI mode");
    },
  });

  it("files with arXiv metadata under unsorted and seeds no chat", async () => {
    vi.doMock("@/lib/agent/registry", noProviderRegistry);
    const atom =
      "<feed><entry><title>Attention Is All You Need</title>" +
      "<author><name>Ashish Vaswani</name></author>" +
      "<author><name>Noam Shazeer</name></author>" +
      "<published>2017-06-12T00:00:00Z</published>" +
      "<summary>Sequence transduction with attention.</summary></entry></feed>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(atom, { status: 200 })),
    );

    const { capturePdf } = await import("@/lib/capture");
    const result = await capturePdf(Buffer.from("%PDF-1.4"), {
      sourceUrl: "https://arxiv.org/pdf/1706.03762",
      username: "andres",
      arxivId: "1706.03762",
    });

    expect(result.slug).toBe("attention-is-all-you-need");
    expect(result.proposedTopic).toBe("unsorted");
    expect(result.analysis.authors).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
    expect(result.analysis.year).toBe(2017);
    expect(result.analysis.venue).toBe("arXiv");
    expect(result.analysis.summary).toContain("attention");

    const chats = await import("@/lib/library/chats");
    expect(chats.listChats(null, result.slug, "andres")).toHaveLength(0);
    vi.doUnmock("@/lib/agent/registry");
  });

  it("still captures when every lookup fails, titling from the URL", async () => {
    vi.doMock("@/lib/agent/registry", noProviderRegistry);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const { capturePdf } = await import("@/lib/capture");
    const result = await capturePdf(Buffer.from("%PDF-1.4"), {
      sourceUrl: "https://example.com/papers/deep-thoughts.pdf",
      username: "andres",
    });

    expect(result.analysis.title).toBe("deep-thoughts");
    expect(result.proposedTopic).toBe("unsorted");
    const papers = await import("@/lib/library/papers");
    expect(papers.listInbox()).toHaveLength(1);
    vi.doUnmock("@/lib/agent/registry");
  });

  it("resolves Crossref metadata from a DOI found in the text", async () => {
    vi.doMock("@/lib/agent/registry", noProviderRegistry);
    const work = {
      message: {
        title: ["Deep Learning"],
        author: [{ given: "Yann", family: "LeCun" }],
        issued: { "date-parts": [[2015]] },
        "container-title": ["Nature"],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(work), { status: 200 })),
    );

    const { analyzePaper } = await import("@/lib/capture/analyze");
    const analysis = await analyzePaper(
      "https://example.com/x.pdf",
      "see DOI: 10.1038/nature14539 for details",
    );
    expect(analysis.title).toBe("Deep Learning");
    expect(analysis.authors).toEqual(["Yann LeCun"]);
    expect(analysis.year).toBe(2015);
    expect(analysis.venue).toBe("Nature");
    expect(analysis.topic).toBe("unsorted");
    vi.doUnmock("@/lib/agent/registry");
  });
});
