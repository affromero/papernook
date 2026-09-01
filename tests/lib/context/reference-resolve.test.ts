import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Resolver = typeof import("@/lib/library/context/reference-resolve");

const ENTRY_NO_URL =
  "Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J. Attention is all you need. In: NeurIPS (2017)";

function arxivFeed(entries: { id: string; title: string }[]): string {
  return `<?xml version="1.0"?><feed>${entries
    .map(
      (entry) =>
        `<entry><id>http://arxiv.org/abs/${entry.id}</id><title>${entry.title}</title></entry>`,
    )
    .join("")}</feed>`;
}

function crossrefWorks(items: { doi: string; title: string }[]): string {
  return JSON.stringify({
    message: {
      items: items.map((item) => ({ DOI: item.doi, title: [item.title] })),
    },
  });
}

const fetchedUrls: string[] = [];

function stubFetch(body: string | null): void {
  vi.stubGlobal("fetch", async (url: string) => {
    fetchedUrls.push(url);
    return body === null
      ? new Response("nope", { status: 503 })
      : new Response(body, { status: 200 });
  });
}

/** Route by host: arXiv and Crossref each answer with their body, 503 on null. */
function stubSearches(routes: {
  arxiv: string | null;
  crossref: string | null;
}): void {
  vi.stubGlobal("fetch", async (url: string) => {
    fetchedUrls.push(url);
    const body =
      new URL(url).hostname === "api.crossref.org"
        ? routes.crossref
        : routes.arxiv;
    return body === null
      ? new Response("nope", { status: 503 })
      : new Response(body, { status: 200 });
  });
}

let resolver: Resolver;

beforeEach(async () => {
  vi.resetModules();
  fetchedUrls.length = 0;
  resolver = await import("@/lib/library/context/reference-resolve");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("referenceUrlFromText", () => {
  it("derives arXiv, DOI, and printed URLs from the entry text", () => {
    expect(
      resolver.referenceUrlFromText(
        "Kerbl, B.: 3D Gaussian splatting. arXiv:2308.04079v2 (2023)",
      ),
    ).toBe("https://arxiv.org/abs/2308.04079");
    expect(
      resolver.referenceUrlFromText(
        "Smith, J. A study. J. Things 4 (2020). doi:10.1145/3592433.",
      ),
    ).toBe("https://doi.org/10.1145/3592433");
    expect(
      resolver.referenceUrlFromText(
        "Doe, A. Notes. https://example.org/paper.pdf.",
      ),
    ).toBe("https://example.org/paper.pdf");
    expect(resolver.referenceUrlFromText(ENTRY_NO_URL)).toBeNull();
  });

  it("does not mistake page ranges or years for arXiv ids", () => {
    expect(
      resolver.referenceUrlFromText("Proc. Conf., pp. 1999.2345–2350 (2019)"),
    ).toBeNull();
  });
});

describe("titleGuess", () => {
  it("prefers a quoted title and otherwise the longest non-author segment", () => {
    expect(
      resolver.titleGuess(
        'J. Smith and A. Doe, "Learning to see in the dark," in CVPR, 2018.',
      ),
    ).toBe("Learning to see in the dark");
    expect(resolver.titleGuess(ENTRY_NO_URL)).toBe("Attention is all you need");
    expect(resolver.titleGuess("Smith, J., Doe, A. (2020)")).toBeNull();
  });
});

describe("resolveReferenceUrl", () => {
  it("answers from the entry text without touching the network", async () => {
    stubFetch(null);
    expect(
      await resolver.resolveReferenceUrl(
        "Kerbl, B.: 3D Gaussian splatting. arXiv:2308.04079 (2023)",
      ),
    ).toEqual({ url: "https://arxiv.org/abs/2308.04079", title: null });
  });

  it("accepts an arXiv title hit only when it matches the entry", async () => {
    stubFetch(
      arxivFeed([
        { id: "1111.11111v1", title: "Attention is not what you need" },
        { id: "1706.03762v7", title: "Attention Is All You Need" },
      ]),
    );
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toEqual({
      url: "https://arxiv.org/abs/1706.03762",
      title: "Attention Is All You Need",
    });
    // arXiv's phrase search is positional: the title goes over whole,
    // stop words included, with only Lucene operators stripped. A hit
    // means Crossref is never consulted.
    expect(fetchedUrls).toEqual([
      expect.stringContaining(
        "search_query=ti%3A%22Attention%20is%20all%20you%20need%22",
      ),
    ]);
  });

  it("sends the full title phrase, only neutralising Lucene operators", async () => {
    stubSearches({ arxiv: arxivFeed([]), crossref: crossrefWorks([]) });
    await resolver.resolveReferenceUrl(
      'J. Smith and A. Doe, "Learning to see in the dark: a [real] study," in CVPR, 2018.',
    );
    expect(fetchedUrls[0]).toContain(
      encodeURIComponent('ti:"Learning to see in the dark a real study"'),
    );
  });

  it("returns null when neither source matches", async () => {
    stubSearches({
      arxiv: arxivFeed([{ id: "1111.11111", title: "Unrelated work" }]),
      crossref: crossrefWorks([{ doi: "10.1000/none", title: "Other thing" }]),
    });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toBeNull();
  });

  it("reports a lookup that did not complete as a failure, not a miss", async () => {
    stubFetch(null);
    const { LookupFailedError } = await import("@/lib/capture/arxiv/atom");
    await expect(
      resolver.resolveReferenceUrl(
        "Doe, A., Roe, B. Robust estimation of planar homographies. IJCV (2011)",
      ),
    ).rejects.toBeInstanceOf(LookupFailedError);
  });

  it("retries after a failed lookup instead of caching it as a miss", async () => {
    stubFetch(null);
    await expect(resolver.resolveReferenceUrl(ENTRY_NO_URL)).rejects.toThrow();
    stubFetch(
      arxivFeed([{ id: "1706.03762", title: "Attention Is All You Need" }]),
    );
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toEqual({
      url: "https://arxiv.org/abs/1706.03762",
      title: "Attention Is All You Need",
    });
  });

  it("remembers a miss so the same entry is never searched twice", async () => {
    stubSearches({ arxiv: arxivFeed([]), crossref: crossrefWorks([]) });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toBeNull();
    stubFetch(
      arxivFeed([{ id: "1706.03762", title: "Attention Is All You Need" }]),
    );
    expect(
      await resolver.resolveReferenceUrl(`  ${ENTRY_NO_URL}\n`),
    ).toBeNull();
  });
});

describe("resolveReferenceUrl crossref fallback", () => {
  it("falls back to a Crossref hit when arXiv misses", async () => {
    stubSearches({
      arxiv: arxivFeed([]),
      crossref: crossrefWorks([
        { doi: "10.5555/3295222", title: "Attention Is All You Need" },
      ]),
    });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toEqual({
      url: "https://doi.org/10.5555/3295222",
      title: "Attention Is All You Need",
    });
    expect(fetchedUrls[1]).toContain(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(
        "Attention is all you need",
      )}&rows=3`,
    );
  });

  it("percent-encodes a legacy DOI so the doi.org URL stays intact", async () => {
    stubSearches({
      arxiv: arxivFeed([]),
      crossref: crossrefWorks([
        {
          doi: "10.1002/(SICI)1097-0258(1996)15:2<361::AID-SIM168>3.0.CO;2-4",
          title: "Attention Is All You Need",
        },
      ]),
    });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toEqual({
      url: "https://doi.org/10.1002/(SICI)1097-0258(1996)15%3A2%3C361%3A%3AAID-SIM168%3E3.0.CO%3B2-4",
      title: "Attention Is All You Need",
    });
  });

  it("treats a non-JSON 200 body as a retryable failure, not a miss", async () => {
    stubSearches({ arxiv: arxivFeed([]), crossref: "<html>not json</html>" });
    const { LookupFailedError } = await import("@/lib/capture/arxiv/atom");
    await expect(
      resolver.resolveReferenceUrl(ENTRY_NO_URL),
    ).rejects.toBeInstanceOf(LookupFailedError);
    // Nothing cached: once Crossref answers with real JSON, the entry resolves.
    stubSearches({
      arxiv: arxivFeed([]),
      crossref: crossrefWorks([
        { doi: "10.5555/3295222", title: "Attention Is All You Need" },
      ]),
    });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toEqual({
      url: "https://doi.org/10.5555/3295222",
      title: "Attention Is All You Need",
    });
  });

  it("treats a response body over the byte budget as a failure", async () => {
    stubSearches({
      arxiv: arxivFeed([]),
      crossref: `{"pad":"${"x".repeat(1024 * 1024 + 1)}"}`,
    });
    const { LookupFailedError } = await import("@/lib/capture/arxiv/atom");
    await expect(
      resolver.resolveReferenceUrl(ENTRY_NO_URL),
    ).rejects.toBeInstanceOf(LookupFailedError);
  });

  it("rejects a Crossref item whose title the entry does not mention", async () => {
    stubSearches({
      arxiv: arxivFeed([]),
      crossref: crossrefWorks([
        { doi: "10.5555/999", title: "Attention is not what you need" },
      ]),
    });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toBeNull();
  });

  it("returns the Crossref hit when the arXiv lookup itself failed", async () => {
    stubSearches({
      arxiv: null,
      crossref: crossrefWorks([
        { doi: "10.5555/3295222", title: "Attention Is All You Need" },
      ]),
    });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toEqual({
      url: "https://doi.org/10.5555/3295222",
      title: "Attention Is All You Need",
    });
  });

  it("propagates a Crossref failure after an arXiv miss and caches nothing", async () => {
    stubSearches({ arxiv: arxivFeed([]), crossref: null });
    const { LookupFailedError } = await import("@/lib/capture/arxiv/atom");
    await expect(
      resolver.resolveReferenceUrl(ENTRY_NO_URL),
    ).rejects.toBeInstanceOf(LookupFailedError);
    // Nothing cached: the same entry retried with a healthy Crossref resolves.
    stubSearches({
      arxiv: arxivFeed([]),
      crossref: crossrefWorks([
        { doi: "10.5555/3295222", title: "Attention Is All You Need" },
      ]),
    });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toEqual({
      url: "https://doi.org/10.5555/3295222",
      title: "Attention Is All You Need",
    });
  });

  it("propagates the arXiv failure when Crossref completes but misses", async () => {
    stubSearches({ arxiv: null, crossref: crossrefWorks([]) });
    const { LookupFailedError } = await import("@/lib/capture/arxiv/atom");
    await expect(
      resolver.resolveReferenceUrl(ENTRY_NO_URL),
    ).rejects.toBeInstanceOf(LookupFailedError);
  });

  it("throws when both sources fail", async () => {
    stubSearches({ arxiv: null, crossref: null });
    const { LookupFailedError } = await import("@/lib/capture/arxiv/atom");
    await expect(
      resolver.resolveReferenceUrl(ENTRY_NO_URL),
    ).rejects.toBeInstanceOf(LookupFailedError);
  });

  it("caches a Crossref result so the entry is resolved once", async () => {
    stubSearches({
      arxiv: arxivFeed([]),
      crossref: crossrefWorks([
        { doi: "10.5555/3295222", title: "Attention Is All You Need" },
      ]),
    });
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toEqual({
      url: "https://doi.org/10.5555/3295222",
      title: "Attention Is All You Need",
    });
    stubSearches({ arxiv: null, crossref: null });
    expect(await resolver.resolveReferenceUrl(`  ${ENTRY_NO_URL}\n`)).toEqual({
      url: "https://doi.org/10.5555/3295222",
      title: "Attention Is All You Need",
    });
  });
});
