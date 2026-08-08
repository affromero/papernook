import { describe, expect, it } from "vitest";
import {
  isLikelyRealTitle,
  resolvePdfDocumentTitle,
  titleFromFirstPageText,
} from "@/lib/pdf/title";

const PAGE_HEIGHT = 792;

function chunk(str: string, x: number, y: number, size: number) {
  return { str, x, y, size };
}

describe("isLikelyRealTitle", () => {
  it("rejects filenames, hashes, and single words", () => {
    expect(
      isLikelyRealTitle(
        "93be245fce00a9bb2333c17ceae4b732-Paper-Conference.pdf",
      ),
    ).toBe(false);
    expect(isLikelyRealTitle("untitled")).toBe(false);
    expect(isLikelyRealTitle("")).toBe(false);
  });

  it("accepts multi-word paper titles", () => {
    expect(isLikelyRealTitle("Attention Is All You Need")).toBe(true);
  });
});

describe("titleFromFirstPageText", () => {
  it("picks the largest-font run near the top, in reading order", () => {
    const title = titleFromFirstPageText(
      [
        chunk("Proceedings of Some Conference", 100, 760, 8),
        chunk("3D Student Splatting", 100, 700, 17),
        chunk("and Scooping", 300, 700, 17),
        chunk("continued on next line", 100, 680, 17),
        chunk("Jane Doe, John Smith", 100, 640, 10),
        chunk("Abstract text way below", 100, 300, 9),
      ],
      PAGE_HEIGHT,
    );
    expect(title).toBe(
      "3D Student Splatting and Scooping continued on next line",
    );
  });

  it("returns null when the top of the page has no title-shaped text", () => {
    expect(titleFromFirstPageText([], PAGE_HEIGHT)).toBeNull();
    expect(
      titleFromFirstPageText([chunk("x", 10, 700, 20)], PAGE_HEIGHT),
    ).toBeNull();
  });
});

describe("resolvePdfDocumentTitle", () => {
  // Fakes the streamTextContent reader (getTextContent is avoided on
  // purpose: its for-await needs ReadableStream async iteration, absent
  // before Safari 26.4), split into two chunks to exercise accumulation.
  const page = (items: unknown[]) => ({
    view: [0, 0, 612, PAGE_HEIGHT],
    streamTextContent: () => {
      const half = Math.ceil(items.length / 2);
      const batches = [items.slice(0, half), items.slice(half)].filter(
        (batch) => batch.length > 0,
      );
      return {
        getReader: () => ({
          read: async () => {
            const batch = batches.shift();
            return batch
              ? { done: false, value: { items: batch } }
              : { done: true };
          },
          releaseLock: () => undefined,
        }),
      };
    },
  });
  const textItem = (str: string, size: number, x: number, y: number) => ({
    str,
    transform: [size, 0, 0, size, x, y],
  });

  it("prefers real embedded Title metadata", async () => {
    const title = await resolvePdfDocumentTitle({
      getMetadata: async () => ({ info: { Title: "A Fine Embedded Title" } }),
      getPage: async () => page([]),
    });
    expect(title).toBe("A Fine Embedded Title");
  });

  it("falls back to the page-1 heuristic when metadata is a filename", async () => {
    const title = await resolvePdfDocumentTitle({
      getMetadata: async () => ({ info: { Title: "paper-conference.pdf" } }),
      getPage: async () =>
        page([
          textItem("Deep Learning For Everything", 17, 100, 700),
          textItem("Author Name", 10, 100, 650),
        ]),
    });
    expect(title).toBe("Deep Learning For Everything");
  });

  it("returns null when neither source yields a title", async () => {
    const title = await resolvePdfDocumentTitle({
      getMetadata: async () => ({ info: {} }),
      getPage: async () => page([]),
    });
    expect(title).toBeNull();
  });
});
