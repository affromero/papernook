import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  createTestProfile,
  mockTestSession,
  revokeTestProfile,
} from "../helpers/access";
import {
  acquireFileLockSync,
  FileLockBusyError,
} from "thesidedoor-core/storage";
import { PapernookIdentityStore } from "@/lib/auth/identity-store";

let directory: string;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-paper-stream-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Reader");
  await mockTestSession("reader");
  const { configureTestAgent } = await import("../helpers/agent");
  await configureTestAgent(
    {
      provider: "ollama",
      model: "test-model",
      baseUrl: "http://localhost:11434/v1",
    },
    { baseUrl: "http://localhost:11434/v1", allowAnonymous: true },
  );
  const papers = await import("@/lib/library/papers");
  papers.writeMeta("science", "source", {
    title: "Shared paper",
    authors: [],
    year: null,
    venue: null,
    arxivId: null,
    bibtex: null,
    tags: [],
    related: [],
    sourceUrl: "https://example.test/paper.pdf",
    addedAt: new Date().toISOString(),
    addedBy: "reader",
  });
  const pdf = papers.pdfPath("science", "source");
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4");
});
afterEach(async () => {
  vi.doUnmock("next/headers");
  vi.unstubAllGlobals();
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("keeps erasure behind an active reply and rejects its late private output", async () => {
  const chats = await import("@/lib/library/chats");
  const chat = chats.createChat(
    "science",
    "source",
    "reader",
    "Existing discussion",
  );
  let send!: ReadableStreamDefaultController<Uint8Array>;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            send = controller;
            began();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const route =
    await import("@/app/api/v1/papers/[topic]/[slug]/chats/[chatId]/route");
  const response = await route.POST(
    new NextRequest("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Explain the method" }),
    }),
    {
      params: Promise.resolve({
        topic: "science",
        slug: "source",
        chatId: chat.id,
      }),
    },
  );
  expect(response.status).toBe(200);
  await started;
  const erase = await revokeTestProfile("reader");
  const identity = new PapernookIdentityStore(directory);
  expect(() => acquireFileLockSync(identity.profileLockPath("reader"))).toThrow(
    FileLockBusyError,
  );
  send.enqueue(
    new TextEncoder().encode(
      'data: {"choices":[{"index":0,"delta":{"content":"Late private answer"}}]}\n\ndata: [DONE]\n\n',
    ),
  );
  send.close();
  const text = await response.text();
  expect(text).toContain("[error:");
  expect(text).not.toContain("Late private answer");
  expect(
    chats
      .readChat("science", "source", "reader", chat.id)
      ?.messages.map((message) => message.role),
  ).toEqual(["user"]);
  await erase();
  expect(chats.readChat("science", "source", "reader", chat.id)).toBeNull();
});
