import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProfile } from "@/lib/auth/users";
import { createSessionToken } from "@/lib/auth/session";
import { setAgentModel } from "@/lib/agent/config";
import {
  createConversation,
  listConversationChats,
} from "@/lib/conversations/store";
import { POST } from "@/app/api/v1/conversations/[id]/chats/route";
const session = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (session.token ? { value: session.token } : undefined),
  }),
}));
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-api-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.stubEnv("AI_PROVIDER", "ollama");
  vi.stubEnv("OLLAMA_HOST", "http://localhost:11434");
  vi.stubEnv("PAPERNOOK_PASSWORD", "test-password");
  createProfile("Alice");
  setAgentModel("test-model");
  session.token = createSessionToken("alice");
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
function request() {
  return new Request("http://papernook.test/api/v1/conversations/id/chats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Explain the saved answer" }),
  });
}
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
        'data: {"choices":[{"delta":{"content":"Grounded answer"}}]}\n\ndata: [DONE]\n\n',
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
it("rejects signed-out requests and another profile's conversation", async () => {
  const record = source();
  session.token = "";
  expect(
    (await POST(request(), { params: Promise.resolve({ id: record.id }) }))
      .status,
  ).toBe(401);
  createProfile("Bob");
  session.token = createSessionToken("bob");
  expect(
    (await POST(request(), { params: Promise.resolve({ id: record.id }) }))
      .status,
  ).toBe(404);
});
