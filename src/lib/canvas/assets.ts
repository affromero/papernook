import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { syncDirectory } from "thesidedoor-core/storage";
import { getPaper, withPaperMutation } from "../library/papers";
import { readCanvasFile } from "./document";
import { CanvasError } from "./errors";

import {
  MAX_CANVAS_ASSET_BYTES,
  MAX_SHARED_ASSET_BYTES,
  canvasAssetNameSchema,
  canvasMediaType,
  validateCanvasMedia,
} from "./media";

export function readCanvasAsset(
  directory: string,
  name: string,
  shared = false,
) {
  const parsed = canvasAssetNameSchema.safeParse(name);
  if (!parsed.success) throw new CanvasError("Unknown canvas asset.", 404);
  const file = path.join(directory, "canvas-assets", parsed.data);
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.size > (shared ? MAX_SHARED_ASSET_BYTES : MAX_CANVAS_ASSET_BYTES)
  )
    throw new CanvasError("Canvas asset is unavailable or too large.", 413);
  const bytes = fs.readFileSync(file);
  const mime = canvasMediaType(name);
  const portableName = validateCanvasMedia(bytes, mime, shared);
  if (
    /^[a-f0-9]{64}\./.test(name) &&
    name.replace(/\.jpeg$/, ".jpg") !== portableName
  )
    throw new CanvasError(
      "Canvas asset content does not match its address.",
      422,
    );
  return { bytes, mime, name: portableName };
}

function assetDirectory(topic: string, slug: string): string {
  const paper = getPaper(topic, slug);
  if (!paper) throw new CanvasError("Unknown paper.", 404);
  return path.join(paper.companionDir, "canvas-assets");
}

function writeOwnership(
  directory: string,
  owners: Record<string, string>,
): void {
  const file = path.join(directory, "ownership.json");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(owners), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function storeCanvasAsset(
  topic: string,
  slug: string,
  bytes: Uint8Array,
  mime: string,
  actorId: string,
  shared = false,
): string {
  const name = validateCanvasMedia(bytes, mime, shared);
  return withPaperMutation(slug, () => {
    const directory = assetDirectory(topic, slug);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) {
      if (shared) {
        let total = 0;
        let count = 0;
        for (const entry of fs.readdirSync(directory)) {
          if (!canvasAssetNameSchema.safeParse(entry).success) continue;
          const stat = fs.lstatSync(path.join(directory, entry));
          if (!stat.isFile())
            throw new CanvasError("Canvas asset storage is invalid.", 503);
          total += stat.size;
          count++;
        }
        if (count >= 512 || total + bytes.byteLength > 64 * 1024 * 1024)
          throw new CanvasError(
            "The canvas asset store is full. Remove unused uploads before adding more.",
            413,
          );
      }
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600, flush: true });
        fs.renameSync(temp, file);
        const ownership = path.join(directory, "ownership.json");
        const owners = fs.existsSync(ownership)
          ? z
              .record(canvasAssetNameSchema, z.string().max(100))
              .parse(JSON.parse(fs.readFileSync(ownership, "utf8")))
          : {};
        writeOwnership(
          directory,
          Object.fromEntries(
            Object.entries({ ...owners, [name]: actorId }).filter(([asset]) =>
              fs.existsSync(path.join(directory, asset)),
            ),
          ),
        );
        syncDirectory(directory);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    } else {
      const paper = getPaper(topic, slug);
      if (!paper) throw new CanvasError("Unknown paper.", 404);
      readCanvasAsset(paper.companionDir, name, shared);
    }
    return name;
  });
}

export function removeCanvasAsset(
  topic: string,
  slug: string,
  name: string,
  actorId?: string,
): void {
  canvasAssetNameSchema.parse(name);
  withPaperMutation(slug, () => {
    const directory = assetDirectory(topic, slug);
    if (!fs.existsSync(path.join(directory, name))) return;
    const canvas = readCanvasFile(path.join(directory, "..", "canvas.json"));
    const pending: unknown[] = [canvas.document];
    while (pending.length) {
      const value = pending.pop();
      if (
        typeof value === "string" &&
        (value.endsWith(`/canvas/assets/${name}`) ||
          value === `/canvas-assets/${name}`)
      )
        throw new CanvasError(
          "This asset is still referenced by the canvas.",
          409,
        );
      if (value && typeof value === "object")
        pending.push(...Object.values(value));
    }
    const ownership = path.join(directory, "ownership.json");
    if (actorId) {
      const owners = fs.existsSync(ownership)
        ? z
            .record(canvasAssetNameSchema, z.string().max(100))
            .parse(JSON.parse(fs.readFileSync(ownership, "utf8")))
        : {};
      if (owners[name] !== actorId)
        throw new CanvasError(
          "Only the uploader can remove this unused asset.",
          403,
        );
    }
    fs.rmSync(path.join(directory, name), { force: true });
    if (fs.existsSync(ownership)) {
      const owners = z
        .record(canvasAssetNameSchema, z.string().max(100))
        .parse(JSON.parse(fs.readFileSync(ownership, "utf8")));
      delete owners[name];
      writeOwnership(directory, owners);
    }
    if (fs.existsSync(directory)) syncDirectory(directory);
  });
}
