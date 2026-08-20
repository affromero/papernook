import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

/**
 * Serve a file on disk with HTTP range support, streaming instead of
 * buffering. pdf.js only fetches page-by-page when the first response
 * advertises `accept-ranges: bytes` alongside a real `content-length`, so a
 * 20 MB paper paints its first page after a few hundred KB instead of after
 * the whole download.
 */

export interface FileResponseOptions {
  path: string;
  size: number;
  etag: string;
  /** Incoming request; read for `range` and `if-none-match`. */
  headers: Headers;
  contentType: string;
  /** Filename for `content-disposition: inline`; omitted when absent. */
  filename?: string;
  cacheControl: string;
  extraHeaders?: Record<string, string>;
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single byte range. Multi-range requests (`bytes=0-9,20-29`) are
 * deliberately unsupported — no PDF client sends them, and answering with
 * the full body is a valid response to any range request.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (length === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

function streamFile(path: string, range?: ByteRange): ReadableStream {
  const node = range
    ? fs.createReadStream(path, { start: range.start, end: range.end })
    : fs.createReadStream(path);
  return Readable.toWeb(node) as ReadableStream;
}

export function fileResponse(options: FileResponseOptions): NextResponse {
  const {
    path,
    size,
    etag,
    headers,
    contentType,
    filename,
    cacheControl,
    extraHeaders,
  } = options;

  const baseHeaders: Record<string, string> = {
    ...extraHeaders,
    etag,
    "cache-control": cacheControl,
    "accept-ranges": "bytes",
  };

  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((v) => v.trim() === etag)) {
    return new NextResponse(null, { status: 304, headers: baseHeaders });
  }

  const contentHeaders = {
    ...baseHeaders,
    "content-type": contentType,
    ...(filename
      ? { "content-disposition": `inline; filename="${filename}"` }
      : {}),
  };

  const range = parseByteRange(headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${size}` },
    });
  }
  if (range) {
    return new NextResponse(streamFile(path, range), {
      status: 206,
      headers: {
        ...contentHeaders,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": String(range.end - range.start + 1),
      },
    });
  }

  return new NextResponse(streamFile(path), {
    headers: { ...contentHeaders, "content-length": String(size) },
  });
}
