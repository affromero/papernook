import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { guardStream } from "thesidedoor-core/runtime/stream";
import {
  acquireFileLock,
  acquireFileLockSync,
  FileLockBusyError,
  syncDirectory,
} from "thesidedoor-core/storage";
import { dataRoot } from "../data-dir";
import { PapernookIdentityStore } from "../auth/identity-store";
import {
  withProfileActivity,
  withProfileFiles,
  type ProfileCapability,
} from "../auth/profile-capability";
import {
  companionDir,
  getPaper,
  visitPaperCompanions,
  withPaperMutation,
} from "../library/papers";
import { getShare, withShareFiles, type PaperShare } from "../library/shares";
import { pdfEtag } from "../library/pdf/file";
import { artifactVersionsSchema } from "./artifacts/schema";
import {
  idSchema,
  labelSchema,
  secretSchema,
  slugSchema,
  revisionSchema,
  SharingError,
  sharingStatusSchema,
} from "./schema";

export const participantSchema = z
  .object({
    id: idSchema,
    tokenHash: secretSchema,
    requestedName: labelSchema,
    name: labelSchema,
    status: z.enum(["pending", "approved", "revoked"]),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Participant = z.infer<typeof participantSchema>;
const connectionSchema = z
  .object({
    version: z.literal(1),
    url: z.string().url(),
    token: secretSchema,
    participantId: idSchema,
    username: slugSchema,
    generation: z.number().int().nonnegative(),
    mirrorEtag: revisionSchema,
    artifacts: z
      .object({
        source: artifactVersionsSchema.nullable(),
        mirror: artifactVersionsSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function newSecret(): string {
  return randomBytes(32).toString("hex");
}
export function participantId(token: string): string {
  return digest(token).slice(0, 16);
}

export function ownerActorId(
  share: Pick<PaperShare, "ownerUsername" | "ownerGeneration">,
): string {
  return digest(`owner:${share.ownerUsername}:${share.ownerGeneration}`).slice(
    0,
    16,
  );
}

export function ensureCollaborationOwner(share: PaperShare): void {
  const file = path.join(collaborationDir(share), "owner.json");
  const expected = {
    username: share.ownerUsername,
    generation: share.ownerGeneration,
    shareId: share.id,
  };
  if (fs.existsSync(file)) {
    const parsed = z
      .object({
        username: slugSchema,
        generation: z.number().int().nonnegative(),
        shareId: secretSchema,
      })
      .strict()
      .parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (
      parsed.username !== expected.username ||
      parsed.generation !== expected.generation ||
      parsed.shareId !== expected.shareId
    )
      throw new SharingError("Collaboration ownership is inconsistent.", 409);
    return;
  }
  withShareFiles(share, () => writeJson(file, expected));
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function collaborationDir(share: PaperShare): string {
  return path.join(
    companionDir(share.topic, share.slug),
    "collaboration",
    share.id,
  );
}

export function requireCollaboration(
  topic: string,
  slug: string,
  shareId: string,
): PaperShare {
  const share = getShare(topic, slug, shareId);
  if (!share || share.mode !== "collaborate")
    throw new SharingError("Unknown collaboration.", 404);
  return share;
}

export function readParticipants(share: PaperShare): Participant[] {
  const file = path.join(collaborationDir(share), "participants.json");
  if (!fs.existsSync(file)) return [];
  return z
    .array(participantSchema)
    .max(32)
    .parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function authenticateParticipant(
  share: PaperShare,
  token: string,
  approved = true,
): Participant {
  if (!secretSchema.safeParse(token).success)
    throw new SharingError("Invalid collaboration credential.", 401);
  const hash = digest(token);
  if (fs.existsSync(path.join(collaborationDir(share), "revoked", hash)))
    throw new SharingError(
      "This collaboration credential has been revoked.",
      403,
    );
  const participant = readParticipants(share).find((p) =>
    timingSafeEqual(Buffer.from(p.tokenHash, "hex"), Buffer.from(hash, "hex")),
  );
  if (!participant || participant.status === "revoked")
    throw new SharingError(
      "Collaboration access was revoked or is unknown.",
      403,
    );
  if (
    participant.status === "pending" &&
    Date.now() - Date.parse(participant.createdAt) > 24 * 60 * 60_000
  )
    throw new SharingError("The collaboration request expired.", 403);
  if (approved && participant.status !== "approved")
    throw new SharingError("Waiting for owner approval.", 403);
  return participant;
}

/** Authority lock is shared by remote commits, approval and link revocation. */
export async function withCollaboration<Result>(
  share: PaperShare,
  operation: () => Promise<Result>,
): Promise<Result> {
  if (share.ownerGeneration === undefined)
    throw new SharingError("Unknown collaboration.", 404);
  const identity = new PapernookIdentityStore(dataRoot());
  return withProfileActivity(
    identity,
    { username: share.ownerUsername, generation: share.ownerGeneration },
    async () => {
      const release = await acquireFileLock(
        path.join(dataRoot(), "locks", "collaboration", `${share.id}.guard`),
      );
      try {
        withShareFiles(share, () => undefined);
        ensureCollaborationOwner(share);
        return await operation();
      } finally {
        await release();
      }
    },
  );
}

export function requestParticipant(
  share: PaperShare,
  token: string,
  name: string,
): Participant {
  secretSchema.parse(token);
  if (
    fs.existsSync(path.join(collaborationDir(share), "revoked", digest(token)))
  )
    throw new SharingError(
      "This collaboration credential has been revoked.",
      403,
    );
  const label = labelSchema.parse(name);
  return withShareFiles(share, () => {
    const participants = readParticipants(share).filter(
      (p) =>
        p.status === "approved" ||
        (p.status === "pending" &&
          Date.now() - Date.parse(p.createdAt) <= 24 * 60 * 60_000),
    );
    const existing = participants.find((p) => p.tokenHash === digest(token));
    if (existing) return authenticateParticipant(share, token, false);
    if (participants.length >= 32)
      throw new SharingError(
        "This collaboration has reached its request limit.",
        429,
      );
    const participant: Participant = {
      id: participantId(token),
      tokenHash: digest(token),
      requestedName: label,
      name: label,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    writeJson(path.join(collaborationDir(share), "participants.json"), [
      ...participants,
      participant,
    ]);
    return participant;
  });
}

export function setParticipant(
  share: PaperShare,
  id: string,
  status: "approved" | "revoked",
  name?: string,
): void {
  idSchema.parse(id);
  const participants = readParticipants(share);
  const participant = participants.find((p) => p.id === id);
  if (!participant) throw new SharingError("Unknown participant.", 404);
  if (
    status === "approved" &&
    (participant.status === "revoked" ||
      (Date.now() - Date.parse(participant.createdAt) > 24 * 60 * 60_000 &&
        participant.status === "pending"))
  )
    throw new SharingError(
      "This credential cannot be approved. Request access again.",
      409,
    );
  participant.status = status;
  if (status === "revoked") {
    const folder = path.join(collaborationDir(share), "revoked");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, participant.tokenHash);
    if (!fs.existsSync(file))
      fs.writeFileSync(file, "", { flag: "wx", mode: 0o600, flush: true });
    syncDirectory(folder);
  }
  if (name !== undefined) participant.name = labelSchema.parse(name);
  withShareFiles(share, () =>
    writeJson(
      path.join(collaborationDir(share), "participants.json"),
      participants.filter((entry) => entry.status !== "revoked"),
    ),
  );
}

export function leaveCollaboration(
  share: PaperShare,
  participant: Participant,
): void {
  if (participant.status === "approved") {
    setParticipant(share, participant.id, "revoked");
    return;
  }
  withShareFiles(share, () =>
    writeJson(
      path.join(collaborationDir(share), "participants.json"),
      readParticipants(share).filter((entry) => entry.id !== participant.id),
    ),
  );
}

/** Bound aggregate buffering and PDF parsing across requests and processes. */
function acquireSharingTransfer(
  direction: "incoming" | "outgoing",
): () => void {
  for (let slot = 0; slot < 2; slot++) {
    let release: () => void;
    try {
      release = acquireFileLockSync(
        path.join(
          dataRoot(),
          "locks",
          "sharing-transfer",
          `${direction}-${slot}.guard`,
        ),
      );
    } catch (error) {
      if (error instanceof FileLockBusyError) continue;
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
  throw new SharingError("Sharing is busy. Try again in a moment.", 429);
}

export async function withSharingTransfer<Result>(
  operation: () => Promise<Result>,
  direction: "incoming" | "outgoing" = "incoming",
): Promise<Result> {
  const release = acquireSharingTransfer(direction);
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Keep large response buffers admitted until the transport drains or cancels. */
export async function withSharingResponse(
  operation: () => Promise<Response>,
): Promise<Response> {
  const release = acquireSharingTransfer("incoming");
  try {
    const response = await operation();
    if (!response.ok || !response.body) {
      release();
      return response;
    }
    return streamTransferResponse(response, release);
  } catch (error) {
    release();
    throw error;
  }
}

function streamTransferResponse(
  response: Response,
  release: () => void,
): Response {
  const reader = response.body!.getReader();
  let pending: Uint8Array | null = null;
  let offset = 0;
  let stopped = false;
  let cleanup: Promise<void> | null = null;
  let released = false;
  let deadline: ReturnType<typeof setTimeout>;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    clearTimeout(deadline);
    release();
  };
  const stop = (reason: unknown): Promise<void> => {
    stopped = true;
    pending = null;
    offset = 0;
    cleanup ??= (async () => {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    })();
    return cleanup;
  };
  const copied = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        deadline = setTimeout(() => {
          if (stopped) return;
          const error = new SharingError("Sharing response timed out.", 408);
          controller.error(error);
          void stop(error)
            .finally(releaseOnce)
            .catch(() => {
              console.error("papernook sharing: response cleanup failed");
            });
        }, 60_000);
      },
      async pull(controller) {
        try {
          if (stopped) return;
          if (!pending) {
            const next = await reader.read();
            if (stopped) return;
            if (next.done) {
              stopped = true;
              reader.releaseLock();
              controller.close();
              return;
            }
            pending = next.value;
            offset = 0;
          }
          const end = Math.min(pending.byteLength, offset + 64 * 1024);
          // A view would keep the entire serialized response alive in Node's
          // blocked write. Each socket may retain only its bounded copy.
          const chunk = Uint8Array.from(pending.subarray(offset, end));
          offset = end;
          if (offset === pending.byteLength) {
            pending = null;
            offset = 0;
          }
          controller.enqueue(chunk);
        } catch (error) {
          await stop(error).catch(() => undefined);
          throw error;
        }
      },
      cancel(reason) {
        return stop(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(
    guardStream(copied, { validate: () => undefined, release: releaseOnce }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

export function publicParticipant(participant: Participant) {
  return {
    id: participant.id,
    requestedName: participant.requestedName,
    name: participant.name,
    status: participant.status,
    createdAt: participant.createdAt,
  };
}

function connectionPath(topic: string, slug: string): string {
  return path.join(
    companionDir(topic, slug),
    "collaboration",
    "connection.json",
  );
}
export function readConnection(topic: string, slug: string): Connection | null {
  const file = connectionPath(topic, slug);
  try {
    return connectionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw new SharingError(
      "The saved collaboration binding is unavailable or invalid. Repair it before editing this paper.",
      503,
    );
  }
}
export function withConnection<Result>(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  operation: (connection: Connection) => Promise<Result>,
): Promise<Result> {
  return withProfileActivity(
    new PapernookIdentityStore(dataRoot()),
    capability,
    async () => {
      const connection = readConnection(topic, slug);
      if (
        !getPaper(topic, slug) ||
        !connection ||
        connection.username !== capability.username ||
        connection.generation !== capability.generation
      )
        throw new SharingError(
          "This collaboration belongs to another profile.",
          403,
        );
      const release = await acquireFileLock(
        path.join(dataRoot(), "locks", "sharing-connection", `${slug}.guard`),
        { signal: AbortSignal.timeout(60_000) },
      );
      try {
        const identity = new PapernookIdentityStore(dataRoot());
        const latest = withProfileFiles(identity, capability, () => {
          assertCurrentConnection(topic, slug, capability, connection);
          return readConnection(topic, slug)!;
        });
        const result = await operation(latest);
        withProfileFiles(identity, capability, () => undefined);
        return result;
      } finally {
        await release();
      }
    },
  );
}
export function saveConnection(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  connection: Connection,
  initial = false,
  before?: () => void,
): void {
  withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
    withPaperMutation(slug, () => {
      if (!getPaper(topic, slug))
        throw new SharingError("The connected paper was removed.", 404);
      if (!initial)
        assertCurrentConnection(topic, slug, capability, connection);
      const paper = getPaper(topic, slug);
      if (
        !paper ||
        pdfEtag(fs.readFileSync(paper.pdfPath)) !== connection.mirrorEtag
      )
        throw new SharingError(
          "The local PDF changed while syncing. Try again.",
          409,
        );
      before?.();
      writeJson(
        connectionPath(topic, slug),
        connectionSchema.parse(connection),
      );
    }),
  );
}

export function assertCurrentConnection(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  expected: Connection,
): void {
  const current = readConnection(topic, slug);
  if (
    !getPaper(topic, slug) ||
    !current ||
    current.token !== expected.token ||
    current.participantId !== expected.participantId ||
    current.username !== capability.username ||
    current.generation !== capability.generation
  )
    throw new SharingError("This collaboration was removed or replaced.", 403);
}

export function publicationIds(topic: string, slug: string): string[] {
  const file = path.join(
    companionDir(topic, slug),
    "collaboration",
    "publications.json",
  );
  if (!fs.existsSync(file)) return [];
  return z
    .array(idSchema)
    .max(100)
    .parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function rememberPublication(
  topic: string,
  slug: string,
  id: string,
): void {
  const ids = publicationIds(topic, slug);
  if (!ids.includes(id))
    writeJson(
      path.join(
        companionDir(topic, slug),
        "collaboration",
        "publications.json",
      ),
      [...ids, id],
    );
}

export function eraseSharingConnections(username: string): void {
  visitPaperCompanions(({ directory }) => {
    const folder = path.join(directory, "collaboration");
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder)) {
      if (/^artifacts-pending\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name)) {
        const file = path.join(folder, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 100 * 1024 * 1024)
          throw new SharingError(
            "Artifact recovery ownership is unavailable during profile erasure.",
            503,
          );
        const owner = z
          .object({
            username: slugSchema,
            generation: z.number().int().nonnegative(),
          })
          .parse(JSON.parse(fs.readFileSync(file, "utf8")));
        if (owner.username === username) fs.unlinkSync(file);
        continue;
      }
      if (
        name !== "connection.json" &&
        !/^connection\.json\.[a-f0-9-]{36}\.tmp$/.test(name)
      )
        continue;
      const file = path.join(folder, name);
      const binding = connectionSchema.parse(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
      if (binding.username === username) fs.unlinkSync(file);
    }
    syncDirectory(folder);
  });
}

export function forgetPublication(
  topic: string,
  slug: string,
  id: string,
): void {
  writeJson(
    path.join(companionDir(topic, slug), "collaboration", "publications.json"),
    publicationIds(topic, slug).filter((value) => value !== id),
  );
}

export function disconnect(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  connection: Connection,
): void {
  withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
    withPaperMutation(slug, () => {
      assertCurrentConnection(topic, slug, capability, connection);
      fs.unlinkSync(connectionPath(topic, slug));
      syncDirectory(path.dirname(connectionPath(topic, slug)));
    }),
  );
}

export function connectionSyncStatus(topic: string, slug: string) {
  const file = path.join(
    companionDir(topic, slug),
    "collaboration",
    "sync-status.json",
  );
  return fs.existsSync(file)
    ? sharingStatusSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")))
    : null;
}

export function setConnectionSyncStatus(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  connection: Connection,
  error: string | null,
): void {
  withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
    withPaperMutation(slug, () => {
      assertCurrentConnection(topic, slug, capability, connection);
      writeJson(
        path.join(
          companionDir(topic, slug),
          "collaboration",
          "sync-status.json",
        ),
        { error, at: new Date().toISOString() },
      );
    }),
  );
}
