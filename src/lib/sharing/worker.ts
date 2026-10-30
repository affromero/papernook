import { runTaskLoop } from "thesidedoor-core/runtime/task-loop";
import { z } from "zod";
import { listPapers, companionDir } from "../library/papers";
import { listShares } from "../library/shares";
import { listProfiles } from "../auth/users";
import { readChat } from "../library/chats";
import { dataRoot } from "../data-dir";
import { PapernookIdentityStore } from "../auth/identity-store";
import { withProfileFiles } from "../auth/profile-capability";
import { updateMirror, connectionExchange } from "./gateway";
import { readVersionedPdfFile } from "../library/pdf/file";
import { base64Schema, idSchema, revisionSchema, SharingError } from "./schema";
import { packageConversation } from "./bundle";
import {
  publicationIds,
  readConnection,
  withConnection,
  forgetPublication,
  withCollaboration,
  setConnectionSyncStatus,
} from "./storage";
import { synchronizeOwnerThreads, publicationRevision } from "./threads";

const changesSchema = z
  .object({
    etag: revisionSchema,
    threads: z
      .array(
        z
          .object({ id: idSchema, actorId: idSchema, revision: revisionSchema })
          .strict(),
      )
      .max(100),
  })
  .strict();
const pdfSchema = z
  .object({ etag: revisionSchema, pdf: base64Schema })
  .strict();

interface Worker {
  controller: AbortController;
  completion: Promise<void>;
  directory: string;
}
const runtime = globalThis as typeof globalThis & {
  papernookSharingWorker?: Worker;
};

export async function syncConnectedPaper(
  topic: string,
  slug: string,
): Promise<void> {
  const binding = readConnection(topic, slug);
  if (!binding) return;
  const capability = {
    username: binding.username,
    generation: binding.generation,
  };
  await withConnection(topic, slug, capability, async (connection) => {
    try {
      const changes = changesSchema.parse(
        await connectionExchange(topic, slug, capability, connection, {
          action: "changes",
        }),
      );
      const local = await readVersionedPdfFile(topic, slug);
      if (
        !local ||
        (local.etag !== connection.mirrorEtag && local.etag !== changes.etag)
      )
        throw new SharingError(
          "The local PDF changed outside collaboration. Preserve that copy before reconnecting.",
          409,
        );
      if (local.etag !== changes.etag) {
        const pdf = pdfSchema.parse(
          await connectionExchange(topic, slug, capability, connection, {
            action: "pdf",
          }),
        );
        await updateMirror(
          topic,
          slug,
          connection,
          Buffer.from(pdf.pdf, "base64"),
          pdf.etag,
          capability,
        );
      }
      const identity = new PapernookIdentityStore(dataRoot());
      for (const id of publicationIds(topic, slug)) {
        const packaged = withProfileFiles(identity, capability, () => {
          const chat = readChat(topic, slug, capability.username, id);
          return chat
            ? packageConversation(chat, companionDir(topic, slug))
            : null;
        });
        if (!packaged) {
          await connectionExchange(topic, slug, capability, connection, {
            action: "unpublish",
            id,
          });
          withProfileFiles(identity, capability, () =>
            forgetPublication(topic, slug, id),
          );
          continue;
        }
        const current = changes.threads.find(
          (thread) =>
            thread.actorId === connection.participantId && thread.id === id,
        );
        if (
          current?.revision ===
          publicationRevision(packaged, connection.participantId)
        )
          continue;
        await connectionExchange(topic, slug, capability, connection, {
          action: "publish",
          ...packaged,
          expected: current?.revision ?? null,
        });
      }
      setConnectionSyncStatus(topic, slug, capability, connection, null);
    } catch (error) {
      setConnectionSyncStatus(
        topic,
        slug,
        capability,
        connection,
        "A published conversation or PDF could not sync. Check access, local PDF changes, and sharing limits.",
      );
      throw error;
    }
  });
}

export function startSharingWorker(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const existing = runtime.papernookSharingWorker;
  if (existing) {
    if (existing.directory !== dataRoot())
      throw new Error("Sharing worker is running for another data directory.");
    return;
  }
  const controller = new AbortController();
  const worker: Worker = {
    controller,
    completion: Promise.resolve(),
    directory: dataRoot(),
  };
  runtime.papernookSharingWorker = worker;
  worker.completion = runTaskLoop({
    intervalMs: 30_000,
    signal: controller.signal,
    task: async (signal) => {
      const profiles = listProfiles();
      for (const paper of listPapers()) {
        if (signal.aborted) break;
        if (!paper.topic) continue;
        if (!readConnection(paper.topic, paper.slug)) {
          for (const profile of profiles)
            for (const share of listShares(
              paper.topic,
              paper.slug,
              profile.username,
            ).filter(
              (entry) => entry.mode === "collaborate" && !entry.revoked,
            )) {
              if (signal.aborted) break;
              try {
                await withCollaboration(share, async () =>
                  synchronizeOwnerThreads(share),
                );
              } catch {
                console.error(
                  "papernook sharing: an owner publication could not sync; open its collaboration panel for details",
                );
              }
            }
          continue;
        }
        try {
          await syncConnectedPaper(paper.topic, paper.slug);
        } catch {
          console.error(
            "papernook sharing: a connected paper could not sync; open its collaboration panel for details",
          );
        }
      }
    },
    onError: () => {
      console.error("papernook sharing: storage unavailable; retry scheduled");
    },
  }).catch(() =>
    console.error("papernook sharing: worker stopped unexpectedly"),
  );
}
