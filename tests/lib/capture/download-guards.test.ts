import { describe, expect, it } from "vitest";
import { isPrivateAddress, looksLikePdf } from "@/lib/capture/download";

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
