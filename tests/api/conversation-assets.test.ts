import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestProfile, testSession } from "../helpers/access";
import {
  createConversation,
  refreshConversationContent,
} from "@/lib/conversations/store";
import { conversationDirectory, assetPath } from "@/lib/conversations/assets";
import { GET } from "@/app/api/v1/conversations/[id]/assets/[message]/[index]/route";
import { importTranscript } from "@/lib/conversations/import";

const session = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (session.token ? { value: session.token } : undefined),
  }),
}));
const data =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i0AAAAASUVORK5CYII=";
let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-assets-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Alice");
  await createTestProfile("Bob");
  session.token = await testSession("alice");
});
afterEach(() => {
  session.token = "";
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
function source(asset = { kind: "image" as const, name: "Diagram", data }) {
  return createConversation("alice", {
    title: "Rich source",
    topic: "Research",
    tags: [],
    provider: "chatgpt",
    messages: [
      { role: "assistant", content: "![Diagram](#asset-0)", assets: [asset] },
    ],
  });
}
async function get(id: string, message = "0", index = "0") {
  return GET(
    new Request(
      `http://localhost/api/v1/conversations/${id}/assets/${message}/${index}`,
    ),
    { params: Promise.resolve({ id, message, index }) },
  );
}

it("serves and saves imported image bytes privately for the owning profile", async () => {
  const record = source();
  const response = await get(record.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toContain("private");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(
    Buffer.from(data.split(",")[1], "base64"),
  );
  expect(
    fs.existsSync(
      assetPath(
        conversationDirectory("alice", record.id),
        0,
        0,
        record.messages[0].assets![0],
      ),
    ),
  ).toBe(true);
  session.token = await testSession("bob");
  expect((await get(record.id)).status).toBe(404);
  session.token = "";
  expect((await get(record.id)).status).toBe(401);
});
it.each([
  { type: "output_image", b64_json: data.split(",")[1] },
  {
    type: "image_generation_call",
    result: data.split(",")[1],
    output_format: "png",
  },
])(
  "serves generated base64 images from $type without requiring a declared MIME",
  async (block) => {
    const imported = importTranscript(
      JSON.stringify({ messages: [{ role: "assistant", content: [block] }] }),
      "json",
    );
    const record = createConversation("alice", imported);
    const response = await get(record.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(data.split(",")[1], "base64"),
    );
  },
);

it("rejects invalid image data and traversal without creating a cached asset", async () => {
  const record = source({
    kind: "image",
    name: "Invalid",
    data: "data:image/png;base64,aW52YWxpZA==",
  });
  expect((await get(record.id)).status).toBe(422);
  expect(
    fs.existsSync(
      assetPath(
        conversationDirectory("alice", record.id),
        0,
        0,
        record.messages[0].assets![0],
      ),
    ),
  ).toBe(false);
  expect((await get(record.id, "../private")).status).toBe(400);
});
it("refreshing asset metadata cannot serve cached bytes from a previous attachment at the same position", async () => {
  const record = source();
  expect((await get(record.id)).status).toBe(200);
  const replacement = fs.readFileSync("public/logo.png");
  refreshConversationContent("alice", record.id, {
    ...record,
    messages: [
      {
        ...record.messages[0],
        assets: [
          {
            kind: "image",
            name: "Replacement",
            data: `data:image/png;base64,${replacement.toString("base64")}`,
          },
        ],
      },
    ],
  });
  const response = await get(record.id);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(replacement);
});

it("reports unavailable provider assets and blocks private network URLs", async () => {
  const record = createConversation("alice", {
    title: "Missing assets",
    topic: "Research",
    tags: [],
    provider: "transcript",
    messages: [
      {
        role: "user",
        content: "Attachments",
        assets: [
          { kind: "image", name: "Unavailable" },
          {
            kind: "image",
            name: "Private URL",
            url: "http://127.0.0.1/secret",
          },
        ],
      },
    ],
  });
  const missing = await get(record.id);
  expect(missing.status).toBe(422);
  expect((await missing.json()).error).toContain("did not expose");
  expect((await get(record.id, "0", "1")).status).toBe(422);
});
