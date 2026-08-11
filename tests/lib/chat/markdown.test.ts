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
  });

  it("keeps inline code compact and outside the highlighted frame", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: "Use `torch.linalg.lstsq` for the solve.",
      }),
    );

    expect(html).toContain("<code>torch.linalg.lstsq</code>");
    expect(html).not.toContain("hljs");
  });

  it("can defer syntax highlighting while a response is streaming", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: "```\nconst answer = 42;\n```",
        highlightCode: false,
      }),
    );

    expect(html).toContain("const answer = 42;");
    expect(html).not.toContain("hljs");
  });
});
