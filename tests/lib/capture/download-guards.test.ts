import { describe, expect, it } from "vitest";
import {
  fetchPublicUrl,
  isPrivateAddress,
  looksLikePdf,
} from "@/lib/capture/download";
import {
  readBoundedResponse,
  readResponsePrefix,
  ResponseTooLargeError,
} from "@/lib/capture/bounded-response";

it.each([undefined, "1000"])(
  "reads only a metadata prefix and cancels the remainder with Content-Length %s",
  async (length) => {
    let cancelled = false;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("<head>metadata</head>unneeded body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: length ? { "Content-Length": length } : {},
    });
    const expected = Buffer.from("<head>metadata</head>");
    const bytes = await readResponsePrefix(
      response,
      expected.byteLength,
      async () => {
        closed = true;
      },
    );
    expect(bytes).toEqual(expected);
    expect(cancelled).toBe(true);
    expect(closed).toBe(true);
  },
);

it("stops at an exact prefix boundary without waiting for another chunk", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("head"));
    },
    cancel() {
      cancelled = true;
    },
  });
  expect((await readResponsePrefix(new Response(body), 4)).toString()).toBe(
    "head",
  );
  expect(cancelled).toBe(true);
});

it("still rejects oversized full responses while closing failed cancellation", async () => {
  let closed = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("oversized"));
      },
      cancel() {
        throw new Error("Cancellation failed");
      },
    }),
  );
  await expect(
    readBoundedResponse(response, 4, async () => {
      closed = true;
    }),
  ).rejects.toThrow();
  expect(closed).toBe(true);
  await expect(
    readBoundedResponse(new Response("oversized"), 4),
  ).rejects.toBeInstanceOf(ResponseTooLargeError);
});

it("preserves binary responses delivered a byte at a time", async () => {
  const expected = Buffer.from("A fragmented paper response\0".repeat(2000));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === expected.byteLength) controller.close();
      else controller.enqueue(expected.subarray(offset, ++offset));
    },
  });
  expect(
    await readBoundedResponse(new Response(body), expected.byteLength),
  ).toEqual(expected);
});

it("rejects cancelled public fetches before DNS resolution or connection", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Turn cancelled"));
  await expect(
    fetchPublicUrl("https://example.invalid", controller.signal),
  ).rejects.toThrow("Turn cancelled");
});

describe("SSRF address allowlist", () => {
  it("blocks loopback, link-local, and RFC1918 ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.169.254", // cloud metadata
      "::1",
      "fd00::1",
      "0:0:0:0:0:0:0:1",
      "0:0:0:0:0:ffff:7f00:1",
      "0064:ff9b::7f00:1",
      "fec0::1",
      "100::1",
      "2001:2::1",
      "2001:db8::1",
      "2001::1",
      "3fff::1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("blocks IPv6 transition prefixes that tunnel to private IPv4", () => {
    for (const address of [
      "64:ff9b::7f00:1", // NAT64 -> 127.0.0.1
      "2002:7f00:1::", // 6to4 -> 127.0.0.1
      "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("blocks the newly-added special-purpose IPv4 ranges", () => {
    expect(isPrivateAddress("198.51.100.4")).toBe(true); // TEST-NET-2
    expect(isPrivateAddress("192.88.99.1")).toBe(true); // 6to4 relay anycast
  });

  it("allows ordinary public addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("151.101.0.223")).toBe(false); // fastly
    expect(isPrivateAddress("2606:4700::1111")).toBe(false); // cloudflare
  });
});

describe("PDF content validation", () => {
  it("requires the %PDF- magic bytes regardless of a claimed content-type", () => {
    expect(looksLikePdf(Buffer.from("%PDF-1.7\n..."))).toBe(true);
    // A hostile origin sending HTML labelled application/pdf must not pass.
    expect(looksLikePdf(Buffer.from("<html><script>alert(1)</script>"))).toBe(
      false,
    );
    expect(looksLikePdf(Buffer.from(""))).toBe(false);
  });
});
