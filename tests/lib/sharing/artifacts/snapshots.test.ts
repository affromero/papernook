import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fixture, post } from "../fixture";
import { canvas, imageCanvas, png } from "./fixture";
import { mockTestSession } from "../../../helpers/access";

let directory: string;
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/sharing/build.mjs"], {
    stdio: "pipe",
  });
});
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-artifact-snapshots-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock("next/headers");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("publishes only explicitly included snapshots and imports independent canvas, media and exercises", async () => {
  const f = await fixture();
  const { name } = await (
    await post(f.share.id, f.token, "upload-canvas-asset", {
      mime: "image/png",
      bytes: png.toString("base64"),
    })
  ).json();
  expect(
    (
      await post(f.share.id, f.token, "save-canvas", {
        version: '"empty"',
        document: imageCanvas(`/canvas-assets/${name}`),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post(f.share.id, f.token, "create-exercise", {
        operationId: "e".repeat(32),
        markdown: "# Shared exercise\nA saved question.",
      })
    ).status,
  ).toBe(200);
  const { exportBundle, importBundle } = await import("@/lib/sharing/bundle");
  const { snapshotArtifacts } =
    await import("@/lib/sharing/artifacts/snapshot");
  const localCanvasFile = path.join(
    f.papers.companionDir("nlp", "attention"),
    "canvas.json",
  );
  const localCanvas = JSON.parse(fs.readFileSync(localCanvasFile, "utf8"));
  localCanvas.document.store["user:local"] = {
    id: "user:local",
    typeName: "user",
    name: "PRIVATE_LOCAL_USER",
    imageUrl: "https://private.test/avatar",
    color: "black",
    meta: {},
  };
  fs.writeFileSync(localCanvasFile, JSON.stringify(localCanvas));
  expect((await exportBundle(f.share)).artifacts).toEqual({
    canvas: null,
    assets: {},
    exercises: [],
    exercisePdf: null,
  });
  const snapshot = await snapshotArtifacts("nlp", "attention");
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_LOCAL_USER");
  const share = f.shares.createShare(
    "nlp",
    "attention",
    f.capability,
    [],
    "fork",
    snapshot,
  );
  const bundle = await exportBundle(share);
  const imported = await importBundle(bundle, "forks", f.capability);
  const { readCanvas, saveCanvas } = await import("@/lib/canvas/document");
  const copied = readCanvas("forks", imported.slug);
  expect(JSON.stringify(copied.document)).toContain(
    `/api/v1/papers/forks/${imported.slug}/canvas/assets/${name}`,
  );
  expect(
    fs.readFileSync(path.join(imported.companionDir, "canvas-assets", name)),
  ).toEqual(png);
  expect(
    fs.readFileSync(f.papers.exercisesPdfPath("forks", imported.slug)),
  ).toEqual(Buffer.from(snapshot.exercisePdf!.pdf, "base64"));
  expect(
    fs.existsSync(
      path.join(imported.companionDir, "collaboration", "connection.json"),
    ),
  ).toBe(false);
  const sourceBefore = readCanvas("nlp", "attention");
  saveCanvas(
    "forks",
    imported.slug,
    copied.version,
    canvas("Fork-only change"),
  );
  expect(readCanvas("nlp", "attention")).toEqual(sourceBefore);
  saveCanvas(
    "nlp",
    "attention",
    sourceBefore.version,
    canvas("Later private canvas revision"),
  );
  expect(
    JSON.stringify((await exportBundle(share)).artifacts.canvas),
  ).not.toContain("Later private");
  expect(f.shares.deleteShare("nlp", "attention", share.id, "ana")).toBe(true);
  expect(JSON.stringify(readCanvas("forks", imported.slug).document)).toContain(
    "Fork-only change",
  );
});

it("serves anonymous read-only snapshots through share-scoped media paths and honors revocation", async () => {
  const f = await fixture();
  const { name } = await (
    await post(f.share.id, f.token, "upload-canvas-asset", {
      mime: "image/png",
      bytes: png.toString("base64"),
    })
  ).json();
  await post(f.share.id, f.token, "save-canvas", {
    version: '"empty"',
    document: imageCanvas(`/canvas-assets/${name}`),
  });
  await post(f.share.id, f.token, "create-exercise", {
    operationId: "f".repeat(32),
    markdown: "A public question.",
  });
  const { snapshotArtifacts } =
    await import("@/lib/sharing/artifacts/snapshot");
  const snapshot = await snapshotArtifacts("nlp", "attention");
  const share = f.shares.createShare(
    "nlp",
    "attention",
    f.capability,
    [],
    "view",
    snapshot,
  );
  const { GET } =
    await import("@/app/api/v1/shares/[topic]/[slug]/[shareId]/artifacts/route");
  const context = {
    params: Promise.resolve({
      topic: "nlp",
      slug: "attention",
      shareId: share.id,
    }),
  };
  const endpoint = `https://papers.test/api/v1/shares/nlp/attention/${share.id}/artifacts`;
  const response = await GET(new Request(endpoint), context);
  const value = await response.json();
  expect(value.exercises).toEqual([
    expect.objectContaining({ markdown: "A public question." }),
  ]);
  expect(JSON.stringify(value.document)).toContain(
    `/api/v1/shares/nlp/attention/${share.id}/artifacts?asset=`,
  );
  expect(JSON.stringify(value)).not.toContain("/api/v1/papers/");
  const asset = await GET(new Request(`${endpoint}?asset=${name}`), context);
  expect(Buffer.from(await asset.arrayBuffer())).toEqual(png);
  expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
  const pdf = await GET(new Request(`${endpoint}?pdf=1`), context);
  expect(Buffer.from(await pdf.arrayBuffer())).toEqual(
    Buffer.from(snapshot.exercisePdf!.pdf, "base64"),
  );
  f.shares.deleteShare("nlp", "attention", share.id, "ana");
  expect((await GET(new Request(endpoint), context)).status).toBe(404);
  expect(
    (await GET(new Request(`${endpoint}?asset=${name}`), context)).status,
  ).toBe(404);
  expect((await GET(new Request(`${endpoint}?pdf=1`), context)).status).toBe(
    404,
  );
});

it("preflights collaboration artifacts even when their public inclusion is disabled", async () => {
  const f = await fixture();
  f.shares.deleteShare("nlp", "attention", f.share.id, "ana");
  const file = path.join(
    f.papers.companionDir("nlp", "attention"),
    "canvas.json",
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ document: { unsupported: "Local-only legacy document" } }),
  );
  const before = fs.readFileSync(file);
  await mockTestSession("ana");
  const { POST } =
    await import("@/app/api/v1/papers/[topic]/[slug]/shares/route");
  const response = await POST(
    new NextRequest("https://papers.test/shares", {
      method: "POST",
      body: JSON.stringify({
        mode: "collaborate",
        chatIds: [],
        acknowledgePublicAnnotations: true,
        includeArtifacts: false,
      }),
    }),
    { params: Promise.resolve({ topic: "nlp", slug: "attention" }) },
  );
  expect(response.status).toBe(422);
  expect(f.shares.listShares("nlp", "attention", "ana")).toEqual([]);
  expect(fs.readFileSync(file)).toEqual(before);
  const { readCanvas, saveCanvas } = await import("@/lib/canvas/document");
  saveCanvas(
    "nlp",
    "attention",
    readCanvas("nlp", "attention").version,
    canvas("Repaired locally"),
  );
  expect(JSON.stringify(readCanvas("nlp", "attention").document)).toContain(
    "Repaired locally",
  );
});
