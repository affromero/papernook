import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFDict,
  PDFArray,
  PDFNumber,
} from "pdf-lib";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fixture, annotationDetails, annotated } from "../fixture";

let directory: string;
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/sharing/build.mjs"], {
    stdio: "pipe",
  });
});
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-exercise-sharing-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("rejects a collection overflow before changing the journal, markdown or PDF", async () => {
  const f = await fixture();
  const { commitExerciseOperation, readExerciseRecords } =
    await import("@/lib/library/exercises");
  for (let number = 0; number < 20; number++) {
    commitExerciseOperation(
      "nlp",
      "attention",
      {
        operationId: number.toString(16).padStart(32, "0"),
        markdown: "x".repeat(100_000),
        actorId: "profile:ana",
        author: "Ana",
        createdAt: new Date().toISOString(),
      },
      readExerciseRecords("nlp", "attention").revision,
    );
  }
  const current = readExerciseRecords("nlp", "attention");
  const state = path.join(
    f.papers.companionDir("nlp", "attention"),
    "exercises",
    "state.json",
  );
  const before = fs.readFileSync(state);
  expect(() =>
    commitExerciseOperation(
      "nlp",
      "attention",
      {
        operationId: "f".repeat(32),
        markdown: "y".repeat(100_000),
        actorId: "participant:1111111111111111",
        author: "Maya",
        createdAt: new Date().toISOString(),
      },
      current.revision,
    ),
  ).toThrow(/sharing limit/);
  expect(readExerciseRecords("nlp", "attention")).toEqual(current);
  expect(fs.readFileSync(state)).toEqual(before);
  expect(fs.existsSync(f.papers.exercisesPdfPath("nlp", "attention"))).toBe(
    false,
  );
});

it("recovers a committed PDF after contributor revocation with its original attribution and no duplicate pages", async () => {
  const f = await fixture();
  const { createSourceExercise, recoverSourceExercises } =
    await import("@/lib/sharing/artifacts/source");
  const { readExerciseRecords } = await import("@/lib/library/exercises");
  const { withShareFiles } = await import("@/lib/library/shares");
  const actor = {
    id: `participant:${f.participant.id}`,
    name: "Maya Approved",
  };
  const stateFile = path.join(
    f.papers.companionDir("nlp", "attention"),
    "exercises",
    "state.json",
  );
  const original = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (
      String(to) === stateFile &&
      JSON.parse(fs.readFileSync(from, "utf8")).entries.some(
        (entry: { status: string }) => entry.status === "complete",
      )
    )
      throw new Error("Completion metadata unavailable");
    return original(from, to);
  });
  await expect(
    createSourceExercise(
      "nlp",
      "attention",
      "# Practice\nExplain attention.",
      "9".repeat(32),
      actor,
      (operation) => withShareFiles(f.share, operation),
    ),
  ).rejects.toThrow("Completion metadata unavailable");
  fault.mockRestore();
  const pdfFile = f.papers.exercisesPdfPath("nlp", "attention");
  const committed = fs.readFileSync(pdfFile);
  expect(readExerciseRecords("nlp", "attention").pending).toBe(true);
  await f.storage.withCollaboration(f.share, async () =>
    f.storage.setParticipant(f.share, f.participant.id, "revoked"),
  );
  await recoverSourceExercises("nlp", "attention", (operation) =>
    withShareFiles(f.share, operation),
  );
  expect(fs.readFileSync(pdfFile)).toEqual(committed);
  expect((await PDFDocument.load(committed)).getPageCount()).toBe(1);
  expect(readExerciseRecords("nlp", "attention")).toMatchObject({
    pending: false,
    records: [
      expect.objectContaining({ author: "Maya Approved", actorId: actor.id }),
    ],
  });
});

