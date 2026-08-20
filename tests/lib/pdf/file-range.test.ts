import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileResponse } from "@/lib/http/file-range";

const BODY = "0123456789ABCDEF";
let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-range-"));
  filePath = path.join(tmpDir, "paper.pdf");
  fs.writeFileSync(filePath, BODY);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function serve(headers: Record<string, string> = {}) {
  return fileResponse({
    path: filePath,
    size: BODY.length,
    etag: '"abc"',
    headers: new Headers(headers),
    contentType: "application/pdf",
    filename: "paper.pdf",
    cacheControl: "private, no-cache",
  });
}

describe("fileResponse", () => {
  it("serves the whole file and advertises range support", async () => {
    const response = serve();
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(BODY.length));
    expect(await response.text()).toBe(BODY);
  });

  it("serves only the requested byte range", async () => {
    const response = serve({ range: "bytes=4-7" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 4-7/16");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("4567");
  });

  it("serves an open-ended range to the end of the file", async () => {
    const response = serve({ range: "bytes=12-" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 12-15/16");
    expect(await response.text()).toBe("CDEF");
  });

  it("serves a suffix range as the trailing bytes", async () => {
    const response = serve({ range: "bytes=-4" });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("CDEF");
  });

  it("clamps a range that runs past the end of the file", async () => {
    const response = serve({ range: "bytes=14-99" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 14-15/16");
    expect(await response.text()).toBe("EF");
  });

  it("rejects a range that starts past the end of the file", async () => {
    const response = serve({ range: "bytes=99-" });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */16");
  });

  it("falls back to the whole file for an unparsable range", async () => {
    const response = serve({ range: "pages=1-2" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
  });

  it("answers a matching if-none-match with an empty 304", async () => {
    const response = serve({ "if-none-match": '"abc"' });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"abc"');
    expect(await response.text()).toBe("");
  });

  it("sends the file when if-none-match holds a stale version", async () => {
    const response = serve({ "if-none-match": '"stale"' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
  });
});
