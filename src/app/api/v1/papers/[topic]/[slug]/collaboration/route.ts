import { z } from "zod";
import { requestIdentity, sharedAccess } from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { readChat } from "@/lib/library/chats";
import { companionDir } from "@/lib/library/papers";
import {
  listShares,
  publishOwnerChat,
  unpublishOwnerChat,
} from "@/lib/library/shares";
import {
  collaborationThreads,
  sharingSyncStatus,
  synchronizeOwnerThreads,
} from "@/lib/sharing/threads";
import { syncConnectedPaper } from "@/lib/sharing/worker";
import { packageConversation } from "@/lib/sharing/bundle";
import {
  connectedState,
  localMirrorChanged,
  connectionExchange,
} from "@/lib/sharing/gateway";
import {
  readConnection,
  withConnection,
  withCollaboration,
  rememberPublication,
  forgetPublication,
  disconnect,
  ownerActorId,
  connectionSyncStatus,
} from "@/lib/sharing/storage";
import {
  idSchema,
  publishedThreadSchema,
  secretSchema,
  SharingError,
  sharingFailure,
} from "@/lib/sharing/schema";

type Params = { params: Promise<{ topic: string; slug: string }> };
const publishSchema = z
  .object({
    action: z
      .enum(["publish", "unpublish", "disconnect", "sync"])
      .default("publish"),
    chatId: idSchema.optional(),
    shareId: secretSchema.optional(),
  })
  .strict();
const publicHeaders = { "cache-control": "private, no-store" };

export async function GET(_request: Request, { params }: Params) {
  try {
    const admission = await requestIdentity();
    if (!admission?.capability) throw new SharingError("Not signed in.", 401);
    const { topic, slug } = await params;
    const connection = readConnection(topic, slug);
    if (connection)
      return await withConnection(
        topic,
        slug,
        admission.capability,
        async (binding) => {
          const state = await connectedState(
            topic,
            slug,
            admission.capability!,
            binding,
          );
          const approved = state.participant.status === "approved";
          const threads = state.threads;
          return Response.json(
            {
              connected: true,
              participantId: binding.participantId,
              ownActorId: binding.participantId,
              mirrorConflict: localMirrorChanged(topic, slug, binding),
              syncErrors: [connectionSyncStatus(topic, slug)?.error].filter(
                (value): value is string => typeof value === "string",
              ),
              status: approved ? "approved" : "pending",
              threads,
              shares: [],
            },
            { headers: publicHeaders },
          );
        },
      );
    return withProfileFiles(
      sharedAccess().identity,
      admission.capability,
      () => {
        const shares = listShares(
          topic,
          slug,
          admission.capability!.username,
        ).filter((share) => share.mode === "collaborate" && !share.revoked);
        return Response.json(
          {
            connected: false,
            status: "owner",
            shares: shares.map((share) => ({
              id: share.id,
              createdAt: share.createdAt,
            })),
            ownActorId: ownerActorId({
              ownerUsername: admission.capability!.username,
              ownerGeneration: admission.capability!.generation,
            }),
            syncErrors: shares.flatMap((share) => {
              const status = sharingSyncStatus(share);
              return status?.error ? [status.error] : [];
            }),
            threads: shares.flatMap((share) =>
              collaborationThreads(share).map((thread) => ({
                ...thread,
                shareId: share.id,
              })),
            ),
          },
          { headers: publicHeaders },
        );
      },
    );
  } catch (error) {
    return sharingFailure(error);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const admission = await requestIdentity();
    if (!admission?.capability) throw new SharingError("Not signed in.", 401);
    const capability = admission.capability;
    const { topic, slug } = await params;
    const body = publishSchema.safeParse(await readBoundedJsonOrNull(request));
    if (!body.success)
      throw new SharingError("Select a conversation to publish.");
    if (body.data.action === "sync") {
      if (readConnection(topic, slug)) await syncConnectedPaper(topic, slug);
      else
        for (const share of listShares(topic, slug, capability.username).filter(
          (entry) => entry.mode === "collaborate" && !entry.revoked,
        ))
          await withCollaboration(share, async () =>
            synchronizeOwnerThreads(share),
          );
      return Response.json({ synced: true }, { headers: publicHeaders });
    }
    if (body.data.action === "disconnect")
      return await withConnection(topic, slug, capability, async (binding) => {
        let remoteRevoked = true;
        try {
          await connectionExchange(topic, slug, capability, binding, {
            action: "leave",
          });
        } catch {
          remoteRevoked = false;
        }
        disconnect(topic, slug, capability, binding);
        return Response.json(
          {
            detached: true,
            remoteRevoked,
            warning: remoteRevoked
              ? null
              : "This copy is independent. The owner must revoke your remote participant because the source could not confirm revocation.",
          },
          { headers: publicHeaders },
        );
      });
    const chatId = body.data.chatId;
    if (!chatId) throw new SharingError("Select a conversation.");
    if (body.data.action === "unpublish") {
      if (readConnection(topic, slug))
        return await withConnection(
          topic,
          slug,
          capability,
          async (binding) => {
            await connectionExchange(topic, slug, capability, binding, {
              action: "unpublish",
              id: chatId,
            });
            withProfileFiles(sharedAccess().identity, capability, () =>
              forgetPublication(topic, slug, chatId),
            );
            return Response.json(
              { unpublished: true },
              { headers: publicHeaders },
            );
          },
        );
      const share = listShares(topic, slug, capability.username).find(
        (entry) =>
          entry.id === body.data.shareId && entry.mode === "collaborate",
      );
      if (!share) throw new SharingError("Unknown collaboration.", 404);
      return await withCollaboration(share, async () => {
        unpublishOwnerChat(share, capability, chatId);
        return Response.json({ unpublished: true }, { headers: publicHeaders });
      });
    }
    const chat = withProfileFiles(sharedAccess().identity, capability, () =>
      readChat(topic, slug, capability.username, chatId),
    );
    if (!chat) throw new SharingError("Unknown conversation.", 404);
    if (readConnection(topic, slug))
      return await withConnection(topic, slug, capability, async (binding) => {
        const bundle = await connectedState(topic, slug, capability, binding);
        const current = bundle.threads.find(
          (thread) =>
            thread.actorId === binding.participantId &&
            thread.id === chat.header.id,
        );
        const packaged = withProfileFiles(
          sharedAccess().identity,
          capability,
          () => packageConversation(chat, companionDir(topic, slug)),
        );
        const published = publishedThreadSchema.parse(
          await connectionExchange(topic, slug, capability, binding, {
            action: "publish",
            ...packaged,
            expected: current?.revision ?? null,
          }),
        );
        withProfileFiles(sharedAccess().identity, capability, () =>
          rememberPublication(topic, slug, chat.header.id),
        );
        return Response.json({ thread: published }, { headers: publicHeaders });
      });
    const share = listShares(topic, slug, capability.username).find(
      (entry) => entry.id === body.data.shareId && entry.mode === "collaborate",
    );
    if (!share) throw new SharingError("Select a collaboration.", 404);
    return await withCollaboration(share, async () => {
      publishOwnerChat(share, capability, chatId);
      return Response.json({ published: true }, { headers: publicHeaders });
    });
  } catch (error) {
    return sharingFailure(error);
  }
}
