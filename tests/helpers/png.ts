import { crc32, deflateSync } from "node:zlib";

/** Small valid PNG fixtures with real compressed pixel rows. */
export function pngFixture(width = 1, height = 1, animated = false): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    ...(animated ? [chunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))] : []),
    chunk("IDAT", deflateSync(Buffer.alloc((1 + width * 4) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
