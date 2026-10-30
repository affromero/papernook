import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { CanvasError } from "./errors";
export const MAX_CANVAS_ASSET_BYTES = 50 * 1024 * 1024;
export const MAX_SHARED_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_SHARED_ASSETS_BYTES = 32 * 1024 * 1024;
export const canvasAssetNameSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})\.(gif|jpe?g|mov|mp4|png|webm|webp)$/);
export const portableAssetNameSchema = z
  .string()
  .regex(/^[a-f0-9]{64}\.(gif|jpg|mov|mp4|png|webm|webp)$/);
const extensions: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export function canvasMediaType(name: string): string {
  const extension = path.extname(canvasAssetNameSchema.parse(name)).slice(1);
  const found = Object.entries(extensions).find(
    ([, value]) => value === (extension === "jpeg" ? "jpg" : extension),
  );
  if (!found) throw new CanvasError("Unsupported canvas media.", 415);
  return found[0];
}

/** Accept inert native media, never HTML, SVG or externally fetched resources. */
export function validateCanvasMedia(
  bytes: Uint8Array,
  mime: string,
  shared = false,
): string {
  if (
    !bytes.byteLength ||
    bytes.byteLength >
      (shared ? MAX_SHARED_ASSET_BYTES : MAX_CANVAS_ASSET_BYTES)
  )
    throw new CanvasError("Canvas media exceeds the upload limit.", 413);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extension = extensions[mime];
  const valid =
    extension === "png"
      ? buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : extension === "jpg"
        ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
        : extension === "gif"
          ? /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))
          : extension === "webp"
            ? buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
              buffer.subarray(8, 12).toString("ascii") === "WEBP"
            : extension === "webm"
              ? buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
              : extension === "mp4" || extension === "mov"
                ? buffer.subarray(4, 8).toString("ascii") === "ftyp"
                : false;
  if (!valid)
    throw new CanvasError(
      "Canvas media does not match its declared type.",
      415,
    );
  return `${crypto.createHash("sha256").update(bytes).digest("hex")}.${extension}`;
}