it("preserves a PDF changed after the worker read and leaves no-op recovery pending", async () => {
  const f = await fixture();
  const { renderSharedExercises } = await import("@/lib/sharing/sandbox");
  const { commitExerciseOperation, readExerciseRecords } =
    await import("@/lib/library/exercises");
  const { recoverSourceExercises } =
    await import("@/lib/sharing/artifacts/source");
  const { withShareFiles } = await import("@/lib/library/shares");
  const entry = {
    operationId: "8".repeat(32),
    markdown: "A pending question.",
    actorId: `participant:${f.participant.id}`,
    author: "Maya Approved",
    createdAt: new Date().toISOString(),
  };
  const acceptedPdf = await renderSharedExercises(null, "Practice", [
    { operationId: entry.operationId, markdown: entry.markdown },
  ]);
  const file = f.papers.exercisesPdfPath("nlp", "attention");
  fs.writeFileSync(file, acceptedPdf);
  expect(() =>
    commitExerciseOperation(
      "nlp",
      "attention",
      entry,
      readExerciseRecords("nlp", "attention").revision,
      () => {
        throw new Error("Interrupted completion");
      },
    ),
  ).toThrow("Interrupted completion");
  const replacement = fs.readFileSync(f.pdf);
  await expect(
    recoverSourceExercises("nlp", "attention", (operation) =>
      withShareFiles(f.share, () => {
        fs.writeFileSync(file, replacement);
        operation();
      }),
    ),
  ).rejects.toThrow(/final commit/);
  expect(fs.readFileSync(file)).toEqual(replacement);
  expect(readExerciseRecords("nlp", "attention").pending).toBe(true);
});

it("appends exercises while preserving existing Pencil ink and page coordinates", async () => {
  const { renderSharedExercises } = await import("@/lib/sharing/sandbox");
  const first = await renderSharedExercises(null, "A paper", [
    {
      operationId: "1".repeat(32),
      markdown: "# First practice\nExplain attention.",
    },
  ]);
  const original = await PDFDocument.load(first);
  original.getPage(0).node.addAnnot(
    original.context.register(
      original.context.obj({
        Type: "Annot",
        Subtype: "Ink",
        Rect: [10, 20, 100, 80],
        InkList: [[10, 20, 30, 40, 60, 70]],
        NM: PDFString.of("existing-pencil-ink"),
        T: PDFString.of("Ana"),
        PapernookAuthor: PDFString.of("profile:ana"),
      }),
    ),
  );
  const inked = await original.save();
  const nextEntry = {
    operationId: "2".repeat(32),
    markdown: "# Second practice\nDerive the loss.",
  };
  const appended = await renderSharedExercises(inked, "A paper", [nextEntry]);
  const result = await PDFDocument.load(appended);
  expect(result.getPageCount()).toBe(2);
  expect(result.getPage(0).getMediaBox()).toEqual(
    original.getPage(0).getMediaBox(),
  );
  expect(await annotationDetails(appended)).toContainEqual(
    expect.objectContaining({
      type: "/Ink",
      author: "Ana",
      actor: "profile:ana",
      name: "existing-pencil-ink",
    }),
  );
  const stroke = result.context.lookup(
    result.getPage(0).node.Annots()!.get(0),
    PDFDict,
  );
  const ink = stroke
    .lookup(PDFName.of("InkList"), PDFArray)
    .lookup(0, PDFArray);
  expect(
    ink
      .asArray()
      .map((value) => result.context.lookup(value, PDFNumber).asNumber()),
  ).toEqual([10, 20, 30, 40, 60, 70]);
  expect(await renderSharedExercises(appended, "A paper", [nextEntry])).toEqual(
    appended,
  );
});

it("refuses to append to signed exercise PDFs", async () => {
  const { renderSharedExercises } = await import("@/lib/sharing/sandbox");
  const document = await PDFDocument.create();
  document.addPage();
  document.catalog.set(
    PDFName.of("Sig"),
    document.context.register(
      document.context.obj({ Type: "Sig", ByteRange: [0, 1, 2, 3] }),
    ),
  );
  await expect(
    renderSharedExercises(await document.save(), "Signed", [
      { operationId: "3".repeat(32), markdown: "A new question" },
    ]),
  ).rejects.toThrow(/Signed/);
});

