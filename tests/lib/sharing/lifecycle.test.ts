import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixture, annotated } from "./fixture";
import {
  createTestProfile,
  revokeTestProfile,
  testProfileCapability,
} from "../../helpers/access";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-sharing-life-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function binding() {
  const f = await fixture();
  const connection = {
    version: 1 as const,
    url: `https://example.org/share/nlp/attention/${f.share.id}`,
    token: f.token,
    participantId: f.participant.id,
    username: "ana",
    generation: f.capability.generation,
    mirrorEtag: (await import("@/lib/library/pdf/file")).pdfEtag(
      fs.readFileSync(f.pdf),
    ),
  };
  f.storage.saveConnection("nlp", "attention", f.capability, connection, true);
  return { ...f, connection };
}

it("refuses to use another local profile's remote editing credential", async () => {
  const f = await binding();
  await createTestProfile("Bea");
  let accessed = false;
  await expect(
    f.storage.withConnection(
      "nlp",
      "attention",
      testProfileCapability("bea"),
      async () => {
        accessed = true;
      },
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(accessed).toBe(false);
});

it("preserves unrecognized WebDAV changes instead of uploading or overwriting them", async () => {
  const f = await binding();
  const original = fs.readFileSync(f.pdf);
  const local = await annotated(original, {
    text: "An unidentified local edit",
  });
  fs.writeFileSync(f.pdf, local);
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(f.pdf, old, old);
  const { updateMirror } = await import("@/lib/sharing/gateway");
  await expect(
    updateMirror(
      "nlp",
      "attention",
      f.connection,
      original,
      f.connection.mirrorEtag,
      f.capability,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(fs.readFileSync(f.pdf)).toEqual(Buffer.from(local));
});

it("rejects revoked profile capabilities before writing a remote mirror", async () => {
  const f = await binding();
  const original = fs.readFileSync(f.pdf);
  const next = await annotated(original);
  await revokeTestProfile("ana");
  const { updateMirror } = await import("@/lib/sharing/gateway");
  const { pdfEtag } = await import("@/lib/library/pdf/file");
  await expect(
    updateMirror(
      "nlp",
      "attention",
      f.connection,
      next,
      pdfEtag(next),
      f.capability,
    ),
  ).rejects.toBeInstanceOf(Error);
  expect(fs.readFileSync(f.pdf)).toEqual(original);
});

it("does not recreate a connection after its paper was removed", async () => {
  const f = await binding();
  fs.rmSync(f.papers.companionDir("nlp", "attention"), { recursive: true });
  expect(() =>
    f.storage.saveConnection("nlp", "attention", f.capability, f.connection),
  ).toThrow();
  expect(
    fs.existsSync(
      path.join(
        f.papers.companionDir("nlp", "attention"),
        "collaboration",
        "connection.json",
      ),
    ),
  ).toBe(false);
});

it("validates hashes and complete PDF markers before any mirror update", async () => {
  const f = await binding();
  const { updateMirror } = await import("@/lib/sharing/gateway");
  const original = fs.readFileSync(f.pdf);
  await expect(
    updateMirror(
      "nlp",
      "attention",
      f.connection,
      Buffer.from("bad input"),
      f.connection.mirrorEtag,
      f.capability,
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(fs.readFileSync(f.pdf)).toEqual(original);
});

it("fails closed on a damaged collaboration binding", async () => {
  const f = await binding();
  fs.writeFileSync(
    path.join(
      f.papers.companionDir("nlp", "attention"),
      "collaboration",
      "connection.json",
    ),
    `{"token":"${f.token}`,
  );
  expect(() => f.storage.readConnection("nlp", "attention")).toThrow(/binding/);
  try {
    f.storage.readConnection("nlp", "attention");
  } catch (error) {
    expect(error instanceof Error ? error.message : "").not.toContain(f.token);
  }
});
