import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/library/chats";
import { deleteTestProfile } from "../../helpers/access";
import { fixture } from "./fixture";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-sharing-budget-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function participantChat(id: string, chunks: string[] = []): Chat {
  return {
    header: {
      id,
      title: "Shared conversation",
      titleSource: "manual",
      username: "maya",
      createdAt: new Date().toISOString(),
    },
    messages: chunks.map((content) => ({
      role: "user",
      content,
      at: new Date().toISOString(),
    })),
  };
}

it.each(["owner first", "participant first"])(
  "enforces one 100-thread budget when publishing %s",
  async (order) => {
    const f = await fixture();
    const chats = await import("@/lib/library/chats");
    const threads = await import("@/lib/sharing/threads");
    const own = chats.createChat(
      "nlp",
      "attention",
      "ana",
      "An owner publication",
    );
    await f.storage.withCollaboration(f.share, async () => {
      if (order === "owner first")
        f.shares.publishOwnerChat(f.share, f.capability, own.id);
      for (let index = 0; index < 99; index++)
        threads.publishThread(
          f.share,
          f.storage.authenticateParticipant(f.share, f.token),
          {
            chat: participantChat(index.toString(16).padStart(16, "0")),
            assets: {},
          },
          null,
        );
      if (order === "participant first")
        f.shares.publishOwnerChat(f.share, f.capability, own.id);
      expect(threads.collaborationThreads(f.share)).toHaveLength(100);
      expect(() =>
        threads.publishThread(
          f.share,
          f.storage.authenticateParticipant(f.share, f.token),
          { chat: participantChat("f".repeat(16)), assets: {} },
          null,
        ),
      ).toThrow();
      const another = chats.createChat(
        "nlp",
        "attention",
        "ana",
        "A private conversation",
      );
      expect(() =>
        f.shares.publishOwnerChat(f.share, f.capability, another.id),
      ).toThrow();
      expect(threads.collaborationThreads(f.share)).toHaveLength(100);
      expect(
        chats.readChat("nlp", "attention", "ana", another.id)?.header.title,
      ).toBe("A private conversation");
    });
  },
);

it("keeps shared state readable and reports failed refreshes without restricting private chats", async () => {
  const f = await fixture();
  const chats = await import("@/lib/library/chats");
  const threads = await import("@/lib/sharing/threads");
  const own = chats.createChat(
    "nlp",
    "attention",
    "ana",
    "A growing discussion",
  );
  chats.appendMessage("nlp", "attention", "ana", own.id, {
    role: "user",
    content: "a".repeat(1024 * 1024),
    at: new Date().toISOString(),
  });
  await f.storage.withCollaboration(f.share, async () => {
    f.shares.publishOwnerChat(f.share, f.capability, own.id);
    const chunks = Array.from({ length: 4 }, () => "b".repeat(1792 * 1024));
    for (let index = 0; index < 4; index++)
      threads.publishThread(
        f.share,
        f.storage.authenticateParticipant(f.share, f.token),
        {
          chat: participantChat(index.toString(16).padStart(16, "0"), chunks),
          assets: {},
        },
        null,
      );
    for (let index = 0; index < 2; index++)
      chats.appendMessage("nlp", "attention", "ana", own.id, {
        role: "user",
        content: "FUTURE_PRIVATE_TURN" + "c".repeat(2 * 1024 * 1024 - 32),
        at: new Date().toISOString(),
      });
    expect(
      chats.readChat("nlp", "attention", "ana", own.id)?.messages,
    ).toHaveLength(3);
    expect(() => threads.synchronizeOwnerThreads(f.share)).toThrow();
    const shared = threads.collaborationThreads(f.share);
    expect(
      shared.find((thread) => thread.id === own.id)?.chat.messages,
    ).toHaveLength(1);
    expect(threads.sharingSyncStatus(f.share)?.error).toContain(
      "could not sync",
    );
    f.shares.unpublishOwnerChat(f.share, f.capability, own.id);
    threads.synchronizeOwnerThreads(
      f.shares.getShare("nlp", "attention", f.share.id)!,
    );
    expect(threads.sharingSyncStatus(f.share)?.error).toBeNull();
    expect(
      chats.readChat("nlp", "attention", "ana", own.id)?.messages,
    ).toHaveLength(3);
  });
}, 15_000);

it("erases copied owner conversations and temporary files even after a share record was lost", async () => {
  const f = await fixture();
  const chats = await import("@/lib/library/chats");
  const chat = chats.createChat(
    "nlp",
    "attention",
    "ana",
    "Published before erasure",
  );
  chats.appendMessage("nlp", "attention", "ana", chat.id, {
    role: "user",
    content: "PRIVATE_PUBLISHED_COPY",
    at: new Date().toISOString(),
  });
  await f.storage.withCollaboration(f.share, async () =>
    f.shares.publishOwnerChat(f.share, f.capability, chat.id),
  );
  const folder = f.storage.collaborationDir(f.share);
  fs.writeFileSync(
    path.join(folder, "threads", "interrupted.tmp"),
    "PRIVATE_PUBLISHED_COPY",
  );
  fs.unlinkSync(
    path.join(
      f.papers.companionDir("nlp", "attention"),
      "shares",
      `${f.share.id}.json`,
    ),
  );
  await deleteTestProfile("ana");
  expect(fs.existsSync(folder)).toBe(false);
  expect(fs.existsSync(f.pdf)).toBe(true);
});

it("rolls back a collaboration when its selected image snapshots exceed the aggregate budget", async () => {
  const f = await fixture();
  const chats = await import("@/lib/library/chats");
  const folder = f.papers.companionDir("nlp", "attention");
  fs.mkdirSync(path.join(folder, "crops"));
  const image = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=",
    "base64",
  ).copy(image);
  fs.writeFileSync(path.join(folder, "crops", "large.png"), image);
  const ids: string[] = [];
  for (let index = 0; index < 6; index++) {
    const chat = chats.createChat(
      "nlp",
      "attention",
      "ana",
      `Explanation ${index}`,
    );
    chats.appendMessage("nlp", "attention", "ana", chat.id, {
      role: "user",
      content: "a".repeat(1024 * 1024),
      images: ["crops/large.png"],
      at: new Date().toISOString(),
    });
    ids.push(chat.id);
  }
  expect(() =>
    f.shares.createShare("nlp", "attention", f.capability, ids, "collaborate"),
  ).toThrow();
  expect(
    f.shares.listShares("nlp", "attention", "ana").map((share) => share.id),
  ).toEqual([f.share.id]);
  expect(fs.readdirSync(path.join(folder, "collaboration"))).toEqual([
    f.share.id,
  ]);
  expect(chats.listChats("nlp", "attention", "ana")).toHaveLength(6);
}, 15_000);

it("does not let a queued owner refresh revive a withdrawn initial selection", async () => {
  const f = await fixture();
  const chats = await import("@/lib/library/chats");
  const threads = await import("@/lib/sharing/threads");
  const chat = chats.createChat(
    "nlp",
    "attention",
    "ana",
    "Withdraw this selection",
  );
  const stale = f.shares.createShare(
    "nlp",
    "attention",
    f.capability,
    [chat.id],
    "collaborate",
  );
  await f.storage.withCollaboration(stale, async () =>
    f.shares.unpublishOwnerChat(stale, f.capability, chat.id),
  );
  await f.storage.withCollaboration(stale, async () =>
    threads.synchronizeOwnerThreads(stale),
  );
  expect(threads.collaborationThreads(stale)).toEqual([]);
});
