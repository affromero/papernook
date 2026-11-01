import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { previewHash } from "./source";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_PIXELS = 32_000_000;

function pngSize(
  bytes: Buffer,
  decode = false,
): { width: number; height: number } {
  if (
    bytes.length < 45 ||
    bytes.length > MAX_PREVIEW_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  )
    throw new Error("Invalid PNG snapshot.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const depth = bytes[24];
  const color = bytes[25];
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
  ]).get(color);
  const depths =
    color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
  if (
    !channels ||
    !depths.includes(depth) ||
    bytes[26] ||
    bytes[27] ||
    bytes[28]
  )
    throw new Error("Unsupported PNG snapshot format.");
  if (
    !width ||
    !height ||
    width > 4096 ||
    height > 4096 ||
    width * height > 4_000_000
  )
    throw new Error("Snapshot dimensions exceed the preview limit.");
  let offset = 8;
  let chunks = 0;
  let data = false;
  let ended = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 12 > bytes.length)
      throw new Error("Invalid PNG chunks.");
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (
      end > bytes.length ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw new Error("Invalid PNG checksum.");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (["acTL", "fcTL", "fdAT"].includes(type))
      throw new Error("Animated PNG snapshots are unsupported.");
    if (type === "IHDR" && offset !== 8) throw new Error("Invalid PNG header.");
    if (type === "IDAT") {
      data = true;
      if (decode) compressed.push(bytes.subarray(offset + 8, end - 4));
    }
    if (type === "IEND") {
      if (size || end !== bytes.length) throw new Error("Invalid PNG ending.");
      ended = true;
    }
    offset = end;
  }
  if (!data || !ended) throw new Error("Incomplete PNG snapshot.");
  if (decode) {
    const stride = 1 + Math.ceil((width * channels * depth) / 8);
    const raw = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: stride * height,
    });
    if (raw.length !== stride * height)
      throw new Error("Invalid PNG pixel data.");
    for (let row = 0; row < height; row++)
      if (raw[row * stride] > 4) throw new Error("Invalid PNG row filter.");
  }
  return { width, height };
}
export function previewBytes(data: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (
    !match ||
    match[1].length % 4 ||
    match[1].length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4
  )
    throw new Error("Invalid PNG snapshot encoding.");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.toString("base64") !== match[1])
    throw new Error("Invalid PNG snapshot encoding.");
  pngSize(bytes, true);
  return bytes;
}

/** The caller holds the profile lease and conversation lock through quota and rename. */
export function savePreview(base: string, hash: string, bytes: Buffer): void {
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Invalid preview identity.");
  const image = pngSize(bytes);
  const directory = path.join(base, "previews");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let total = 0;
  let count = 0;
  let pixels = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^[a-f0-9]{64}\.png\.[a-f0-9-]{36}\.tmp$/.test(entry.name)
    ) {
      fs.unlinkSync(path.join(directory, entry.name));
      continue;
    }
    if (!entry.isFile() || !/^[a-f0-9]{64}\.png$/.test(entry.name))
      throw new Error("Unexpected preview cache entry.");
    if (entry.name === `${hash}.png`) continue;
    const file = path.join(directory, entry.name);
    const size = fs.statSync(file).size;
    if (size > MAX_PREVIEW_BYTES)
      throw new Error("Invalid saved preview size.");
    const previous = pngSize(fs.readFileSync(file));
    total += size;
    pixels += previous.width * previous.height;
    count++;
  }
  if (
    count >= 64 ||
    total + bytes.length > MAX_CACHE_BYTES ||
    pixels + image.width * image.height > MAX_CACHE_PIXELS
  )
    throw new Error("Saved previews exceed the conversation cache limit.");
  const file = path.join(directory, `${hash}.png`);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readPreview(
  base: string,
  kind: string,
  source: string,
): Buffer | null {
  const file = path.join(base, "previews", `${previewHash(kind, source)}.png`);
  if (!fs.existsSync(file)) return null;
  if (
    !fs.lstatSync(file).isFile() ||
    fs.statSync(file).size > MAX_PREVIEW_BYTES
  )
    throw new Error("Invalid saved preview.");
  const bytes = fs.readFileSync(file);
  pngSize(bytes);
  return bytes;
}
