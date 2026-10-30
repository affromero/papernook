import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { syncDirectory } from "thesidedoor-core/storage";
import {
  getPaper,
  exercisesPdfPath,
  withPaperMutation,
} from "../../library/papers";
import { readCanvas } from "../../canvas/document";
import { readExerciseRecords } from "../../library/exercises";
import { readVersionedPdf, replacePdf, pdfEtag } from "../../library/pdf/file";
import {
  withProfileFiles,
  type ProfileCapability,
} from "../../auth/profile-capability";
import { PapernookIdentityStore } from "../../auth/identity-store";
import { dataRoot } from "../../data-dir";
import {
  saveConnection,
  assertCurrentConnection,
  writeJson,
  type Connection,
} from "../storage";
import { base64Schema, SharingError } from "../protocol/values";
import {
  artifactVersionsSchema,
  type ArtifactVersions,
  type ArtifactSnapshot,
} from "./schema";
import { artifactVersions, artifactFiles } from "./snapshot";
import { packageCanvas } from "./canvas";

const fileSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^(?:canvas\.json|paper\.exercises\.pdf|exercises\/(?:state\.json|[a-z0-9][a-z0-9-]{0,79}\.md)|canvas-assets\/[a-f0-9]{64}\.(?:png|jpg|gif|webp|mov|mp4|webm))$/,
      ),
    before: z
      .string()
      .regex(/^"[a-f0-9]{64}"$/)
      .nullable(),
    bytes: base64Schema.nullable(),
  })
  .strict();
