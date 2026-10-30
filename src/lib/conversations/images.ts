import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { usersRoot } from "@/lib/data-dir";
import { assertSlug } from "@/lib/library/slug";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

export function removeAttachments(files: string[]): void {
  let failures = 0;
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      failures++;
    }
  }
  if (failures)
    console.error(
      "Conversation attachment cleanup failed. Check storage permissions and available space.",
      { failures },
    );
}

export function persistImages(
  username: string,
  id: string,
  dataUrls: string[],
): { absolute: string[]; relative: string[] } {
  assertSlug(username);
  assertSlug(id);
  let totalBytes = 0;
  const decoded: { type: string; bytes: Buffer }[] = [];
  for (const dataUrl of dataUrls) {
    const match = dataUrl.match(
      /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/,
    );
    if (!match || match[2].length % 4 !== 0)
      throw new Error("Invalid image attachment.");
    const bytes = Buffer.from(match[2], "base64");
    totalBytes += bytes.length;
    if (
      !bytes.length ||
      bytes.length > MAX_IMAGE_BYTES ||
      totalBytes > MAX_TOTAL_IMAGE_BYTES
    )
      throw new Error("Image attachments are too large.");
    if (imageMime(bytes) !== `image/${match[1]}`)
      throw new Error("Invalid image attachment.");
    decoded.push({ type: match[1], bytes });
  }
  const directory = path.join(
    usersRoot(),
    username,
    "conversations",
    id,
    "attachments",
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const absolute: string[] = [];
  const relative: string[] = [];
  try {
    for (const image of decoded) {
      const extension = image.type === "jpeg" ? "jpg" : image.type;
      const name = `${crypto.randomBytes(12).toString("hex")}.${extension}`;
      const file = path.join(directory, name);
      fs.writeFileSync(file, image.bytes, { mode: 0o600 });
      absolute.push(file);
      relative.push(`attachments/${name}`);
    }
    return { absolute, relative };
  } catch (error) {
    removeAttachments(absolute);
    throw error;
  }
}
