import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTestProfile,
  testSession,
  revokeTestProfile,
} from "../helpers/access";
import { configureTestAgent } from "../helpers/agent";
import {
  createConversation,
  listConversationChats,
  listConversations,
} from "@/lib/conversations/store";
import { POST } from "@/app/api/v1/conversations/[id]/chats/route";
import {
  acquireFileLockSync,
  FileLockBusyError,
} from "thesidedoor-core/storage";
import { PapernookIdentityStore } from "@/lib/auth/identity-store";
const session = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (session.token ? { value: session.token } : undefined),
  }),
}));
let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-api-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Alice");
  await configureTestAgent(
    {
      provider: "ollama",
      model: "test-model",
      baseUrl: "http://localhost:11434/v1",
    },
    { baseUrl: "http://localhost:11434/v1", allowAnonymous: true },
  );
  session.token = await testSession("alice");
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  session.token = "";
});
function source() {
  return createConversation("alice", {
    title: "Private source",
    topic: "Science",
    tags: [],
    provider: "chatgpt",
    sourceUrl: "https://chatgpt.com/share/revoked",
    messages: [
      { role: "user", content: "Original question α" },
      { role: "assistant", content: "Original answer β" },
    ],
  });
}
function request(images?: string[]) {
  return new Request("http://papernook.test/api/v1/conversations/id/chats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Explain the saved answer", images }),
  });
}
it("does not import a late request into a recreated profile", async () => {
  const route = await import("@/app/api/v1/conversations/route");
  let bodyRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    bodyRequested = resolve;
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const incoming = new Request("http://localhost/api/v1/conversations", {
    method: "POST",
    body: "",
  });
  Object.defineProperty(incoming, "body", {
    get() {
      bodyRequested();
      return body;
    },
  });
  const response = route.POST(incoming);
  await requested;
  await (
    await revokeTestProfile("alice")
  )();
  await createTestProfile("Alice");
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        content: "# User\nPrivate late message",
        format: "markdown",
      }),
    ),
  );
  controller.close();
  expect((await response).status).toBe(401);
  expect(listConversations("alice")).toEqual([]);
});

it("grounds replies in the stored transcript after the original share is revoked", async () => {
  const record = source();
  let received = "";
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("http://localhost:11434/"))
        throw new Error("Original share revoked");
      received =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.text()
            : "";
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"Grounded answer"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  const response = await POST(request(), {
    params: Promise.resolve({ id: record.id }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('"type":"done"');
  expect(received).toContain("Original question α");
  expect(received).toContain("Original answer β");
  expect(received).toContain("Explain the saved answer");
  expect(received).toContain("threejs");
  expect(received).toContain("OrbitControls");
  expect(received).toContain("KaTeX");
  expect(
    listConversationChats("alice", record.id)[0].messages.map(
      (message) => message.content,
    ),
  ).toEqual(["Explain the saved answer", "Grounded answer"]);
});
it("surfaces streamed provider failures and preserves the existing chat history", async () => {
  const record = source();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        'data: {"error":{"message":"Provider rejected the request","type":"invalid_request_error"}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const response = await POST(request(), {
    params: Promise.resolve({ id: record.id }),
  });
  expect(await response.text()).toContain('"type":"error"');
  expect(listConversationChats("alice", record.id)).toEqual([]);
});
it("revokes an in-flight reply before saving and releases its profile lease for erasure", async () => {
  const record = source();
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
  const response = await POST(request(), {
    params: Promise.resolve({ id: record.id }),
  });
  await started;
  const finishErasure = await revokeTestProfile("alice");
  const anchor = new PapernookIdentityStore(directory).profileLockPath("alice");
  expect(() => acquireFileLockSync(anchor)).toThrow(FileLockBusyError);
  send.enqueue(
    new TextEncoder().encode(
      'data: {"choices":[{"index":0,"delta":{"content":"Late private reply"}}]}\n\ndata: [DONE]\n\n',
    ),
  );
  send.close();
  const body = await response.text();
  expect(body).toContain('"type":"error"');
  expect(body).not.toContain("Late private reply");
  expect(listConversationChats("alice", record.id)).toEqual([]);
  await finishErasure();
  expect(fs.existsSync(path.join(directory, "users", "alice"))).toBe(false);
});

it("releases conversation and profile locks when the response is cancelled", async () => {
  const record = source();
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
  const response = await POST(
    request([
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    ]),
    {
      params: Promise.resolve({ id: record.id }),
    },
  );
  await started;
  const attachments = path.join(
    directory,
    "users",
    "alice",
    "conversations",
    record.id,
    "attachments",
  );
  expect(fs.readdirSync(attachments)).toHaveLength(1);
  const cancelled = response.body!.cancel();
  send.close();
  await cancelled;
  const anchor = new PapernookIdentityStore(directory).profileLockPath("alice");
  await vi.waitFor(() => {
    const release = acquireFileLockSync(anchor);
    release();
  });
  expect(listConversationChats("alice", record.id)).toEqual([]);
  expect(fs.readdirSync(attachments)).toEqual([]);
  const { deleteConversation } = await import("@/lib/conversations/store");
  expect(() => deleteConversation("alice", record.id)).not.toThrow();
});

it("rejects signed-out requests and another profile's conversation", async () => {
  const record = source();
  session.token = "";
  expect(
    (await POST(request(), { params: Promise.resolve({ id: record.id }) }))
      .status,
  ).toBe(401);
  await createTestProfile("Bob");
  session.token = await testSession("bob");
  expect(
    (await POST(request(), { params: Promise.resolve({ id: record.id }) }))
      .status,
  ).toBe(404);
});
