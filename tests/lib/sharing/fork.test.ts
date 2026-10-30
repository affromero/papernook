import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixture, post } from "./fixture";
import { createTestProfile, testProfileCapability } from "../../helpers/access";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-fork-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("imports an independent annotated copy with only selected conversation snapshots", async () => {
  const f = await fixture("fork");
  const chats = await import("@/lib/library/chats");
  const bundle = await import("@/lib/sharing/bundle");
  const header = chats.createChat(
    "nlp",
    "attention",
    "ana",
    "Selected explanation",
  );
  chats.appendMessage("nlp", "attention", "ana", header.id, {
    role: "user",
    content: "Public initial question",
    at: new Date().toISOString(),
  });
  const privateChat = chats.createChat(
    "nlp",
    "attention",
    "ana",
    "Private secrets",
  );
  chats.appendMessage("nlp", "attention", "ana", privateChat.id, {
    role: "user",
    content: "NEVER_EXPORT_THIS",
    at: new Date().toISOString(),
  });
  const share = f.shares.createShare(
    "nlp",
    "attention",
    f.capability,
    [header.id],
    "fork",
  );
  chats.appendMessage("nlp", "attention", "ana", header.id, {
    role: "user",
    content: "LATER_PRIVATE_TURN",
    at: new Date().toISOString(),
  });
  const snapshot = await bundle.exportBundle(share);
  const serialized = JSON.stringify(snapshot);
  expect(serialized).toContain("Public initial question");
  for (const secret of [
    "NEVER_EXPORT_THIS",
    "LATER_PRIVATE_TURN",
    "SECRET_SOURCE",
    "captureToken",
    "ownerGeneration",
    f.token,
  ])
    expect(serialized).not.toContain(secret);
  await createTestProfile("Bea");
  const copy = await bundle.importBundle(
    snapshot,
    "shared",
    testProfileCapability("bea"),
  );
  expect(copy.slug).not.toBe("attention");
  expect(copy.meta.addedBy).toBe("bea");
  expect(copy.meta.source).toBeUndefined();
  expect(fs.readFileSync(copy.pdfPath)).toEqual(fs.readFileSync(f.pdf));
  const copiedChats = chats.listChats("shared", copy.slug, "bea");
  expect(copiedChats).toHaveLength(1);
  expect(
    chats.readChat("shared", copy.slug, "bea", copiedChats[0].id)?.messages[0]
      .content,
  ).toBe("Public initial question");
  expect(fs.existsSync(path.join(copy.companionDir, "collaboration"))).toBe(
    false,
  );
  expect(fs.existsSync(path.join(copy.companionDir, "shares"))).toBe(false);
  fs.writeFileSync(copy.pdfPath, "an independent local edit");
  expect(fs.readFileSync(f.pdf).toString("latin1")).toContain("%PDF-");
  f.shares.deleteShare("nlp", "attention", share.id, "ana");
  expect(fs.readFileSync(copy.pdfPath, "utf8")).toBe(
    "an independent local edit",
  );
});

it("excludes arbitrary companion files and unreferenced attachments", async () => {
  const f = await fixture("fork");
  const folder = f.papers.companionDir("nlp", "attention");
  fs.mkdirSync(path.join(folder, "crops"), { recursive: true });
  fs.writeFileSync(path.join(folder, "crops", "private.png"), "PRIVATE_CROP");
  fs.writeFileSync(path.join(folder, "canvas.json"), "PRIVATE_CANVAS");
  const response = await post(f.share.id, null, "bundle");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("PRIVATE_CROP");
  expect(text).not.toContain("PRIVATE_CANVAS");
});

it("keeps later owner publications and later turns out of the public preview", async () => {
  const f = await fixture();
  const chats = await import("@/lib/library/chats");
  const thread = chats.createChat(
    "nlp",
    "attention",
    "ana",
    "Approved readers only",
  );
  chats.appendMessage("nlp", "attention", "ana", thread.id, {
    role: "user",
    content: "COLLABORATION_ONLY",
    at: new Date().toISOString(),
  });
  await f.storage.withCollaboration(f.share, async () =>
    f.shares.publishOwnerChat(f.share, f.capability, thread.id),
  );
  const publicBundle = await post(f.share.id, null, "bundle");
  expect(await publicBundle.text()).not.toContain("COLLABORATION_ONLY");
  const approvedBundle = await post(f.share.id, f.token, "read");
  expect(await approvedBundle.text()).toContain("COLLABORATION_ONLY");
  expect(
    f.shares.getShare("nlp", "attention", f.share.id)?.conversations,
  ).toHaveLength(0);
});

