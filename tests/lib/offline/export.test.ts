import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentHtml,
  renderMarkdown,
  studyHtml,
} from "@/lib/offline/render";
import { conversationSnapshot, paperSnapshot } from "@/lib/offline/server";
import {
  createConversation,
  saveConversationTurn,
} from "@/lib/conversations/store";
import { createChat, appendMessage } from "@/lib/library/chats";
import { GET } from "@/app/api/v1/conversations/[id]/export/route";
import { createTestProfile, testSession } from "../../helpers/access";
import { pngFixture } from "../../helpers/png";
import { savePreview } from "@/lib/conversations/previews/cache";
import { previewHash } from "@/lib/conversations/previews/source";
import { richMessage } from "@/lib/conversations/content";
import { widgetParts } from "../../helpers/conversation-widgets";

const session = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (session.token ? { value: session.token } : undefined),
  }),
}));
let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "offline-export-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Alice");
  session.token = await testSession("alice");
});
afterEach(() => {
  session.token = "";
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("portable study exports", () => {
  it("embeds native widget plots and values in private source snapshots without depending on the provider", async () => {
    const parsed = richMessage(widgetParts);
    const source = createConversation("alice", {
      title: "Saved widgets",
      topic: "Research",
      tags: [],
      provider: "transcript",
      sourceUrl: "https://gemini.google.com/share/0123456789ab",
      messages: [{ role: "assistant", ...parsed }],
    });
    expect(conversationSnapshot("bob", source.id)).toBeNull();
    const response = await GET(
      new Request(
        `https://local/api/v1/conversations/${source.id}/export?format=html`,
      ),
      { params: Promise.resolve({ id: source.id }) },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Example City");
    expect(html).toContain("104.25 USD");
    expect(html).toContain("0 – Not provided");
    expect(html).toContain("Library");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
  });
  it("retains native card columns in the visible portable document", () => {
    const card = {
      type: "AdaptiveCard",
      body: [
        {
          type: "ColumnSet",
          columns: [
            {
              type: "Column",
              items: [{ type: "TextBlock", text: "Static world" }],
            },
            {
              type: "Column",
              items: [{ type: "TextBlock", text: "Dynamic scenario" }],
            },
          ],
        },
      ],
    };
    const body = renderMarkdown(
      `\`\`\`card-preview\n${JSON.stringify(card)}\n\`\`\``,
    );
    const visible = body.split("<details>")[0];
    expect(visible).toContain("Static world");
    expect(visible).toContain("Dynamic scenario");
    expect(visible).toContain('data-share-layout="grid"');
  });
  it("embeds saved visual snapshots and static notebook tables without executable provider content", () => {
    const source = "export default function App(){ return <p>Saved plot</p> }";
    const bytes = pngFixture();
    savePreview(directory, previewHash("react-preview", source), bytes);
    const html = studyHtml(
      "Saved displays",
      renderMarkdown(
        `\`\`\`react-preview\n${source}\n\`\`\`\n\n\`\`\`notebook-preview\n${JSON.stringify({ data: { "text/html": '<table><tr><th>Metric</th><td>42</td></tr></table><script>steal()</script><img src="https://example.com/leak"/><a href="javascript:steal()">Unsafe</a>' } })}\n\`\`\``,
        { base: directory },
      ),
    );
    expect(html).toContain(
      `src="data:image/png;base64,${bytes.toString("base64")}"`,
    );
    expect(html).toContain(
      "<table><tr><th>Metric</th><td>42</td></tr></table>",
    );
    expect(html).toContain("Display source");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('src="https://');
    expect(html).not.toContain('href="javascript:');
    expect(
      renderMarkdown("```mermaid\ngraph TD; A-->B\n```", { base: directory }),
    ).toContain("Save image for export");
  });
  it("keeps reading-list site icons compact and self-contained offline", () => {
    const body = renderMarkdown(
      '<row><favicon url="https://example.com/private?secret=value" size="24px"/><box flex="1"><Link url="https://example.com/guide" title="Reference guide"/></box></row>',
    );
    expect(body).not.toContain("<pre");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<button");
    expect(body).not.toContain("secret=value");
    expect(body).toContain('data-share-favicon-size="24"');
    expect(body).toContain('href="https://example.com/guide"');
    expect(body).toContain("Site icon for example.com");
  });

  it("preserves native shared layouts and applies attachment safety within their nested content", () => {
    const body = renderMarkdown(
      '<box border padding={3}><grid columns={2}><grid-item><text>Road map</text></grid-item><grid-item><text>Moving actors</text></grid-item></grid><icon name="arrow-down"/><text>**Execution** with $x^2$ and ![Remote](https://example.com/leak).</text></box>',
    );
    const html = studyHtml("Imported layout", body);
    expect(body).toContain('data-share-layout="grid"');
    expect(body).toContain('data-share-columns="2"');
    expect(body).toContain('data-share-icon="arrow-down"');
    expect(body).toContain("<strong>Execution</strong>");
    expect(body).toContain('class="katex"');
    expect(body).toContain("Image unavailable offline: Remote");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script");
    expect(html).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
  });
  it("embeds imported images and SVG diagrams with the same readable source content offline", () => {
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i0AAAAASUVORK5CYII=";
    const source = createConversation("alice", {
      title: "Rich source",
      topic: "Research",
      tags: [],
      provider: "chatgpt",
      messages: [
        {
          role: "assistant",
          content:
            '<box><text>Road diagram</text><AsyncImage ref="image0"/><Cite ref="turn1search0"/></box>\n\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>',
          assets: [{ kind: "image", name: "Road", ref: "image0", data }],
          citations: [
            {
              ref: "turn1search0",
              title: "Road reference",
              url: "https://example.com/road",
            },
          ],
        },
      ],
    });
    const html = conversationSnapshot("alice", source.id)?.sourceHtml ?? "";
    expect(html).toContain("Road diagram");
    expect(html).toContain(data);
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain("Road reference");
    expect(html).not.toContain("<AsyncImage");
    expect(html).not.toContain("<script");
  });
  it("renders imported LaTeX delimiters in portable exports while preserving code", () => {
    const body = renderMarkdown(
      String.raw`\(x^2\)

\[\frac{a}{b}\]

` + "`\\(literal\\)`",
    );
    expect(body).toContain('class="katex"');
    expect(body).toContain('class="katex-display"');
    expect(body).toContain("<code>\\(literal\\)</code>");
    expect(body).not.toContain("katex-error");
  });
  it("preserves Unicode, code, tables and math without executable HTML or remote images", () => {
    const body = renderMarkdown(
      "你好 café\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$x^2$\n\n```threejs\nalert('unsafe')\n```\n\n<script>alert(1)</script>\n\n![remote](https://example.com/image.png)\n\n[bad](javascript:alert%281%29)",
    );
    const html = studyHtml("<title>", body);
    expect(html).toContain("你好 café");
    expect(html).toContain("<table>");
    expect(html).toContain('class="katex"');
    expect(html).toContain("alert('unsafe')");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toContain("url(fonts/");
  });

  it("embeds only valid contained local images and labels missing or escaped attachments", () => {
    fs.mkdirSync(path.join(directory, "crops"));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    fs.writeFileSync(path.join(directory, "crops", "image.png"), png);
    expect(attachmentHtml(directory, "crops/image.png")).toContain(
      "data:image/png;base64,",
    );
    expect(attachmentHtml(directory, "crops/missing.png")).toContain(
      "Attachment unavailable",
    );
    fs.symlinkSync("/etc/hosts", path.join(directory, "crops", "escape.png"));
    expect(attachmentHtml(directory, "crops/escape.png")).toContain(
      "Attachment unavailable",
    );
    expect(attachmentHtml(directory, "../private.png")).toContain(
      "Attachment unavailable",
    );
  });

  it("exports an imported source after its original share is revoked and excludes other profiles", async () => {
    const source = createConversation("alice", {
      title: "Stored source",
      topic: "Research",
      tags: [],
      provider: "chatgpt",
      sourceUrl: "https://chatgpt.com/share/revoked",
      messages: [
        { role: "user", content: "Original question" },
        { role: "assistant", content: "Preserved answer α" },
      ],
    });
    saveConversationTurn(
      "alice",
      source.id,
      undefined,
      "Private follow-up",
      "Local answer",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Original share revoked");
      }),
    );
    try {
      expect(conversationSnapshot("bob", source.id)).toBeNull();
      expect(conversationSnapshot("alice", source.id)?.sourceHtml).toContain(
        "Preserved answer α",
      );
      const response = await GET(
        new Request(
          `https://local/api/v1/conversations/${source.id}/export?format=html`,
        ),
        { params: Promise.resolve({ id: source.id }) },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const html = await response.text();
      expect(html).toContain("Preserved answer α");
      expect(html).toContain("Private follow-up");
      const json = await GET(
        new Request(
          `https://local/api/v1/conversations/${source.id}/export?format=json&chats=false`,
        ),
        { params: Promise.resolve({ id: source.id }) },
      );
      expect(await json.json()).toMatchObject({
        messages: source.messages,
        chats: [],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("packages only the current profile's chats and requires the confirmed paper PDF", () => {
    const companion = path.join(directory, "library", "math", "paper");
    fs.mkdirSync(companion, { recursive: true });
    fs.mkdirSync(path.join(directory, "papers", "math"), { recursive: true });
    fs.writeFileSync(
      path.join(companion, "meta.json"),
      JSON.stringify({
        title: "Math",
        tags: [],
        addedAt: "2026-01-01",
        authors: [],
        related: [],
      }),
    );
    fs.writeFileSync(
      path.join(directory, "papers", "math", "paper.pdf"),
      "%PDF-1.7\n",
    );
    for (const owner of ["alice", "bob"]) {
      const chat = createChat("math", "paper", owner, `${owner} title`);
      appendMessage("math", "paper", owner, chat.id, {
        role: "user",
        content: `${owner} private`,
        at: "2026-01-01",
      });
    }
    const snapshot = paperSnapshot("alice", "math", "paper");
    expect(snapshot?.chats).toHaveLength(1);
    expect(snapshot?.chats[0].html).toContain("alice private");
    expect(JSON.stringify(snapshot)).not.toContain("bob private");
    expect(snapshot?.pdfUrl).toBe("/api/v1/papers/math/paper/pdf");
    fs.unlinkSync(path.join(directory, "papers", "math", "paper.pdf"));
    expect(paperSnapshot("alice", "math", "paper")).toBeNull();
  });
});
