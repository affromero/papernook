import { describe, expect, it } from "vitest";
import { normalizeEtag } from "@/lib/pdf/etag";

describe("normalizeEtag", () => {
  it("strips the weak marker a compressing proxy adds", () => {
    expect(normalizeEtag('W/"abc123"')).toBe('"abc123"');
  });

  it("passes strong etags through unchanged", () => {
    expect(normalizeEtag('"abc123"')).toBe('"abc123"');
  });

  it("returns null for a missing header", () => {
    expect(normalizeEtag(null)).toBeNull();
    expect(normalizeEtag("")).toBeNull();
  });

  it("makes a weakened save etag match the next strong poll etag", () => {
    // The self-reload bug: Cloudflare weakens the PUT response etag, the
    // HEAD poll returns the strong form, and the mismatch remounted the
    // reader over its own save.
    expect(normalizeEtag('W/"abc123"')).toBe(normalizeEtag('"abc123"'));
  });
});
