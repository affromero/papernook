import crypto from "node:crypto";
import { getPaper } from "../../library/papers";
import { readCanvas, saveCanvas } from "../../canvas/document";
import {
  readCanvasAsset,
  storeCanvasAsset,
  removeCanvasAsset,
} from "../../canvas/assets";
import { attributeCanvas, validateSharedCanvas } from "../../canvas/validation";
import { portableAssetNameSchema } from "../../canvas/media";
import {
  readExerciseRecords,
  findExerciseOperation,
  commitExerciseOperation,
  pendingExerciseOperations,
} from "../../library/exercises";
import {
  exerciseMarkdownSchema,
  exerciseOperationSchema,
  ExerciseError,
} from "../../library/exercises/schema";
import {
  readVersionedPdf,
  replacePdf,
  pdfEtag,
  verifyPdfVersion,
} from "../../library/pdf/file";
import { withFilesystemLock } from "../../filesystem-lock";
import { renderSharedExercises } from "../sandbox";
import { SharingError } from "../protocol/values";
import { localizeCanvas, packageCanvas } from "./canvas";

export interface ArtifactActor {
  id: string;
  name: string;
}
export type ArtifactCommit = (operation: () => void) => void;

export function readSourceCanvas(topic: string, slug: string) {
  const paper = getPaper(topic, slug);
  if (!paper) throw new SharingError("Unknown paper.", 404);
  const current = readCanvas(topic, slug);
  const packed = packageCanvas(
    current.document,
    paper.companionDir,
    topic,
    slug,
  );
  return {
    document: packed.canvas,
    assets: packed.assets,
    version: current.version,
  };
}

export function saveSourceCanvas(
  topic: string,
  slug: string,
  version: string,
  value: unknown,
  actor: ArtifactActor,
  commit: ArtifactCommit,
  portable = true,
) {
  const paper = getPaper(topic, slug);
  if (!paper) throw new SharingError("Unknown paper.", 404);
  const current = readCanvas(topic, slug);
  const previous = packageCanvas(
    current.document,
    paper.companionDir,
    topic,
    slug,
  );
  const names = { ...previous.sourceNames };
  const next = portable
    ? validateSharedCanvas(value, (source) => {
        if (!source.startsWith("/canvas-assets/"))
          throw new SharingError("Invalid canvas media address.", 422);
        const name = portableAssetNameSchema.parse(source.slice(15));
        const original = names[name] ?? name;
        const asset = readCanvasAsset(paper.companionDir, original, true);
        if (asset.name !== name)
          throw new SharingError("Invalid canvas media digest.", 422);
        names[name] = original;
        return source;
      })
    : packageCanvas(value, paper.companionDir, topic, slug).canvas;
  if (!next)
    throw new SharingError("A shared canvas must contain a document.", 422);
  const document = attributeCanvas(next, previous.canvas, actor);
  const localized = localizeCanvas(document, topic, slug, names);
  // Repackage enforces the aggregate asset limit on this exact new document.
  packageCanvas(localized, paper.companionDir, topic, slug);
  let saved = "";
  commit(() => {
    saved = saveCanvas(topic, slug, version, localized);
  });
  return { document, version: saved };
}

export function uploadSourceAsset(
  topic: string,
  slug: string,
  bytes: Uint8Array,
  mime: string,
  actor: ArtifactActor,
  commit: ArtifactCommit,
): string {
  let name = "";
  commit(() => {
    name = storeCanvasAsset(topic, slug, bytes, mime, actor.id, true);
  });
  return name;
}

export function deleteSourceAsset(
  topic: string,
  slug: string,
  name: string,
  actor: ArtifactActor,
  commit: ArtifactCommit,
): void {
  commit(() => removeCanvasAsset(topic, slug, name, actor.id));
}

/** Append pages in the isolated PDF worker. Existing ink and coordinates survive. */
export async function createSourceExercise(
  topic: string,
  slug: string,
  markdown: string,
  operationId: string,
  actor: ArtifactActor,
  commit: ArtifactCommit,
) {
  const content = exerciseMarkdownSchema.parse(markdown);
  exerciseOperationSchema.parse(operationId);
  return withFilesystemLock("exercises", `${topic}/${slug}`, 2000, async () => {
    const paper = getPaper(topic, slug);
    if (!paper) throw new SharingError("Unknown paper.", 404);
    const current = readExerciseRecords(topic, slug);
    const previous = findExerciseOperation(topic, slug, operationId);
    if (
      previous &&
      (previous.actorId !== actor.id ||
        previous.markdownHash !==
          crypto.createHash("sha256").update(content).digest("hex"))
    )
      throw new ExerciseError(
        "This exercise operation was already used for different content.",
        409,
      );
    if (previous?.status === "complete") {
      let saved = "";
      commit(() => {
        saved = commitExerciseOperation(
          topic,
          slug,
          {
            operationId,
            markdown: content,
            actorId: actor.id,
            author: actor.name,
            createdAt: previous.createdAt,
          },
          current.revision,
        );
      });
      return { saved };
    }
    if (current.pending && !previous)
      throw new ExerciseError(
        "Retry the incomplete exercise save before adding another.",
        409,
      );
    const pdf = await readVersionedPdf(topic, slug, "exercises");
    const entry = { operationId, markdown: content };
    const entries = pdf
      ? [entry]
      : [
          ...current.records.filter(
            (record) => record.operationId !== operationId,
          ),
          entry,
        ];
    const bytes = await renderSharedExercises(
      pdf?.bytes ?? null,
      paper.meta.title,
      entries,
    );
    let saved = "";
    const record = {
      ...entry,
      actorId: actor.id,
      author: actor.name,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
    if (pdf && pdfEtag(bytes) === pdf.etag) {
      await verifyPdfVersion(
        topic,
        slug,
        pdf.etag,
        (verify) =>
          commit(() => {
            verify();
            saved = commitExerciseOperation(
              topic,
              slug,
              record,
              current.revision,
            );
          }),
        "exercises",
      );
    } else {
      await replacePdf(
        topic,
        slug,
        pdf?.etag ?? null,
        bytes,
        (replace) =>
          commit(() => {
            saved = commitExerciseOperation(
              topic,
              slug,
              record,
              current.revision,
              replace,
            );
          }),
        "exercises",
      );
    }
    return { saved };
  });
}

/** Finish only content already durably accepted under the original contributor. */
export async function recoverSourceExercises(
  topic: string,
  slug: string,
  commit: ArtifactCommit,
): Promise<void> {
  for (const pending of pendingExerciseOperations(topic, slug))
    await createSourceExercise(
      topic,
      slug,
      pending.markdown,
      pending.operationId,
      { id: pending.actorId, name: pending.author },
      commit,
    );
}
