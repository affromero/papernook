import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  saveConversationTurn,
  listConversationChats,
  lockConversation,
} from "@/lib/conversations/store";
import {
  importTranscript,
  parseShareHtml,
  shareProvider,
} from "@/lib/conversations/import";
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-test-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const source = {
  title: "A source",
  topic: "Physics",
  tags: ["math"],
  provider: "chatgpt" as const,
  sourceUrl: "https://chatgpt.com/share/00000000-0000-0000-0000-000000000001",
  messages: [
    { role: "user" as const, content: "Explain $α^2$" },
    { role: "assistant" as const, content: "```python\nprint('α')\n```" },
  ],
};
describe("private conversations", () => {
  it("retains a private source copy independently of its original URL and metadata edits", () => {
    const record = createConversation("alice", source);
    const original = fs.readFileSync(
      path.join(
        directory,
        "users",
        "alice",
        "conversations",
        record.id,
        "source.json",
      ),
      "utf8",
    );
    updateConversation("alice", record.id, {
      title: "Updated",
      topic: "Math",
      tags: [],
    });
    expect(getConversation("alice", record.id)).toMatchObject({
      title: "Updated",
      messages: source.messages,
      sourceUrl: source.sourceUrl,
    });
    expect(
      fs.readFileSync(
        path.join(
          directory,
          "users",
          "alice",
          "conversations",
          record.id,
          "source.json",
        ),
        "utf8",
      ),
    ).toBe(original);
    expect(getConversation("bob", record.id)).toBeNull();
    expect(listConversations("bob")).toEqual([]);
    expect(fs.existsSync(path.join(directory, "papers"))).toBe(false);
  });
  it("keeps follow-up histories separate from source and isolated by owner", () => {
    const record = createConversation("alice", source);
    saveConversationTurn("alice", record.id, undefined, "Why?", "Because.");
    expect(
      listConversationChats("alice", record.id)[0].messages.map(
        (message) => message.content,
      ),
    ).toEqual(["Why?", "Because."]);
    expect(listConversationChats("bob", record.id)).toEqual([]);
    expect(getConversation("alice", record.id)?.messages).toEqual(
      source.messages,
    );
    deleteConversation("alice", record.id);
    expect(getConversation("alice", record.id)).toBeNull();
  });
  it("refuses traversal and deletion while a reply is running", () => {
    expect(() => listConversations("../alice")).toThrow();
    const record = createConversation("alice", source);
    const unlock = lockConversation("alice", record.id);
    expect(() => deleteConversation("alice", record.id)).toThrow(
      "already running",
    );
    unlock();
    deleteConversation("alice", record.id);
    expect(listConversations("alice")).toEqual([]);
  });
});
describe("transcript import", () => {
  it("imports visible replies without hidden reasoning, tool requests or status records", () => {
    const reply = {
      role: "assistant",
      content: { content_type: "text", parts: ["Visible reply"] },
    };
    const payload = {
      messages: [
        { role: "user", content: "Question" },
        { ...reply, recipient: "web.run" },
        { ...reply, channel: "analysis" },
        { ...reply, metadata: { is_visually_hidden_from_conversation: true } },
        { ...reply, metadata: { is_redacted: true } },
        ...["thoughts", "reasoning_recap", "model_editable_context"].map(
          (content_type) => ({
            role: "assistant",
            content: { content_type, text: "Internal status" },
          }),
        ),
        { ...reply, channel: "final", recipient: "all" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "Private reasoning" },
            { type: "tool_use", text: "Tool arguments" },
            { type: "text", text: "Visible Claude reply" },
          ],
        },
      ],
    };
    expect(importTranscript(JSON.stringify(payload), "json").messages).toEqual([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Visible reply" },
      { role: "assistant", content: "Visible Claude reply" },
    ]);
  });
  it("preserves image-only turns with explicit unavailable attachment markers", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/private.png" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Explanation" },
            {
              type: "document",
              source: { url: "https://example.com/document" },
            },
          ],
        },
      ],
    };
    expect(importTranscript(JSON.stringify(payload), "json").messages).toEqual([
      { role: "user", content: "[Attachment unavailable in imported share]" },
      {
        role: "assistant",
        content: "Explanation\n\n[Attachment unavailable in imported share]",
      },
    ]);
  });
  it("rejects executable original-source links in supplied JSON", () => {
    expect(() =>
      createConversation("alice", {
        ...source,
        sourceUrl: "javascript:alert(1)",
      }),
    ).toThrow("HTTP or HTTPS");
    expect(() =>
      createConversation("alice", {
        ...source,
        sourceUrl: "data:text/html,hello",
      }),
    ).toThrow("HTTP or HTTPS");
  });
  it("imports explicit Codex JSONL message exports without tool events", () => {
    const entries = [
      { type: "session_meta", payload: { id: "session" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Question" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "exec", arguments: "private" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer" }],
        },
      },
    ];
    const imported = importTranscript(
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
      "json",
    );
    expect(imported.provider).toBe("codex");
    expect(imported.messages).toEqual([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]);
  });
  it("extracts Claude message payloads from inert Next Flight data", () => {
    const payload = {
      name: "Claude source",
      chat_messages: [
        { sender: "human", text: "Question" },
        {
          sender: "assistant",
          content: [{ type: "text", text: "Answer $x$" }],
        },
      ],
    };
    const html = `<script>self.__next_f.push([1,${JSON.stringify("1:" + JSON.stringify(payload) + "\n")}])</script>`;
    expect(parseShareHtml(html, "claude")).toMatchObject({
      provider: "claude",
      title: "Claude source",
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer $x$" },
      ],
    });
  });
  it("preserves unicode, code and math in JSON and Markdown", () => {
    expect(importTranscript(JSON.stringify(source), "json").messages).toEqual(
      source.messages,
    );
    expect(
      importTranscript("# α\n\n$x^2$\n\n```js\nx()\n```", "markdown")
        .messages[0].content,
    ).toContain("$x^2$");
  });
  it("selects the current source branch without importing discarded alternatives", () => {
    const payload = {
      title: "Branches",
      current_node: "chosen",
      mapping: {
        root: {
          parent: null,
          message: {
            author: { role: "user" },
            content: { parts: ["Question"] },
          },
        },
        chosen: {
          parent: "root",
          message: {
            author: { role: "assistant" },
            content: { parts: ["Selected"] },
          },
        },
        discarded: {
          parent: "root",
          message: {
            author: { role: "assistant" },
            content: { parts: ["Discarded"] },
          },
        },
      },
    };
    expect(
      parseShareHtml(
        `<script type="application/json">${JSON.stringify(payload)}</script>`,
        "chatgpt",
      ).messages.map((message) => message.content),
    ).toEqual(["Question", "Selected"]);
  });
  it("decodes reference-table share payloads without executing provider scripts", () => {
    const table = [
      { _1: 2 },
      "messages",
      [3, 8],
      { _4: 5, _6: 7 },
      "role",
      "user",
      "content",
      "Question",
      { _4: 9, _6: 10 },
      "assistant",
      "Answer",
    ];
    const html = `<script>streamController.enqueue(${JSON.stringify(JSON.stringify(table))})</script>`;
    expect(parseShareHtml(html, "chatgpt").messages).toEqual([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]);
  });
  it("rejects challenge pages, invalid JSON, oversized input and private/noncanonical URLs", () => {
    expect(() =>
      parseShareHtml("<html>Please log in</html>", "claude"),
    ).toThrow("exported JSON");
    expect(() => importTranscript("{}", "json")).toThrow("messages array");
    expect(() =>
      importTranscript("x".repeat(4 * 1024 * 1024 + 1), "markdown"),
    ).toThrow("4 MB");
    for (const url of [
      "http://localhost/share/x",
      "https://chatgpt.com.evil.test/share/x",
      "https://claude.ai/share/x",
      "https://user@chatgpt.com/share/00000000-0000-0000-0000-000000000001",
    ])
      expect(() => shareProvider(url)).toThrow();
  });
});
