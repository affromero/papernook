import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { usersRoot } from "@/lib/data-dir";
import { assertSlug } from "@/lib/library/slug";
import { fetchPublicUrl } from "@/lib/capture/download";
import { readBoundedResponse } from "@/lib/capture/bounded-response";
import { persistImages } from "./images";
import type { ConversationAsset } from "./content";

export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export function conversationDirectory(owner: string, id: string): string {
  assertSlug(owner);
  assertSlug(id);
  return path.join(usersRoot(), owner, "conversations", id);
}
export function assetPath(
  base: string,
  message: number,
  index: number,
  asset: ConversationAsset,
): string {
  if (
    !Number.isSafeInteger(message) ||
    message < 0 ||
    !Number.isSafeInteger(index) ||
    index < 0
  )
    throw new Error("Invalid attachment identifier.");
  const identity = crypto
    .createHash("sha256")
    .update(JSON.stringify(asset))
    .digest("hex")
    .slice(0, 24);
  return path.join(base, "assets", `${message}-${index}-${identity}.bin`);
}
export function assetMime(asset: ConversationAsset): string {
  const mime = asset.data?.match(/^data:([^;]+);/)?.[1] ?? asset.mime ?? "";
  if (
    asset.kind === "image" &&
    /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(mime)
  )
    return mime;
  if (
    asset.kind === "audio" &&
    /^audio\/(mpeg|mp3|wav|x-wav|ogg|webm|mp4|flac)$/.test(mime)
  )
    return mime;
  if (asset.kind === "video" && /^video\/(mp4|webm|ogg|quicktime)$/.test(mime))
    return mime;
  return "application/octet-stream";
}
export function embeddedAsset(asset: ConversationAsset): Buffer | null {
  if (!asset.data) return null;
  const base64 = asset.data.slice(asset.data.indexOf(",") + 1);
  if (base64.length % 4 !== 0) throw new Error("Invalid embedded attachment.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_ASSET_BYTES)
    throw new Error("Attachment exceeds the 20 MB limit.");
  return bytes;
}
export async function downloadAsset(
  asset: ConversationAsset,
): Promise<{ bytes: Buffer; mime: string }> {
  const embedded = embeddedAsset(asset);
  if (embedded) return { bytes: embedded, mime: assetMime(asset) };
  if (!asset.url)
    throw new Error(
      "The provider did not expose this attachment. Open the original share or import an export containing its data.",
    );
  const fetched = await fetchPublicUrl(asset.url);
  if (!fetched.response.ok) {
    await fetched.response.body?.cancel();
    await fetched.close();
    throw new Error(
      `Attachment provider returned HTTP ${fetched.response.status}.`,
    );
  }
  const mime =
    fetched.response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  return {
    bytes: await readBoundedResponse(
      fetched.response,
      MAX_ASSET_BYTES,
      fetched.close,
    ),
    mime: assetMime({ ...asset, mime }),
  };
}
export function saveAsset(
  owner: string,
  id: string,
  message: number,
  index: number,
  asset: ConversationAsset,
  bytes: Buffer,
  mime: string,
): void {
  const base = conversationDirectory(owner, id);
  const file = assetPath(base, message, index, asset);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const size = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".bin"))
    .reduce((total, name) => total + fs.statSync(path.join(dir, name)).size, 0);
  if (size + bytes.length > 32 * 1024 * 1024)
    throw new Error("Saved conversation attachments exceed the 32 MB limit.");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    if (asset.kind === "image" && mime !== "image/svg+xml") {
      const images = persistImages(owner, id, [
        `data:${mime};base64,${bytes.toString("base64")}`,
      ]);
      fs.renameSync(images.absolute[0], temp);
    } else fs.writeFileSync(temp, bytes, { mode: 0o600 });
    fs.renameSync(temp, file);
    fs.writeFileSync(`${file}.mime`, mime, { mode: 0o600 });
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function readAsset(
  base: string,
  message: number,
  index: number,
  asset: ConversationAsset,
  embedded = false,
): { bytes: Buffer; mime: string } | null {
  const file = assetPath(base, message, index, asset);
  if (!fs.existsSync(file)) {
    const bytes = embedded ? embeddedAsset(asset) : null;
    return bytes ? { bytes, mime: assetMime(asset) } : null;
  }
  if (fs.statSync(file).size > MAX_ASSET_BYTES)
    throw new Error("Attachment exceeds the 20 MB limit.");
  const mime = fs.existsSync(`${file}.mime`)
    ? fs.readFileSync(`${file}.mime`, "utf8")
    : assetMime(asset);
  return {
    bytes: fs.readFileSync(file),
    mime: assetMime({ ...asset, data: undefined, mime }),
  };
}