it("recovers an interrupted exercise commit without creating duplicates", async () => {
  const f = await fixture();
  const exercises = await import("@/lib/library/exercises");
  const input = {
    operationId: "4".repeat(32),
    markdown: "# Practice\nA question",
    actorId: "participant:1111111111111111",
    author: "Maya",
    createdAt: new Date().toISOString(),
  };
  const prepared = path.join(directory, "prepared.pdf");
  const target = f.papers.exercisesPdfPath("nlp", "attention");
  expect(() =>
    exercises.commitExerciseOperation(
      "nlp",
      "attention",
      input,
      exercises.readExerciseRecords("nlp", "attention").revision,
      () => fs.renameSync(prepared, target),
    ),
  ).toThrow();
  expect(
    exercises.findExerciseOperation("nlp", "attention", input.operationId)
      ?.status,
  ).toBe("pending");
  fs.writeFileSync(prepared, fs.readFileSync(f.pdf));
  const name = exercises.commitExerciseOperation(
    "nlp",
    "attention",
    input,
    exercises.readExerciseRecords("nlp", "attention").revision,
    () => fs.renameSync(prepared, target),
  );
  expect(name).toBe("practice-1.md");
  const state = exercises.readExerciseRecords("nlp", "attention");
  expect(state.pending).toBe(false);
  expect(state.records).toEqual([
    expect.objectContaining({ author: "Maya", markdown: input.markdown }),
  ]);
  expect(
    exercises.commitExerciseOperation(
      "nlp",
      "attention",
      input,
      state.revision,
    ),
  ).toBe(name);
  expect(exercises.listExercises("nlp", "attention")).toEqual([name]);
  expect(() =>
    exercises.commitExerciseOperation(
      "nlp",
      "attention",
      { ...input, markdown: "different content" },
      state.revision,
    ),
  ).toThrow(/different content/);
});

it("allocates exercise names without overwriting an existing file after a deletion", async () => {
  const f = await fixture();
  const { saveExercise } = await import("@/lib/library/exercises");
  saveExercise("nlp", "attention", "First");
  saveExercise("nlp", "attention", "Keep this question");
  const folder = path.join(
    f.papers.companionDir("nlp", "attention"),
    "exercises",
  );
  fs.unlinkSync(path.join(folder, "practice-1.md"));
  saveExercise("nlp", "attention", "New practice");
  expect(fs.readFileSync(path.join(folder, "practice-2.md"), "utf8")).toBe(
    "Keep this question",
  );
  expect(fs.readFileSync(path.join(folder, "practice-1.md"), "utf8")).toBe(
    "New practice",
  );
});

it("versions the exercise PDF independently and protects the final commit from a WebDAV write", async () => {
  const f = await fixture();
  const { replacePdf, readVersionedPdf, pdfEtag } =
    await import("@/lib/library/pdf/file");
  const primary = fs.readFileSync(f.pdf);
  const created = await replacePdf(
    "nlp",
    "attention",
    null,
    primary,
    undefined,
    "exercises",
  );
  expect((await readVersionedPdf("nlp", "attention", "exercises"))?.etag).toBe(
    created.etag,
  );
  const external = await annotated(primary, { text: "A concurrent iPad note" });
  const proposal = await annotated(primary, { text: "Proposed replacement" });
  await expect(
    replacePdf("nlp", "attention", pdfEtag(primary), proposal, (commit) => {
      fs.writeFileSync(f.pdf, external);
      commit();
    }),
  ).rejects.toThrow(/final commit/);
  expect(fs.readFileSync(f.pdf)).toEqual(Buffer.from(external));
  expect(
    (await readVersionedPdf("nlp", "attention", "exercises"))?.bytes,
  ).toEqual(new Uint8Array(primary));
});
