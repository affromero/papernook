import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { syncDirectory } from "thesidedoor-core/storage";
import {
  companionDir,
  exercisesPdfPath,
  getPaper,
  withPaperMutation,
} from "./papers";
import { renderExerciseDocument } from "./exercises/render";

import {
  exerciseMarkdownSchema,
  exerciseNameSchema,
  exerciseOperationSchema,
  exerciseRecordSchema,
  type ExerciseRecord,
  ExerciseError,
} from "./exercises/schema";
const metadataSchema = exerciseRecordSchema.omit({ markdown: true }).extend({
  markdownHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pending", "complete"]),
  pendingMarkdown: exerciseMarkdownSchema.optional(),
});
const stateSchema = z
  .object({ version: z.literal(1), entries: z.array(metadataSchema).max(100) })
  .strict();

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function metadataFor(record: ExerciseRecord, status: "pending" | "complete") {
  const { markdown, ...fields } = record;
  return metadataSchema.parse({
    ...fields,
    markdownHash: digest(markdown),
    status,
    ...(status === "pending" ? { pendingMarkdown: markdown } : {}),
  });
}
function readState(directory: string): z.infer<typeof stateSchema> {
  const file = path.join(directory, "state.json");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new ExerciseError(
        "Exercise metadata is invalid or too large.",
        413,
      );
    return stateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { version: 1, entries: [] };
    throw error;
  }
}
function writeAtomic(file: string, raw: string): void {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, raw, { flag: "wx", mode: 0o600, flush: true });
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function nextName(directory: string): string {
  for (let number = 1; number <= 1_000_000; number++) {
    const name = `practice-${number}.md`;
    if (!fs.existsSync(path.join(directory, name))) return name;
  }
  throw new ExerciseError("The exercise directory is full.", 413);
}

export function saveExercise(
  topic: string,
  slug: string,
  markdown: string,
): string {
  const content = exerciseMarkdownSchema.parse(markdown);
  return withPaperMutation(slug, () => {
    if (!getPaper(topic, slug)) throw new ExerciseError("Unknown paper.", 404);
    const directory = path.join(companionDir(topic, slug), "exercises");
    fs.mkdirSync(directory, { recursive: true });
    const name = nextName(directory);
    writeAtomic(path.join(directory, name), content);
    return name;
  });
}

export function listExercises(topic: string, slug: string): string[] {
  const directory = path.join(companionDir(topic, slug), "exercises");
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

export function readExerciseRecords(
  topic: string,
  slug: string,
): { records: ExerciseRecord[]; revision: string; pending: boolean } {
  const directory = path.join(companionDir(topic, slug), "exercises");
  const names = listExercises(topic, slug);
  if (names.length > 100)
    throw new ExerciseError(
      "The paper exceeds the 100-exercise sharing limit.",
      413,
    );
  const state = readState(directory);
  let total = 0;
  const records = names.map((name) => {
    exerciseNameSchema.parse(name);
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 400_000)
      throw new ExerciseError("An exercise is invalid or too large.", 413);
    const markdown = exerciseMarkdownSchema.parse(
      fs.readFileSync(file, "utf8"),
    );
    total += Buffer.byteLength(markdown);
    const metadata = state.entries.find((entry) => entry.name === name);
    return exerciseRecordSchema.parse({
      name,
      markdown,
      operationId: metadata?.operationId ?? digest(name),
      actorId: metadata?.actorId ?? "legacy",
      author: metadata?.author ?? "Library",
      createdAt: metadata?.createdAt ?? stat.mtime.toISOString(),
    });
  });
  if (total > 2 * 1024 * 1024)
    throw new ExerciseError("Exercises exceed the 2 MB sharing limit.", 413);
  const pending = state.entries.some((entry) => entry.status === "pending");
  return {
    records,
    pending,
    revision: `"${digest(JSON.stringify({ records, pending }))}"`,
  };
}

export function findExerciseOperation(
  topic: string,
  slug: string,
  operationId: string,
) {
  exerciseOperationSchema.parse(operationId);
  return (
    readState(path.join(companionDir(topic, slug), "exercises")).entries.find(
      (entry) => entry.operationId === operationId,
    ) ?? null
  );
}

