import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/conversations/[id]/previews/[message]/route";
import {
  createConversation,
  lockConversation,
} from "@/lib/conversations/store";
import { conversationDirectory } from "@/lib/conversations/assets";
import { previewHash } from "@/lib/conversations/previews/source";
import { readPreview } from "@/lib/conversations/previews/cache";
import {
  createTestProfile,
  testSession,
  revokeTestProfile,
} from "../helpers/access";
import { pngFixture } from "../helpers/png";

const session = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (session.token ? { value: session.token } : undefined),
  }),
}));
let directory: string;
const source = "graph TD; A-->B";
const image = `data:image/png;base64,${pngFixture().toString("base64")}`;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "preview-api-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Alice");
  session.token = await testSession("alice");
});
afterEach(() => {
  session.token = "";
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
const conversation = () =>
  createConversation("alice", {
    title: "Saved diagram",
    topic: "Science",
    tags: [],
    provider: "chatgpt",
    messages: [
      { role: "assistant", content: `\`\`\`mermaid\n${source}\n\`\`\`` },
    ],
  });
const context = (id: string) => ({
  params: Promise.resolve({ id, message: "0" }),
});
const request = (
  value: unknown = {
    hash: previewHash("mermaid", source),
    kind: "mermaid",
    image,
  },
  headers: Record<string, string> = {},
) =>
  new Request("http://papernook.test/api/v1/conversations/id/previews/0", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(value),
  });

it("saves only a current source image for the signed-in profile and rejects changed or malformed captures", async () => {
  const saved = conversation();
  const ctx = context(saved.id);
  expect((await POST(request(), ctx)).status).toBe(201);
  expect(
    readPreview(conversationDirectory("alice", saved.id), "mermaid", source),
  ).toEqual(pngFixture());
  expect(
    (
      await POST(
        request({
          hash: previewHash("mermaid", "old source"),
          kind: "mermaid",
          image,
        }),
        ctx,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await POST(
        request({
          hash: previewHash("mermaid", source),
          kind: "mermaid",
          image: "data:image/png;base64,eA==",
        }),
        ctx,
      )
    ).status,
  ).toBe(422);
  expect(
    (await POST(request({}, { "Sec-Fetch-Site": "cross-site" }), ctx)).status,
  ).toBe(403);
  expect(
    (await POST(request({ image: "x".repeat(3 * 1024 * 1024 + 1) }), ctx))
      .status,
  ).toBe(413);
  const release = lockConversation("alice", saved.id);
  try {
    expect((await POST(request(), ctx)).status).toBe(422);
  } finally {
    release();
  }
  await createTestProfile("Bob");
  session.token = await testSession("bob");
  expect((await POST(request(), ctx)).status).toBe(404);
  session.token = "";
  expect((await POST(request(), ctx)).status).toBe(401);
});

it("rejects an in-flight capture after its profile is erased and recreated", async () => {
  const saved = conversation();
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      send = controller;
    },
  });
  const incoming = request();
  Object.defineProperty(incoming, "body", {
    get() {
      requested();
      return body;
    },
  });
  const response = POST(incoming, context(saved.id));
  await started;
  await (
    await revokeTestProfile("alice")
  )();
  await createTestProfile("Alice");
  send.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        hash: previewHash("mermaid", source),
        kind: "mermaid",
        image,
      }),
    ),
  );
  send.close();
  expect((await response).status).toBe(401);
  expect(
    fs.existsSync(
      path.join(
        directory,
        "users",
        "alice",
        "conversations",
        saved.id,
        "previews",
      ),
    ),
  ).toBe(false);
});
