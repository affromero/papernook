import fs from "node:fs";
import path from "node:path";
import { getPaper } from "../../library/papers";
import {
  readExerciseRecords,
  exerciseSnapshotFiles,
} from "../../library/exercises";
import { readCanvas } from "../../canvas/document";
import { readVersionedPdf, readVersionedPdfFile } from "../../library/pdf/file";
import {
  artifactSnapshotSchema,
  type ArtifactSnapshot,
  type ArtifactVersions,
} from "./schema";
import {
  packageCanvas,
  validatePortableCanvas,
  localizeCanvas,
} from "./canvas";
import { validateSharedPdf } from "../protocol/pdf";
import { SharingError } from "../protocol/values";

export async function artifactVersions(
  topic: string,
  slug: string,
): Promise<ArtifactVersions> {
  const exercises = readExerciseRecords(topic, slug);
  if (exercises.pending)
    throw new SharingError(
      "An exercise save is incomplete. Retry that save before syncing.",
      409,
    );
  return {
    canvas: readCanvas(topic, slug).version,
    exercises: exercises.revision,
    exercisePdf:
      (await readVersionedPdfFile(topic, slug, "exercises"))?.etag ?? null,
  };
}

export async function snapshotArtifacts(
  topic: string,
  slug: string,
): Promise<ArtifactSnapshot> {
  const paper = getPaper(topic, slug);
  if (!paper) throw new SharingError("Unknown paper.", 404);
  const exercises = readExerciseRecords(topic, slug);
  if (exercises.pending)
    throw new SharingError(
      "An exercise save is incomplete. Retry that save before sharing.",
      409,
    );
  const packed = packageCanvas(
    readCanvas(topic, slug).document,
    paper.companionDir,
    topic,
    slug,
  );
  const pdf = await readVersionedPdf(topic, slug, "exercises");
  const result = {
    canvas: packed.canvas,
    assets: packed.assets,
    exercises: exercises.records,
    exercisePdf: pdf
      ? { etag: pdf.etag, pdf: Buffer.from(pdf.bytes).toString("base64") }
      : null,
  };
  return validateArtifacts(result);
}

export function validateArtifacts(value: unknown) {
  const parsed = artifactSnapshotSchema.parse(value);
  const canvas = validatePortableCanvas(parsed.canvas, parsed.assets);
  const records = parsed.exercises;
  if (
    new Set(records.map((record) => record.name)).size !== records.length ||
    new Set(records.map((record) => record.operationId)).size !==
      records.length ||
    records.reduce(
      (total, record) => total + Buffer.byteLength(record.markdown),
      0,
    ) >
      2 * 1024 * 1024
  )
    throw new SharingError(
      "The shared exercises are invalid or too large.",
      422,
    );
  if (parsed.exercisePdf) {
    const bytes = Buffer.from(parsed.exercisePdf.pdf, "base64");
    if (bytes.length > 32 * 1024 * 1024)
      throw new SharingError(
        "Shared exercise PDFs must be at most 32 MB.",
        413,
      );
    validateSharedPdf(bytes, parsed.exercisePdf.etag);
  }
  return { ...parsed, canvas };
}

/** The same explicit files feed private imports and durable mirror intent. */
export function artifactFiles(
  artifacts: ArtifactSnapshot,
  topic: string,
  slug: string,
): Map<string, Buffer> {
  const safe = validateArtifacts(artifacts);
  const files = new Map<string, Buffer>();
  if (safe.canvas)
    files.set(
      "canvas.json",
      Buffer.from(
        JSON.stringify({ document: localizeCanvas(safe.canvas, topic, slug) }),
      ),
    );
  for (const [name, encoded] of Object.entries(safe.assets))
    files.set(`canvas-assets/${name}`, Buffer.from(encoded, "base64"));
  for (const [name, raw] of Object.entries(
    exerciseSnapshotFiles(safe.exercises),
  ))
    files.set(name, Buffer.from(raw));
  if (safe.exercisePdf)
    files.set(
      "paper.exercises.pdf",
      Buffer.from(safe.exercisePdf.pdf, "base64"),
    );
  return files;
}

/** Called only inside a newly reserved private import directory. */
export function stageArtifacts(
  directory: string,
  artifacts: ArtifactSnapshot,
  topic: string,
  slug: string,
): void {
  for (const [name, bytes] of artifactFiles(artifacts, topic, slug)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600, flush: true });
  }
}
