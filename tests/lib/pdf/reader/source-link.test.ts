import { describe, expect, it } from "vitest";
import { originalPdfUrl, originalWebUrl } from "@/lib/pdf/reader/source-link";

describe("original paper links", () => {
  it("opens the arXiv abstract page from a PDF URL", () => {
    expect(
      originalWebUrl("https://arxiv.org/pdf/1706.03762v2.pdf#page=4"),
    ).toBe("https://arxiv.org/abs/1706.03762v2#page=4");
  });

  it("bypasses automatic PDF interception and preserves fragments", () => {
    expect(originalWebUrl("https://example.org/paper.pdf#page=2")).toBe(
      "https://example.org/paper.pdf?papernook_original=1#page=2",
    );
    expect(originalPdfUrl("https://arxiv.org/pdf/1706.03762#page=2")).toBe(
      "https://arxiv.org/pdf/1706.03762?papernook_original=1#page=2",
    );
  });

  it("preserves query strings on signed URLs", () => {
    const source = "https://example.org/a%20paper.pdf?signature=a%2Bb#page=2";
    expect(originalWebUrl(source)).toBe(source);
    expect(originalPdfUrl(source)).toBe(source);
    const arxiv = "https://arxiv.org/pdf/1706.03762?signature=a%2Bb#page=2";
    expect(originalWebUrl(arxiv)).toBe(arxiv);
  });

  it("keeps Papernook PDF paths and rejects unsafe source links", () => {
    expect(originalPdfUrl("/api/v1/papers/a/b/pdf")).toBe(
      "/api/v1/papers/a/b/pdf",
    );
    expect(originalWebUrl("javascript:alert(1)")).toBeNull();
    expect(originalWebUrl("")).toBeNull();
  });
});
