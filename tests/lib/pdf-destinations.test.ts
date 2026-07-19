import { describe, expect, it } from "vitest";
import {
  resolvePdfDestinationPage,
  type PdfDestinationDocument,
} from "@/lib/pdf/destinations";

function document(
  overrides: Partial<PdfDestinationDocument> = {},
): PdfDestinationDocument {
  return {
    numPages: 12,
    getDestination: async () => null,
    getPageIndex: async () => 0,
    ...overrides,
  };
}

describe("PDF destinations", () => {
  it("resolves a direct zero-based page destination", async () => {
    await expect(
      resolvePdfDestinationPage(document(), [4, { name: "Fit" }]),
    ).resolves.toBe(5);
  });

  it("resolves named destinations without moving the document", async () => {
    const pdf = document({
      getDestination: async (name) =>
        name === "reference-7" ? [{ num: 42, gen: 0 }] : null,
      getPageIndex: async (ref) => (ref.num === 42 ? 8 : 0),
    });

    await expect(resolvePdfDestinationPage(pdf, "reference-7")).resolves.toBe(
      9,
    );
  });

  it("rejects malformed and out-of-range destinations", async () => {
    const pdf = document();

    await expect(resolvePdfDestinationPage(pdf, [])).resolves.toBeNull();
    await expect(
      resolvePdfDestinationPage(pdf, ["not-a-page"]),
    ).resolves.toBeNull();
    await expect(
      resolvePdfDestinationPage(pdf, [99, { name: "Fit" }]),
    ).resolves.toBeNull();
  });

  it("returns null when a page reference cannot be resolved", async () => {
    const pdf = document({
      getPageIndex: async () => {
        throw new Error("missing page");
      },
    });

    await expect(
      resolvePdfDestinationPage(pdf, [{ num: 7, gen: 0 }]),
    ).resolves.toBeNull();
  });
});
