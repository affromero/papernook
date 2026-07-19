import { describe, expect, it } from "vitest";
import {
  resolvePdfDestination,
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

  it("preserves finite XYZ coordinates for a cropped reference preview", async () => {
    await expect(
      resolvePdfDestination(document(), [
        4,
        { name: "XYZ" },
        314.5,
        418.9,
        1.25,
      ]),
    ).resolves.toEqual({
      pageNumber: 5,
      kind: "XYZ",
      left: 314.5,
      top: 418.9,
      zoom: 1.25,
    });
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

  it("resolves named XYZ destinations and ignores malformed coordinates", async () => {
    const pdf = document({
      getDestination: async () => [
        { num: 42, gen: 0 },
        { name: "XYZ" },
        Number.NaN,
        652,
        null,
      ],
      getPageIndex: async () => 8,
    });

    await expect(resolvePdfDestination(pdf, "reference-7")).resolves.toEqual({
      pageNumber: 9,
      kind: "XYZ",
      left: null,
      top: 652,
      zoom: null,
    });
  });

  it("keeps page-only fallbacks for non-XYZ destinations", async () => {
    await expect(
      resolvePdfDestination(document(), [2, { name: "FitH" }, 510]),
    ).resolves.toEqual({
      pageNumber: 3,
      kind: "FitH",
      left: null,
      top: null,
      zoom: null,
    });
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
