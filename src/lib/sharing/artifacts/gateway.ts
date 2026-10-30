import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { companionDir } from "../../library/papers";
import { requestIdentity } from "../../auth/access";
import { type ProfileCapability } from "../../auth/profile-capability";
import { readCanvas } from "../../canvas/document";
import {
  canvasMediaType,
  portableAssetNameSchema,
  validateCanvasMedia,
} from "../../canvas/media";
import { validateSharedCanvas } from "../../canvas/validation";
import { readExerciseRecords } from "../../library/exercises";
import { readConnection, withConnection, type Connection } from "../storage";
import { connectionExchange } from "../gateway";
import { SharingError, base64Schema } from "../protocol/values";
import { artifactVersionsSchema, artifactSnapshotSchema } from "./schema";
import { validateArtifacts, artifactVersions } from "./snapshot";
import type { ArtifactVersions } from "./schema";
import { installArtifacts } from "./mirror";

const responseSchema = z
  .object({
    versions: artifactVersionsSchema,
    artifacts: artifactSnapshotSchema,
  })
  .strict();

export async function syncConnectedArtifacts(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  connection: Connection,
  knownVersions?: ArtifactVersions,
): Promise<void> {
  const versions =
    knownVersions ??
    artifactVersionsSchema.parse(
      await connectionExchange(topic, slug, capability, connection, {
        action: "artifact-versions",
      }),
    );
  if (
    JSON.stringify(connection.artifacts?.source) === JSON.stringify(versions) &&
    !fs.existsSync(
      path.join(
        companionDir(topic, slug),
        "collaboration",
        "artifacts-pending.json",
      ),
    )
  ) {
    if (
      JSON.stringify(await artifactVersions(topic, slug)) !==
      JSON.stringify(connection.artifacts!.mirror)
    )
      throw new SharingError(
        "A local canvas or exercise changed outside collaboration. Preserve that copy before syncing.",
        409,
      );
    return;
  }
  const result = responseSchema.parse(
    await connectionExchange(topic, slug, capability, connection, {
      action: "artifacts",
    }),
  );
  const safe = validateArtifacts(result.artifacts);
  await installArtifacts(
    topic,
    slug,
    capability,
    connection,
    result.versions,
    safe,
  );
}

async function connectedArtifact<Result>(
  topic: string,
  slug: string,
  operation: (
    connection: Connection,
    capability: ProfileCapability,
  ) => Promise<Result>,
): Promise<Result | null> {
  if (!readConnection(topic, slug)) return null;
  const admission = await requestIdentity();
  if (!admission?.capability) throw new SharingError("Not signed in.", 401);
  return withConnection(topic, slug, admission.capability, (connection) =>
    operation(connection, admission.capability!),
  );
}

export function connectedCanvas(topic: string, slug: string) {
  return connectedArtifact(topic, slug, async (connection, capability) => {
    await syncConnectedArtifacts(topic, slug, capability, connection);
    return {
      document: readCanvas(topic, slug).document,
      version: connection.artifacts!.source!.canvas,
    };
  });
}

export function saveConnectedCanvas(
  topic: string,
  slug: string,
  version: string,
  value: unknown,
) {
  return connectedArtifact(topic, slug, async (connection, capability) => {
    const prefix = `/api/v1/papers/${topic}/${slug}/canvas/assets/`;
    const document = validateSharedCanvas(value, (source) => {
      if (!source.startsWith(prefix))
        throw new SharingError("Canvas media must belong to this paper.", 422);
      return `/canvas-assets/${portableAssetNameSchema.parse(source.slice(prefix.length))}`;
    });
    const result = z
      .object({ version: z.string(), document: z.unknown() })
      .strict()
      .parse(
        await connectionExchange(topic, slug, capability, connection, {
          action: "save-canvas",
          version,
          document,
        }),
      );
    // Validate the canonical result through a complete, hash-checked snapshot.
    await syncConnectedArtifacts(topic, slug, capability, connection);
    if (connection.artifacts!.source!.canvas !== result.version)
      throw new SharingError(
        "The canvas changed again after saving. Reload to see the latest version.",
        409,
      );
    return {
      document: readCanvas(topic, slug).document,
      version: result.version,
    };
  });
}

export function connectedCanvasAsset(
  topic: string,
  slug: string,
  name: string,
) {
  return connectedArtifact(topic, slug, async (connection, capability) => {
    portableAssetNameSchema.parse(name);
    const result = z
      .object({
        name: portableAssetNameSchema,
        mime: z.string(),
        bytes: base64Schema,
      })
      .strict()
      .parse(
        await connectionExchange(topic, slug, capability, connection, {
          action: "canvas-asset",
          name,
        }),
      );
    const bytes = Buffer.from(result.bytes, "base64");
    if (
      result.name !== name ||
      result.mime !== canvasMediaType(name) ||
      validateCanvasMedia(bytes, result.mime, true) !== name
    )
      throw new SharingError("The shared canvas media is invalid.", 502);
    return { bytes, mime: result.mime };
  });
}

export function uploadConnectedCanvasAsset(
  topic: string,
  slug: string,
  bytes: Uint8Array,
  mime: string,
) {
  return connectedArtifact(topic, slug, async (connection, capability) => {
    const name = validateCanvasMedia(bytes, mime, true);
    const result = z
      .object({ name: portableAssetNameSchema })
      .strict()
      .parse(
        await connectionExchange(topic, slug, capability, connection, {
          action: "upload-canvas-asset",
          bytes: Buffer.from(bytes).toString("base64"),
          mime,
        }),
      );
    if (result.name !== name)
      throw new SharingError(
        "The shared canvas media address is invalid.",
        502,
      );
    return { src: `/api/v1/papers/${topic}/${slug}/canvas/assets/${name}` };
  });
}

export function deleteConnectedCanvasAsset(
  topic: string,
  slug: string,
  name: string,
) {
  return connectedArtifact(topic, slug, async (connection, capability) => {
    portableAssetNameSchema.parse(name);
    await connectionExchange(topic, slug, capability, connection, {
      action: "delete-canvas-asset",
      name,
    });
    return { deleted: true };
  });
}

export function connectedExercises(topic: string, slug: string) {
  return connectedArtifact(topic, slug, async (connection, capability) => {
    await syncConnectedArtifacts(topic, slug, capability, connection);
    return { exercises: readExerciseRecords(topic, slug).records };
  });
}

export function createConnectedExercise(
  topic: string,
  slug: string,
  markdown: string,
  operationId: string,
) {
  return connectedArtifact(topic, slug, async (connection, capability) => {
    const result = z
      .object({ saved: z.string() })
      .strict()
      .parse(
        await connectionExchange(topic, slug, capability, connection, {
          action: "create-exercise",
          markdown,
          operationId,
        }),
      );
    await syncConnectedArtifacts(topic, slug, capability, connection);
    return result;
  });
}
