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
import { createProfile } from "@/lib/auth/users";
import { createSessionToken } from "@/lib/auth/session";

const session = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (session.token ? { value: session.token } : undefined),
  }),
}));
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "offline-export-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  createProfile("Alice");
  session.token = createSessionToken("alice");
});
afterEach(() => {
  session.token = "";
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("portable study exports", () => {
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
