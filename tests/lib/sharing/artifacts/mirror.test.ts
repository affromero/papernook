import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fixture, post, annotationDetails } from "../fixture";
import { imageCanvas, png } from "./fixture";

let directory: string;
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/sharing/build.mjs"], {
    stdio: "pipe",
  });
});
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-artifact-mirror-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function prepared() {
  const f = await fixture();
  const { importBundle, exportBundle } = await import("@/lib/sharing/bundle");
  const { artifactVersions, snapshotArtifacts } =
    await import("@/lib/sharing/artifacts/snapshot");
  const { installArtifacts } = await import("@/lib/sharing/artifacts/mirror");
  const imported = await importBundle(
    await exportBundle(f.share),
    "copies",
    f.capability,
    true,
  );
  const mirror = await artifactVersions("copies", imported.slug);
  const connection = {
    version: 1 as const,
    url: `https://source.test/share/nlp/attention/${f.share.id}`,
    token: f.token,
    participantId: f.participant.id,
    username: f.capability.username,
    generation: f.capability.generation,
    mirrorEtag: (await exportBundle(f.share)).etag,
    artifacts: { source: null, mirror },
  };
  f.storage.saveConnection(
    "copies",
    imported.slug,
    f.capability,
    connection,
    true,
  );
  const { name } = await (
    await post(f.share.id, f.token, "upload-canvas-asset", {
      mime: "image/png",
      bytes: png.toString("base64"),
    })
  ).json();
  const saved = await post(f.share.id, f.token, "save-canvas", {
    version: '"empty"',
    document: imageCanvas(`/canvas-assets/${name}`),
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const exercise = await post(f.share.id, f.token, "create-exercise", {
    operationId: "d".repeat(32),
    markdown: "# Practice\nExplain attention.",
  });
  expect(exercise.status, await exercise.clone().text()).toBe(200);
  const versions = await artifactVersions("nlp", "attention");
  const artifacts = await snapshotArtifacts("nlp", "attention");
  const install = () =>
    f.storage.withConnection("copies", imported.slug, f.capability, (current) =>
      installArtifacts(
        "copies",
        imported.slug,
        f.capability,
        current,
        versions,
        artifacts,
      ),
    );
  return { ...f, imported, connection, versions, artifacts, install, name };
}

it.each(["intent", "canvas", "pdf", "connection"] as const)(
  "recovers an interrupted mirror after %s without duplicating or discarding artifacts",
  async (phase) => {
    const f = await prepared();
    const companion = f.imported.companionDir;
    const pdf = f.papers.exercisesPdfPath("copies", f.imported.slug);
    const journal = path.join(
      companion,
      "collaboration",
      "artifacts-pending.json",
    );
    const failAt =
      phase === "intent"
        ? path.join(companion, "canvas.json")
        : phase === "canvas"
          ? pdf
          : phase === "pdf"
            ? path.join(companion, "exercises", "state.json")
            : path.join(companion, "collaboration", "connection.json");
    const original = fs.renameSync;
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === failAt)
        throw new Error(`Simulated failure after ${phase}`);
      return original(from, to);
    });
    await expect(f.install()).rejects.toThrow(
      `Simulated failure after ${phase}`,
    );
    fault.mockRestore();
    expect(fs.existsSync(journal)).toBe(true);
    await f.install();
    expect(fs.existsSync(journal)).toBe(false);
    const current = f.storage.readConnection("copies", f.imported.slug)!;
    expect(current.artifacts?.source).toEqual(f.versions);
    const { readCanvas } = await import("@/lib/canvas/document");
    const canvas = readCanvas("copies", f.imported.slug).document;
    expect(JSON.stringify(canvas)).toContain(
      `/api/v1/papers/copies/${f.imported.slug}/canvas/assets/${f.name}`,
    );
    expect(
      fs.readFileSync(path.join(companion, "canvas-assets", f.name)),
    ).toEqual(png);
    expect(fs.readFileSync(pdf)).toEqual(
      Buffer.from(f.artifacts.exercisePdf!.pdf, "base64"),
    );
    const { readExerciseRecords } = await import("@/lib/library/exercises");
    expect(readExerciseRecords("copies", f.imported.slug).records).toHaveLength(
      1,
    );
    expect(await annotationDetails(fs.readFileSync(pdf))).toEqual([]);
  },
);

it("preserves an external canvas edit while recovering a partial mirror", async () => {
  const f = await prepared();
  const pdf = f.papers.exercisesPdfPath("copies", f.imported.slug);
  const original = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === pdf) throw new Error("Interrupted PDF mirror");
    return original(from, to);
  });
  await expect(f.install()).rejects.toThrow("Interrupted PDF mirror");
  fault.mockRestore();
  const file = path.join(f.imported.companionDir, "canvas.json");
  fs.writeFileSync(file, '{"document":{"local":"preserve this"}}');
  await expect(f.install()).rejects.toMatchObject({ status: 409 });
  expect(fs.readFileSync(file, "utf8")).toContain("preserve this");
  expect(
    fs.existsSync(
      path.join(
        f.imported.companionDir,
        "collaboration",
        "artifacts-pending.json",
      ),
    ),
  ).toBe(true);
});

it("refuses pending recovery under a replaced connection", async () => {
  const f = await prepared();
  const original = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === path.join(f.imported.companionDir, "canvas.json"))
      throw new Error("Interrupted mirror");
    return original(from, to);
  });
  await expect(f.install()).rejects.toThrow("Interrupted mirror");
  fault.mockRestore();
  const { installArtifacts } = await import("@/lib/sharing/artifacts/mirror");
  await expect(
    installArtifacts(
      "copies",
      f.imported.slug,
      {
        username: f.capability.username,
        generation: f.capability.generation + 1,
      },
      f.connection,
      f.versions,
      f.artifacts,
    ),
  ).rejects.toThrow(/replaced/);
  expect(fs.existsSync(path.join(f.imported.companionDir, "canvas.json"))).toBe(
    false,
  );
  const token = f.storage.newSecret();
  f.storage.saveConnection(
    "copies",
    f.imported.slug,
    f.capability,
    { ...f.connection, token, participantId: f.storage.participantId(token) },
    true,
  );
  await expect(f.install()).rejects.toMatchObject({ status: 409 });
  expect(fs.existsSync(path.join(f.imported.companionDir, "canvas.json"))).toBe(
    false,
  );
});

it("erases owned pending recovery content with its profile connection", async () => {
  const f = await prepared();
  const original = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === path.join(f.imported.companionDir, "canvas.json"))
      throw new Error("Interrupted mirror");
    return original(from, to);
  });
  await expect(f.install()).rejects.toThrow("Interrupted mirror");
  fault.mockRestore();
  f.storage.eraseSharingConnections(f.capability.username);
  expect(f.storage.readConnection("copies", f.imported.slug)).toBeNull();
  expect(
    fs.existsSync(
      path.join(
        f.imported.companionDir,
        "collaboration",
        "artifacts-pending.json",
      ),
    ),
  ).toBe(false);
});
