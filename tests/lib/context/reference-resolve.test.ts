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

const fetchedUrls: string[] = [];

function stubFetch(body: string | null): void {
  vi.stubGlobal("fetch", async (url: string) => {
    fetchedUrls.push(url);
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
    // stop words included, with only Lucene operators stripped.
    expect(fetchedUrls).toEqual([
      expect.stringContaining(
        "search_query=ti%3A%22Attention%20is%20all%20you%20need%22",
      ),
    ]);
  });

  it("sends the full title phrase, only neutralising Lucene operators", async () => {
    stubFetch(arxivFeed([]));
    await resolver.resolveReferenceUrl(
      'J. Smith and A. Doe, "Learning to see in the dark: a [real] study," in CVPR, 2018.',
    );
    expect(fetchedUrls[0]).toContain(
      encodeURIComponent('ti:"Learning to see in the dark a real study"'),
    );
  });

  it("returns null when nothing matches", async () => {
    stubFetch(arxivFeed([{ id: "1111.11111", title: "Unrelated work" }]));
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
    stubFetch(arxivFeed([]));
    expect(await resolver.resolveReferenceUrl(ENTRY_NO_URL)).toBeNull();
    stubFetch(
      arxivFeed([{ id: "1706.03762", title: "Attention Is All You Need" }]),
    );
    expect(
      await resolver.resolveReferenceUrl(`  ${ENTRY_NO_URL}\n`),
    ).toBeNull();
  });
});