const journalSchema = z
  .object({
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    username: z.string(),
    generation: z.number().int().nonnegative(),
    source: artifactVersionsSchema,
    files: z.array(fileSchema).max(1200),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;

function hashFile(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw new SharingError(
        "A local shared artifact is invalid or too large.",
        409,
      );
    return pdfEtag(fs.readFileSync(file));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
function targetFile(
  directory: string,
  topic: string,
  slug: string,
  name: string,
): string {
  return name === "paper.exercises.pdf"
    ? exercisesPdfPath(topic, slug)
    : path.join(directory, name);
}
function tokenHash(connection: Connection) {
  return crypto.createHash("sha256").update(connection.token).digest("hex");
}
function readJournal(file: string, connection: Connection): Journal | null {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024)
    throw new SharingError("Artifact recovery data is invalid.", 409);
  const journal = journalSchema.parse(
    JSON.parse(fs.readFileSync(file, "utf8")),
  );
  if (
    journal.tokenHash !== tokenHash(connection) ||
    journal.username !== connection.username ||
    journal.generation !== connection.generation
  )
    throw new SharingError(
      "Artifact recovery belongs to a different connection. Preserve it before reconnecting.",
      409,
    );
  if (
    new Set(journal.files.map((file) => file.name)).size !==
    journal.files.length
  )
    throw new SharingError("Artifact recovery contains duplicate paths.", 409);
  return journal;
}

/** A durable intent permits retry after interruption, while preserving unexpected local writes. */
async function applyJournal(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  connection: Connection,
  journal: Journal,
  journalFile: string,
): Promise<void> {
  const paper = getPaper(topic, slug);
  if (!paper) throw new SharingError("Unknown paper.", 404);
  const filePath = (name: string) =>
    targetFile(paper.companionDir, topic, slug, name);
  const verify = () => {
    for (const file of journal.files) {
      const current = hashFile(filePath(file.name));
      const desired =
        file.bytes === null ? null : pdfEtag(Buffer.from(file.bytes, "base64"));
      if (current !== file.before && current !== desired)
        throw new SharingError(
          "A local canvas, exercise or PDF changed outside collaboration. Preserve that copy before syncing.",
          409,
        );
    }
  };
  const pdfEntry = journal.files.find(
    (file) => file.name === "paper.exercises.pdf",
  );
  const currentPdf = await readVersionedPdf(topic, slug, "exercises");
  const next = { ...connection };
  const commit = (replace?: () => void) =>
    saveConnection(topic, slug, capability, next, false, () => {
      verify();
      writeJson(journalFile, journal);
      for (const entry of journal.files) {
        const file = filePath(entry.name);
        if (entry.name === "paper.exercises.pdf" && replace) {
          replace();
          continue;
        }
        const desired =
          entry.bytes === null
            ? null
            : pdfEtag(Buffer.from(entry.bytes, "base64"));
        if (hashFile(file) === desired) continue;
        if (entry.bytes === null) {
          fs.rmSync(file, { force: true });
          syncDirectory(path.dirname(file));
          continue;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${crypto.randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temp, Buffer.from(entry.bytes, "base64"), {
            flag: "wx",
            mode: 0o600,
            flush: true,
          });
          fs.renameSync(temp, file);
          syncDirectory(path.dirname(file));
        } finally {
          fs.rmSync(temp, { force: true });
        }
      }
      next.artifacts = {
        source: journal.source,
        mirror: {
          canvas: readCanvas(topic, slug).version,
          exercises: readExerciseRecords(topic, slug).revision,
          exercisePdf: hashFile(exercisesPdfPath(topic, slug)),
        },
      };
    });
  verify();
  if (
    pdfEntry?.bytes &&
    (currentPdf?.etag ?? null) !==
      pdfEtag(Buffer.from(pdfEntry.bytes, "base64"))
  )
    await replacePdf(
      topic,
      slug,
      currentPdf?.etag ?? null,
      Buffer.from(pdfEntry.bytes, "base64"),
      commit,
      "exercises",
    );
  else commit();
  Object.assign(connection, next);
  withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
    withPaperMutation(slug, () => {
      assertCurrentConnection(topic, slug, capability, connection);
      fs.rmSync(journalFile, { force: true });
      syncDirectory(path.dirname(journalFile));
    }),
  );
}

export async function installArtifacts(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  connection: Connection,
  source: ArtifactVersions,
  artifacts: ArtifactSnapshot,
): Promise<void> {
  withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
    assertCurrentConnection(topic, slug, capability, connection),
  );
  const paper = getPaper(topic, slug);
  if (!paper) throw new SharingError("Unknown paper.", 404);
  const directory = paper.companionDir;
  const journalFile = path.join(
    directory,
    "collaboration",
    "artifacts-pending.json",
  );
  const pending = readJournal(journalFile, connection);
  if (pending)
    await applyJournal(
      topic,
      slug,
      capability,
      connection,
      pending,
      journalFile,
    );
  const local = await artifactVersions(topic, slug);
  const baseline = connection.artifacts?.mirror;
  if (
    baseline
      ? JSON.stringify(local) !== JSON.stringify(baseline)
      : readCanvas(topic, slug).document !== null ||
        readExerciseRecords(topic, slug).records.length ||
        local.exercisePdf
  )
    throw new SharingError(
      "A local canvas or exercise changed outside collaboration. Preserve that copy before syncing.",
      409,
    );
  if (JSON.stringify(connection.artifacts?.source) === JSON.stringify(source))
    return;
  const desiredFiles = artifactFiles(artifacts, topic, slug);
  const oldCanvas = packageCanvas(
    readCanvas(topic, slug).document,
    directory,
    topic,
    slug,
  );
  const names = new Set([
    "canvas.json",
    "paper.exercises.pdf",
    "exercises/state.json",
    ...readExerciseRecords(topic, slug).records.map(
      (record) => `exercises/${record.name}`,
    ),
    ...Object.values(oldCanvas.sourceNames).map(
      (name) => `canvas-assets/${name}`,
    ),
    ...artifacts.exercises.map((record) => `exercises/${record.name}`),
    ...Object.keys(artifacts.assets).map((name) => `canvas-assets/${name}`),
  ]);
  const files = [...names].map((name) => ({
    name,
    before: hashFile(targetFile(directory, topic, slug, name)),
    bytes: desiredFiles.get(name)?.toString("base64") ?? null,
  }));
  const journal = journalSchema.parse({
    tokenHash: tokenHash(connection),
    username: capability.username,
    generation: capability.generation,
    source,
    files,
  });
  // Check the baseline again under the commit guard, before recording intent.
  const initialCanvas = local.canvas;
  const initialExercises = local.exercises;
  withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
    withPaperMutation(slug, () => {
      assertCurrentConnection(topic, slug, capability, connection);
      if (
        readCanvas(topic, slug).version !== initialCanvas ||
        readExerciseRecords(topic, slug).revision !== initialExercises ||
        hashFile(exercisesPdfPath(topic, slug)) !== local.exercisePdf
      )
        throw new SharingError("Local artifacts changed while syncing.", 409);
      writeJson(journalFile, journal);
    }),
  );
  await applyJournal(topic, slug, capability, connection, journal, journalFile);
}
