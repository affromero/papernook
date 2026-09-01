import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  collectSources,
  linksToCurrentPaper,
  normalizedPaperIdentity,
  pendingLookupUrls,
} from "@/lib/chat/message-sources";
import { MessageSources } from "@/components/chat/MessageSources";

describe("collectSources", () => {
  it("keeps repository links but not file permalinks already linked inline", () => {
    const sources = collectSources(
      [
        "See [train.py#L69-L71](https://github.com/org/repo/blob/0123456789abcdef0123456789abcdef01234567/train.py#L69-L71)",
        "in [the repo](https://github.com/org/repo) and",
        "[tree](https://github.com/org/repo/tree/main/src).",
      ].join(" "),
    );
    expect(sources.map((s) => s.url)).toEqual(["https://github.com/org/repo"]);
  });

  it("lists Markdown links and bare URLs in order, classified by host", () => {
    const sources = collectSources(
      [
        "Builds on [3D Gaussian Splatting](https://arxiv.org/abs/2308.04079) and",
        "the follow-up at https://doi.org/10.1145/3592433.",
        "Code: [repo](https://github.com/graphdeco-inria/gaussian-splatting).",
        "See also https://example.org/blog/post (a write-up).",
      ].join(" "),
    );
    expect(sources.map((s) => [s.kind, s.title, s.host])).toEqual([
      ["arxiv", "3D Gaussian Splatting", "arxiv.org"],
      ["github", "repo", "github.com"],
      ["doi", "doi:10.1145/3592433", "doi.org"],
      ["web", "example.org/blog/post", "example.org"],
    ]);
    expect(sources[2].url).toBe("https://doi.org/10.1145/3592433");
    expect(sources[3].url).toBe("https://example.org/blog/post");
  });

  it("collapses the same work linked several ways and keeps the titled mention", () => {
    const sources = collectSources(
      [
        "https://arxiv.org/pdf/2308.04079v2",
        "[Gaussian Splatting](https://arxiv.org/abs/2308.04079)",
        "https://www.arxiv.org/abs/2308.04079/",
      ].join("\n"),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].title).toBe("Gaussian Splatting");
    expect(sources[0].kind).toBe("arxiv");
  });

  it("drops links back to the open paper", () => {
    const sources = collectSources(
      "[This paper](https://arxiv.org/pdf/1706.03762.pdf) cites [BERT](https://arxiv.org/abs/1810.04805).",
      "https://arxiv.org/abs/1706.03762",
    );
    expect(sources.map((s) => s.title)).toEqual(["BERT"]);
  });

  it("ignores URLs inside fenced and inline code", () => {
    const sources = collectSources(
      [
        "Fetch it with `curl https://api.example.com/v1` first.",
        "```python",
        'requests.get("https://arxiv.org/abs/2308.04079")',
        "```",
        "Then read [the docs](https://docs.example.com/guide).",
      ].join("\n"),
    );
    expect(sources.map((s) => s.url)).toEqual([
      "https://docs.example.com/guide",
    ]);
  });

  it("does not list embedded images as sources", () => {
    const sources = collectSources(
      [
        "![Figure 2](https://cdn.example.org/figure.png) shows the split;",
        "compare ![](https://arxiv.org/html/2308.04079/x1.png) with",
        "[the paper](https://arxiv.org/abs/2308.04079).",
      ].join(" "),
    );
    expect(sources.map((s) => s.url)).toEqual([
      "https://arxiv.org/abs/2308.04079",
    ]);
  });

  it("returns nothing for relative links and non-web schemes", () => {
    expect(
      collectSources(
        "[Paper](/paper/ml/attention) [Section](#details) [mail](mailto:a@b.c)",
      ),
    ).toEqual([]);
  });
});

describe("pendingLookupUrls", () => {
  it("lists only paper links that have no cached lookup, in order", () => {
    const sources = collectSources(
      [
        "Builds on [Splatting](https://arxiv.org/abs/2308.04079),",
        "[the follow-up](https://doi.org/10.1145/3592433),",
        "[repo](https://github.com/org/repo), and",
        "[a write-up](https://example.org/blog/post).",
      ].join(" "),
    );
    expect(pendingLookupUrls(sources, new Set())).toEqual([
      "https://arxiv.org/abs/2308.04079",
      "https://doi.org/10.1145/3592433",
    ]);
    expect(
      pendingLookupUrls(sources, new Set(["https://arxiv.org/abs/2308.04079"])),
    ).toEqual(["https://doi.org/10.1145/3592433"]);
    expect(
      pendingLookupUrls(
        sources,
        new Set([
          "https://arxiv.org/abs/2308.04079",
          "https://doi.org/10.1145/3592433",
        ]),
      ),
    ).toEqual([]);
  });

  it("never asks for the same URL twice in one batch", () => {
    const source = {
      url: "https://arxiv.org/abs/2308.04079",
      title: "Splatting",
      kind: "arxiv" as const,
      host: "arxiv.org",
    };
    expect(pendingLookupUrls([source, { ...source }], new Set())).toEqual([
      "https://arxiv.org/abs/2308.04079",
    ]);
  });
});

describe("paper identity", () => {
  it("treats abs, pdf, and versioned arXiv URLs as the same paper", () => {
    expect(normalizedPaperIdentity("https://arxiv.org/abs/2512.06818v3")).toBe(
      "arxiv:2512.06818",
    );
    expect(
      linksToCurrentPaper(
        "https://arxiv.org/pdf/2512.06818.pdf",
        "https://arxiv.org/abs/2512.06818",
      ),
    ).toBe(true);
    expect(
      linksToCurrentPaper(
        "https://arxiv.org/abs/2512.06819",
        "https://arxiv.org/abs/2512.06818",
      ),
    ).toBe(false);
    expect(normalizedPaperIdentity("javascript:alert(1)")).toBeNull();
  });
});

describe("MessageSources card", () => {
  it("renders badges, hardened external links, and hosts for cited works", () => {
    const html = renderToStaticMarkup(
      createElement(MessageSources, {
        content:
          "See [Gaussian Splatting](https://arxiv.org/abs/2308.04079) and [repo](https://github.com/org/repo).",
        currentOrigin: "https://papernook.example",
      }),
    );
    expect(html).toContain("Sources &amp; related work");
    expect(html).toContain('data-kind="arxiv"');
    expect(html).toContain('data-kind="github"');
    expect(html).toContain(
      'href="https://arxiv.org/abs/2308.04079" target="_blank" rel="noopener noreferrer nofollow"',
    );
    expect(html).toContain("arxiv.org");
    expect(html).toContain("Gaussian Splatting");
  });

  it("renders nothing when the answer cites only the open paper or same-origin pages", () => {
    const html = renderToStaticMarkup(
      createElement(MessageSources, {
        content:
          "[Paper](https://arxiv.org/abs/1706.03762) [Library](https://papernook.example/paper/ml/attention)",
        currentOrigin: "https://papernook.example",
        paperSourceUrl: "https://arxiv.org/abs/1706.03762",
      }),
    );
    expect(html).toBe("");
  });
});