it("binds shared conversation writes to the approved actor and checks revisions", async () => {
  const f = await fixture();
  const chat = {
    header: {
      id: "1".repeat(16),
      title: "Shared explanation",
      username: "ana",
      titleSource: "manual",
      createdAt: new Date().toISOString(),
    },
    messages: [
      {
        role: "user",
        content: "A published question",
        at: new Date().toISOString(),
      },
    ],
  };
  const first = await post(f.share.id, f.token, "publish", {
    chat,
    assets: {},
    expected: null,
  });
  expect(first.status).toBe(200);
  const published = await first.json();
  expect(published.author).toBe("Maya Approved");
  expect(published.chat.header.username).toBe(f.participant.id);
  expect(
    (
      await post(f.share.id, f.token, "publish", {
        chat,
        assets: {},
        expected: null,
      })
    ).status,
  ).toBe(200);
  const changed = {
    ...chat,
    messages: [
      ...chat.messages,
      { role: "user", content: "New turn", at: new Date().toISOString() },
    ],
  };
  expect(
    (
      await post(f.share.id, f.token, "publish", {
        chat: changed,
        assets: {},
        expected: null,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(f.share.id, f.token, "publish", {
        chat: changed,
        assets: {},
        expected: published.revision,
      })
    ).status,
  ).toBe(200);
  expect(await (await post(f.share.id, null, "bundle")).text()).not.toContain(
    "A published question",
  );
  const forged = await post(f.share.id, f.token, "publish", {
    chat,
    assets: {},
    expected: published.revision,
    actorId: "ana",
    author: "Ana",
  });
  expect(forged.status).toBe(400);
});

it("rejects attachment traversal, unreferenced data, and forged image payloads", async () => {
  const f = await fixture();
  const header = {
    id: "1".repeat(16),
    title: "Attachments",
    username: "ana",
    titleSource: "manual",
    createdAt: new Date().toISOString(),
  };
  const message = {
    role: "user",
    content: "image",
    at: new Date().toISOString(),
  };
  const traversal = {
    header,
    messages: [{ ...message, images: ["crops/../../identity.json"] }],
  };
  expect(
    (
      await post(f.share.id, f.token, "publish", {
        chat: traversal,
        assets: {},
        expected: null,
      })
    ).status,
  ).toBe(400);
  const image = Buffer.from("<svg onload='alert(1)' />");
  const name = f.storage.digest(image) + ".png";
  const assets = { [name]: image.toString("base64") };
  expect(
    (
      await post(f.share.id, f.token, "publish", {
        chat: { header, messages: [message] },
        assets,
        expected: null,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post(f.share.id, f.token, "publish", {
        chat: { header, messages: [{ ...message, images: [`crops/${name}`] }] },
        assets,
        expected: null,
      })
    ).status,
  ).toBe(400);
});

it("withdraws only the caller's shared conversation without deleting private history", async () => {
  const f = await fixture();
  const chat = {
    header: {
      id: "1".repeat(16),
      title: "Withdraw me",
      username: "ana",
      createdAt: new Date().toISOString(),
    },
    messages: [
      {
        role: "user",
        content: "Shared until withdrawn",
        at: new Date().toISOString(),
      },
    ],
  };
  expect(
    (
      await post(f.share.id, f.token, "publish", {
        chat,
        assets: {},
        expected: null,
      })
    ).status,
  ).toBe(200);
  const token = f.storage.newSecret();
  const other = f.storage.requestParticipant(f.share, token, "Other reader");
  f.storage.setParticipant(f.share, other.id, "approved");
  expect(
    (await post(f.share.id, token, "unpublish", { id: chat.header.id })).status,
  ).toBe(200);
  expect(await (await post(f.share.id, f.token, "read")).text()).toContain(
    "Shared until withdrawn",
  );
  expect(
    (await post(f.share.id, f.token, "unpublish", { id: chat.header.id }))
      .status,
  ).toBe(200);
  expect(await (await post(f.share.id, f.token, "read")).text()).not.toContain(
    "Shared until withdrawn",
  );
});
