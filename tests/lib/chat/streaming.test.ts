import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let tmpDir: string;
let releaseProvider: () => void;
let providerCalls: number;
let capturedSystem: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-chat-stream-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  providerCalls = 0;
  capturedSystem = undefined;
  vi.resetModules();
  vi.doMock("@/lib/auth/session", () => ({
    activeProfile: async () => ({ username: "andres" }),
  }));
  vi.doMock("@/lib/agent/registry", () => ({
    hasConfiguredProvider: () => true,
    getProvider: () => ({
      id: "claude-code",
      capabilities: { web: true, vision: true, unboundedContext: true },
      execute: async () => "answer",
      stream: async function* (turn: { system?: string }) {
        providerCalls += 1;
        capturedSystem = turn.system;
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
        yield "answer";
      },
    }),
  }));

  const papers = await import("@/lib/library/papers");
  papers.writeMeta("ml", "paper", {
    title: "Paper",
    authors: [],
    year: null,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: "https://example.test/paper.pdf",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
  });
  const pdf = papers.pdfPath("ml", "paper");
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4");
});

afterEach(async () => {
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/agent/registry");
  vi.unstubAllGlobals();
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("chat response streaming", () => {
  it("sends a keepalive before a slow provider responds without persisting it", async () => {
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "paper", "andres", "Slow chat");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    const response = await route.POST(
      new NextRequest("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "research this" }),
      }),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          chatId: chat.id,
        }),
      },
    );

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("\n");
    expect(first.done).toBe(false);

    releaseProvider();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("answer");
    expect((await reader.read()).done).toBe(true);

    const stored = chats.readChat("ml", "paper", "andres", chat.id);
    expect(stored?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "research this" }),
      expect.objectContaining({ role: "assistant", content: "answer" }),
    ]);
  });

  it("does not recreate a chat deleted while the provider is responding", async () => {
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "paper", "andres", "Slow chat");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    const response = await route.POST(
      new NextRequest("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "research this" }),
      }),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          chatId: chat.id,
        }),
      },
    );

    const reader = response.body!.getReader();
    await reader.read();
    expect(chats.deleteChat("ml", "paper", "andres", chat.id)).toBe(true);
    releaseProvider();
    while (!(await reader.read()).done) {
      // Drain the streamed answer so assistant persistence runs.
    }

    expect(chats.readChat("ml", "paper", "andres", chat.id)).toBeNull();
    expect(chats.listChats("ml", "paper", "andres")).toEqual([]);
  });

  it("verifies and injects an entire GitHub file before saving the turn", async () => {
    const sha = "2a810a6c353215685307da3d4cc6ebd73b1c387b";
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ sha })))
        .mockResolvedValueOnce(
          new Response(
            "def stage_one():\n    pass\n\ndef stage_two():\n    pass\n",
          ),
        ),
    );
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "paper", "andres", "New chat");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    const response = await route.POST(
      new NextRequest("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content:
            "Explain all stages in https://github.com/org/repo/blob/main/train.py",
        }),
      }),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          chatId: chat.id,
        }),
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    releaseProvider();
    while (!(await reader.read()).done) {
      // Drain the answer so persistence completes.
    }

    expect(providerCalls).toBe(1);
    expect(capturedSystem).toContain(
      "Read every provided line from top to bottom",
    );
    expect(capturedSystem).toContain("every stage transition");
    expect(capturedSystem).toContain('"line":1,"text":"def stage_one():"');
    expect(capturedSystem).toContain('"line":5,"text":"    pass"');
    expect(capturedSystem).toContain(
      `https://github.com/org/repo/blob/${sha}/train.py`,
    );
    expect(
      chats.readChat("ml", "paper", "andres", chat.id)?.messages[0]
        .repositorySource,
    ).toEqual({ owner: "org", repo: "repo", sha, path: "train.py" });
  });

  it("rejects failed source verification before persistence or provider work", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 404 })),
    );
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "paper", "andres", "New chat");
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    const response = await route.POST(
      new NextRequest("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Read https://github.com/org/repo/blob/main/train.py",
        }),
      }),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          chatId: chat.id,
        }),
      },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "GitHub repository, revision, or file was not found.",
    });
    expect(providerCalls).toBe(0);
    expect(chats.readChat("ml", "paper", "andres", chat.id)?.messages).toEqual(
      [],
    );
  });

  it("pins follow-up analysis to the previously verified commit", async () => {
    const sha = "2a810a6c353215685307da3d4cc6ebd73b1c387b";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("complete pinned source"));
    vi.stubGlobal("fetch", fetchMock);
    const chats = await import("@/lib/library/chats");
    const chat = chats.createChat("ml", "paper", "andres", "Source chat");
    chats.appendMessage("ml", "paper", "andres", chat.id, {
      role: "user",
      content: "original source request",
      repositorySource: { owner: "org", repo: "repo", sha, path: "train.py" },
      at: "2026-08-13T10:00:00.000Z",
    });
    const route =
      await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
    const response = await route.POST(
      new NextRequest("http://localhost/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Now trace the stage transition." }),
      }),
      {
        params: Promise.resolve({
          topic: "ml",
          slug: "paper",
          chatId: chat.id,
        }),
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    releaseProvider();
    while (!(await reader.read()).done) {
      // Drain the answer.
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.github.com/repos/org/repo/contents/train.py?ref=${sha}`,
    );
    expect(capturedSystem).toContain("complete pinned source");
  });
});
