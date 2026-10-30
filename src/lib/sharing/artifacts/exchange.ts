import { z } from "zod";
import { withShareFiles, type PaperShare } from "../../library/shares";
import { readCanvasAsset } from "../../canvas/assets";
import {
  canvasAssetNameSchema,
  MAX_SHARED_ASSET_BYTES,
} from "../../canvas/media";
import { getPaper } from "../../library/papers";
import {
  exerciseMarkdownSchema,
  exerciseOperationSchema,
} from "../../library/exercises/schema";
import { authenticateParticipant, type Participant } from "../storage";
import { base64Schema, SharingError } from "../protocol/values";
import { artifactVersions, snapshotArtifacts } from "./snapshot";
import {
  readSourceCanvas,
  saveSourceCanvas,
  uploadSourceAsset,
  deleteSourceAsset,
  createSourceExercise,
  recoverSourceExercises,
} from "./source";

export const artifactOperations = [
  z.object({ action: z.literal("artifact-versions") }).strict(),
  z.object({ action: z.literal("artifacts") }).strict(),
  z.object({ action: z.literal("canvas") }).strict(),
  z
    .object({
      action: z.literal("save-canvas"),
      version: z.string().regex(/^"(?:empty|[a-zA-Z0-9_-]{43})"$/),
      document: z.unknown(),
    })
    .strict(),
  z
    .object({ action: z.literal("canvas-asset"), name: canvasAssetNameSchema })
    .strict(),
  z
    .object({
      action: z.literal("upload-canvas-asset"),
      bytes: base64Schema,
      mime: z.string().max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete-canvas-asset"),
      name: canvasAssetNameSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("create-exercise"),
      markdown: exerciseMarkdownSchema,
      operationId: exerciseOperationSchema,
    })
    .strict(),
] as const;
const operationSchema = z.discriminatedUnion("action", artifactOperations);

/** Called under collaboration admission; every final filesystem commit rechecks authority. */
export async function exchangeArtifact(
  share: PaperShare,
  token: string,
  participant: Participant,
  value: unknown,
): Promise<unknown> {
  const body = operationSchema.parse(value);
  const { topic, slug } = share;
  const actor = { id: `participant:${participant.id}`, name: participant.name };
  const commit = (operation: () => void) =>
    withShareFiles(share, () => {
      authenticateParticipant(share, token);
      operation();
    });
  if (body.action === "artifact-versions") {
    await recoverSourceExercises(topic, slug, commit);
    return artifactVersions(topic, slug);
  }
  if (body.action === "artifacts") {
    await recoverSourceExercises(topic, slug, commit);
    const versions = await artifactVersions(topic, slug);
    const artifacts = await snapshotArtifacts(topic, slug);
    const after = await artifactVersions(topic, slug);
    if (JSON.stringify(versions) !== JSON.stringify(after))
      throw new SharingError(
        "The shared artifacts changed while reading. Try again.",
        409,
      );
    return { versions, artifacts };
  }
  if (body.action === "canvas") return readSourceCanvas(topic, slug);
  if (body.action === "save-canvas")
    return saveSourceCanvas(
      topic,
      slug,
      body.version,
      body.document,
      actor,
      commit,
    );
  if (body.action === "create-exercise")
    return createSourceExercise(
      topic,
      slug,
      body.markdown,
      body.operationId,
      actor,
      commit,
    );
  if (body.action === "upload-canvas-asset") {
    if (body.bytes.length > Math.ceil(MAX_SHARED_ASSET_BYTES / 3) * 4)
      throw new SharingError(
        "Shared canvas uploads support at most 8 MB.",
        413,
      );
    return {
      name: uploadSourceAsset(
        topic,
        slug,
        Buffer.from(body.bytes, "base64"),
        body.mime,
        actor,
        commit,
      ),
    };
  }
  if (body.action === "delete-canvas-asset") {
    deleteSourceAsset(topic, slug, body.name, actor, commit);
    return { deleted: true };
  }
  const paper = getPaper(topic, slug);
  if (!paper) throw new SharingError("Unknown paper.", 404);
  const asset = readCanvasAsset(paper.companionDir, body.name, true);
  return {
    name: asset.name,
    mime: asset.mime,
    bytes: asset.bytes.toString("base64"),
  };
}