/** The pending record makes retries recoverable even if the PDF rename committed first. */
export function commitExerciseOperation(
  topic: string,
  slug: string,
  input: Omit<ExerciseRecord, "name">,
  expectedRevision: string,
  commitPdf?: () => void,
): string {
  const value = exerciseRecordSchema.omit({ name: true }).parse(input);
  return withPaperMutation(slug, () => {
    if (!getPaper(topic, slug)) throw new ExerciseError("Unknown paper.", 404);
    const directory = path.join(companionDir(topic, slug), "exercises");
    fs.mkdirSync(directory, { recursive: true });
    const state = readState(directory);
    const existing = state.entries.find(
      (entry) => entry.operationId === value.operationId,
    );
    if (
      state.entries.some(
        (entry) =>
          entry.status === "pending" && entry.operationId !== value.operationId,
      )
    )
      throw new ExerciseError(
        "Recover the incomplete exercise save before adding another.",
        409,
      );
    if (
      existing &&
      (existing.actorId !== value.actorId ||
        existing.markdownHash !== digest(value.markdown))
    )
      throw new ExerciseError(
        "This exercise operation was already used for different content.",
        409,
      );
    const current = readExerciseRecords(topic, slug);
    if (current.revision !== expectedRevision)
      throw new ExerciseError(
        "Exercises changed while saving. Reload before trying again.",
        409,
      );
    const name = existing?.name ?? nextName(directory);
    const prospectiveBytes =
      current.records.reduce(
        (total, record) =>
          total +
          (record.name === name ? 0 : Buffer.byteLength(record.markdown)),
        0,
      ) + Buffer.byteLength(value.markdown);
    if (
      prospectiveBytes > 2 * 1024 * 1024 ||
      (!existing && state.entries.length >= 100)
    )
      throw new ExerciseError(
        "The paper has reached its exercise sharing limit.",
        413,
      );
    const file = path.join(directory, name);
    if (
      fs.existsSync(file) &&
      digest(fs.readFileSync(file, "utf8")) !== digest(value.markdown)
    )
      throw new ExerciseError(
        "The exercise changed outside this operation.",
        409,
      );
    if (existing?.status === "complete") return name;
    if (!existing && listExercises(topic, slug).length >= 100)
      throw new ExerciseError(
        "This paper has reached its exercise limit.",
        413,
      );
    const entry = metadataFor(
      {
        ...value,
        name,
        author: existing?.author ?? value.author,
        createdAt: existing?.createdAt ?? value.createdAt,
      },
      "pending",
    );
    const entries = state.entries.filter(
      (previous) => previous.operationId !== value.operationId,
    );
    writeAtomic(
      path.join(directory, "state.json"),
      JSON.stringify({ version: 1, entries: [...entries, entry] }),
    );
    if (!fs.existsSync(file)) writeAtomic(file, value.markdown);
    commitPdf?.();
    writeAtomic(
      path.join(directory, "state.json"),
      JSON.stringify({
        version: 1,
        entries: [
          ...entries,
          metadataFor(
            {
              ...value,
              name,
              author: entry.author,
              createdAt: entry.createdAt,
            },
            "complete",
          ),
        ],
      }),
    );
    return name;
  });
}

/** Persisted intent contains the accepted content needed after a process crash. */
export function pendingExerciseOperations(
  topic: string,
  slug: string,
): Omit<ExerciseRecord, "name">[] {
  const directory = path.join(companionDir(topic, slug), "exercises");
  return readState(directory)
    .entries.filter((entry) => entry.status === "pending")
    .map((entry) => {
      const markdown =
        entry.pendingMarkdown ??
        fs.readFileSync(path.join(directory, entry.name), "utf8");
      if (digest(markdown) !== entry.markdownHash)
        throw new ExerciseError(
          "The pending exercise content changed. Preserve it before repairing the journal.",
          409,
        );
      return exerciseRecordSchema.omit({ name: true }).parse({
        markdown,
        operationId: entry.operationId,
        actorId: entry.actorId,
        author: entry.author,
        createdAt: entry.createdAt,
      });
    });
}

/** Import only explicit exercise records, without source permissions or journals. */
export function exerciseSnapshotFiles(
  records: ExerciseRecord[],
): Record<string, string> {
  if (!records.length) return {};
  if (
    records.length > 100 ||
    new Set(records.map((record) => record.name)).size !== records.length
  )
    throw new ExerciseError("Invalid exercise collection.");
  const files: Record<string, string> = {};
  const entries = records.map((record) => {
    const parsed = exerciseRecordSchema.parse(record);
    files[`exercises/${parsed.name}`] = parsed.markdown;
    return metadataFor(parsed, "complete");
  });
  files["exercises/state.json"] = JSON.stringify({ version: 1, entries });
  return files;
}

/** Existing local callers use the same pure renderer as isolated collaboration jobs. */
export async function renderExercisesPdf(
  topic: string,
  slug: string,
  title: string,
): Promise<string | null> {
  const current = readExerciseRecords(topic, slug);
  if (!current.records.length) return null;
  const bytes = await renderExerciseDocument(
    title,
    current.records.map((record) => ({
      operationId: record.operationId,
      markdown: record.markdown,
    })),
  );
  const out = exercisesPdfPath(topic, slug);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temp = `${out}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600, flush: true });
    fs.renameSync(temp, out);
    syncDirectory(path.dirname(out));
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return out;
}
