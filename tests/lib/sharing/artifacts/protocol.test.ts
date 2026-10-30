import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { fixture, post, annotated, annotationDetails } from "../fixture";
import { canvas, imageCanvas, png } from "./fixture";

let directory: string;
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/sharing/build.mjs"], {
    stdio: "pipe",
  });
});
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-artifact-protocol-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("shares a canonical canvas with server attribution and rejects stale or unsafe saves", async () => {
  const f = await fixture();
  const first = canvas();
  for (const record of Object.values(first.store))
    record.meta.papernookCreatedByName = "Forged owner";
  const saved = await post(f.share.id, f.token, "save-canvas", {
    version: '"empty"',
    document: first,
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const value = await saved.json();
  expect(value.document.store["shape:note"].meta).toMatchObject({
    papernookCreatedByName: "Maya Approved",
    papernookCreatedBy: `participant:${f.participant.id}`,
  });
  const second = f.storage.newSecret();
  const participant = f.storage.requestParticipant(f.share, second, "Luis");
  await f.storage.withCollaboration(f.share, async () =>
    f.storage.setParticipant(
      f.share,
      participant.id,
      "approved",
      "Luis Verified",
    ),
  );
  const changed = canvas("A correction from Luis");
  const updated = await post(f.share.id, second, "save-canvas", {
    version: value.version,
    document: changed,
  });
  expect(updated.status).toBe(200);
  const update = await updated.json();
  expect(update.document.store["shape:note"].meta).toMatchObject({
    papernookCreatedByName: "Maya Approved",
    papernookUpdatedByName: "Luis Verified",
  });
  expect(
    (
      await post(f.share.id, f.token, "save-canvas", {
        version: value.version,
        document: canvas("Old version"),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(f.share.id, f.token, "save-canvas", {
        version: update.version,
        document: imageCanvas("https://attacker.test/tracker.png"),
      })
    ).status,
  ).toBe(422);
  const current = await (await post(f.share.id, f.token, "canvas")).json();
  expect(current.version).toBe(update.version);
  expect(JSON.stringify(current.document)).toContain("A correction from Luis");
});

it("keeps media paper-scoped, checks content and restricts deletion to unused uploader assets", async () => {
  const f = await fixture();
  const uploaded = await post(f.share.id, f.token, "upload-canvas-asset", {
    mime: "image/png",
    bytes: png.toString("base64"),
  });
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  const { name } = await uploaded.json();
  const second = f.storage.newSecret();
  const participant = f.storage.requestParticipant(f.share, second, "Luis");
  await f.storage.withCollaboration(f.share, async () =>
    f.storage.setParticipant(f.share, participant.id, "approved", "Luis"),
  );
  expect(
    (await post(f.share.id, second, "delete-canvas-asset", { name })).status,
  ).toBe(403);
  const save = await post(f.share.id, f.token, "save-canvas", {
    version: '"empty"',
    document: imageCanvas(`/canvas-assets/${name}`),
  });
  expect(save.status, await save.clone().text()).toBe(200);
  expect(
    (await post(f.share.id, f.token, "delete-canvas-asset", { name })).status,
  ).toBe(409);
  const read = await (
    await post(f.share.id, second, "canvas-asset", { name })
  ).json();
  expect(Buffer.from(read.bytes, "base64")).toEqual(png);
  expect(
    (
      await post(f.share.id, f.token, "canvas-asset", {
        name: "../../identity.json",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post(f.share.id, f.token, "upload-canvas-asset", {
        mime: "image/png",
        bytes: Buffer.from("<svg onload='alert(1)' />").toString("base64"),
      })
    ).status,
  ).toBe(415);
});

it("requires approval for every artifact operation and denies all after revocation", async () => {
  const f = await fixture();
  const pending = f.storage.newSecret();
  f.storage.requestParticipant(f.share, pending, "Pending");
  const actions: [string, Record<string, unknown>][] = [
    ["artifact-versions", {}],
    ["artifacts", {}],
    ["canvas", {}],
    ["save-canvas", { version: '"empty"', document: canvas() }],
    ["canvas-asset", { name: `${"a".repeat(64)}.png` }],
    [
      "upload-canvas-asset",
      { mime: "image/png", bytes: png.toString("base64") },
    ],
    ["delete-canvas-asset", { name: `${"a".repeat(64)}.png` }],
    [
      "create-exercise",
      { operationId: "a".repeat(32), markdown: "Explain attention." },
    ],
    ["pdf", { kind: "exercises" }],
    ["version", { kind: "exercises" }],
  ];
  for (const [action, body] of actions) {
    expect((await post(f.share.id, null, action, body)).status).toBe(401);
    expect((await post(f.share.id, pending, action, body)).status).toBe(403);
  }
  await f.storage.withCollaboration(f.share, async () =>
    f.storage.setParticipant(f.share, f.participant.id, "revoked"),
  );
  for (const [action, body] of actions)
    expect((await post(f.share.id, f.token, action, body)).status).toBe(403);
  expect(
    fs.existsSync(
      path.join(f.papers.companionDir("nlp", "attention"), "canvas.json"),
    ),
  ).toBe(false);
});

it("attributes exercises, deduplicates retries and shares annotations on their PDF", async () => {
  const f = await fixture();
  const body = {
    operationId: "b".repeat(32),
    markdown: "# Practice\nExplain attention.",
  };
  const response = await post(f.share.id, f.token, "create-exercise", body);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ saved: "practice-1.md" });
  expect(
    (await post(f.share.id, f.token, "create-exercise", body)).status,
  ).toBe(200);
  const artifacts = await (await post(f.share.id, f.token, "artifacts")).json();
  expect(artifacts.artifacts.exercises).toEqual([
    expect.objectContaining({
      author: "Maya Approved",
      actorId: `participant:${f.participant.id}`,
      markdown: body.markdown,
    }),
  ]);
  const pdf = await (
    await post(f.share.id, f.token, "pdf", { kind: "exercises" })
  ).json();
  const changed = await annotated(Buffer.from(pdf.pdf, "base64"), {
    text: "An exercise note",
  });
  const saved = await post(f.share.id, f.token, "save-pdf", {
    kind: "exercises",
    etag: pdf.etag,
    pdf: Buffer.from(changed).toString("base64"),
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const canonical = await saved.json();
  expect(
    await annotationDetails(Buffer.from(canonical.pdf, "base64")),
  ).toContainEqual(
    expect.objectContaining({
      author: "Maya Approved",
      text: "An exercise note",
    }),
  );
  const append = await post(f.share.id, f.token, "create-exercise", {
    operationId: "c".repeat(32),
    markdown: "# Next\nCompare attention and recurrence.",
  });
  expect(append.status, await append.clone().text()).toBe(200);
  const final = await (
    await post(f.share.id, f.token, "pdf", { kind: "exercises" })
  ).json();
  const finalBytes = Buffer.from(final.pdf, "base64");
  expect((await PDFDocument.load(finalBytes)).getPageCount()).toBe(2);
  expect(await annotationDetails(finalBytes)).toContainEqual(
    expect.objectContaining({ text: "An exercise note" }),
  );
  expect(fs.readFileSync(f.pdf)).not.toEqual(finalBytes);
});
