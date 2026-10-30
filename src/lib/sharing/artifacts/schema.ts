import { z } from "zod";
import { portableAssetNameSchema } from "../../canvas/media";
import { exerciseRecordSchema } from "../../library/exercises/schema";
import { base64Schema, revisionSchema } from "../protocol/values";

export const artifactSnapshotSchema = z
  .object({
    canvas: z.unknown(),
    assets: z
      .record(portableAssetNameSchema, base64Schema)
      .refine((value) => Object.keys(value).length <= 512),
    exercises: z.array(exerciseRecordSchema).max(100),
    exercisePdf: z
      .object({ etag: revisionSchema, pdf: base64Schema })
      .strict()
      .nullable(),
  })
  .strict();
export type ArtifactSnapshot = z.infer<typeof artifactSnapshotSchema>;
export const artifactVersionsSchema = z
  .object({
    canvas: z.string().regex(/^"(?:empty|[a-zA-Z0-9_-]{43})"$/),
    exercises: revisionSchema,
    exercisePdf: revisionSchema.nullable(),
  })
  .strict();
export type ArtifactVersions = z.infer<typeof artifactVersionsSchema>;
export function emptyArtifacts(): ArtifactSnapshot {
  return { canvas: null, assets: {}, exercises: [], exercisePdf: null };
}
