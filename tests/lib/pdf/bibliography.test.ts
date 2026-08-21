import { describe, expect, it } from "vitest";
import {
  buildBibliography,
  matchCitation,
  pageLines,
  type Bibliography,
  type BibliographyPage,
} from "@/lib/pdf/bibliography";
import aaaiPages from "./fixtures/aaai-pages.json";
import attentionPages from "./fixtures/attention-pages.json";

// Real extracted text geometry (see fixtures/extract.mjs):
// - aaai-pages: arXiv 2608.07463 — author-year, two columns, no hanging
//   indent, no embedded cite links. Pages 1 (intro), 8-9 (references).
// - attention-pages: arXiv 1706.03762 — numbered [n] bibliography with a
//   hanging indent. Pages 2 (intro), 10-11 (references).
const AAAI = aaaiPages as BibliographyPage[];
const ATTENTION = attentionPages as BibliographyPage[];

function aaaiBibliography(): Bibliography {
  const bibliography = buildBibliography(
    AAAI.filter((page) => page.pageNumber !== 1),
  );
  expect(bibliography).not.toBeNull();
  return bibliography!;
}

function attentionBibliography(): Bibliography {
  const bibliography = buildBibliography(
    ATTENTION.filter((page) => page.pageNumber !== 2),
  );
  expect(bibliography).not.toBeNull();
  return bibliography!;
}

describe("pageLines", () => {
  it("never merges text across columns that share y coordinates", () => {
    const page = AAAI.find((candidate) => candidate.pageNumber === 9)!;
    const lines = pageLines(page);
    // Without per-column clustering these two collide at the same y.
    const artifact = lines.find((line) => line.text.includes("MirrorChu"));
    expect(artifact).toBeUndefined();
    expect(lines.some((line) => line.text.includes("Progressive Mirror"))).toBe(
      true,
    );
  });

  // Two columns at x=50/x=320 where blank chunks and recurring italic runs
  // both sit mid-page. Either one, if allowed to define a column, pulls the
  // right column's base into the gutter — every entry there then reads as a
  // continuation line and the column yields no references at all.
  it("keeps mid-page blanks and italic runs from inventing a column", () => {
    const chunks = [];
    for (let row = 0; row < 6; row += 1) {
      const y = 700 - row * 12;
      chunks.push({ str: `Left author ${row}. 2020. Title.`, x: 50, y });
      // The left column's line tails reach past mid-page, each at its own x.
      chunks.push({ str: "tail", x: 270 + row * 5, y });
      chunks.push({ str: "  ", x: 275, y });
      chunks.push({ str: "ACM Trans. Graph.", x: 195, y });
      chunks.push({ str: `Right author ${row}. 2021. Title.`, x: 320, y });
    }
    const lines = pageLines({ pageNumber: 1, pageWidth: 612, chunks });
    const right = lines.filter((line) => line.text.startsWith("Right author"));
    expect(right).toHaveLength(6);
    expect(right.every((line) => line.x === 320)).toBe(true);
  });
});

describe("buildBibliography (author-year, AAAI)", () => {
  it("detects the style and segments entries without a hanging indent", () => {
    const bibliography = aaaiBibliography();
    expect(bibliography.style).toBe("author-year");
    // The paper cites ~50 works; segmentation must be in that ballpark,
    // not one giant entry or one entry per line.
    expect(bibliography.entries.length).toBeGreaterThan(30);
    expect(bibliography.entries.length).toBeLessThan(70);
  });

  it("parses surname, year, and natbib suffix from entry heads", () => {
    const bibliography = aaaiBibliography();
    const haCohen = bibliography.entries.find(
      (entry) => entry.surname === "HaCohen",
    );
    expect(haCohen).toMatchObject({ year: "2024", pageNumber: 8 });
    expect(haCohen!.text).toContain("LTX-Video");
    const suffixed = bibliography.entries.filter(
      (entry) => entry.surname === "Yang" && entry.year === "2025",
    );
    expect(suffixed.map((entry) => entry.suffix).sort()).toEqual(["a", "b"]);
  });

  it("keeps an entry whole across a column break mid-author-list", () => {
    // The Wan 2025 entry's author list wraps into the next column, where
    // its continuation line ("Xu, X.; Kou, Y.; …") looks like an entry head.
    const bibliography = aaaiBibliography();
    const wan = bibliography.entries.find(
      (entry) => entry.surname === "Wan" && entry.year === "2025",
    );
    expect(wan).toBeDefined();
    expect(wan!.text).toContain("Open and Advanced Large-Scale Video");
    // The continuation line topping the next column must not have become
    // its own entry ("Xu, K. … ZOOM" is a real, different entry).
    expect(
      bibliography.entries.find((entry) => entry.text.startsWith("Xu, X.")),
    ).toBeUndefined();
  });

  it("resolves the paper's own introduction citations", () => {
    const bibliography = aaaiBibliography();
    const yang = matchCitation(bibliography, {
      kind: "authorYear",
      surname: "Yang",
      year: "2025",
      suffix: "b",
    });
    expect(yang?.text).toContain("CogVideoX");
    const haCohen = matchCitation(bibliography, {
      kind: "authorYear",
      surname: "HaCohen",
      year: "2024",
      suffix: null,
    });
    expect(haCohen?.text).toContain("LTX-Video");
    const wan = matchCitation(bibliography, {
      kind: "authorYear",
      surname: "Wan",
      year: "2025",
      suffix: null,
    });
    expect(wan?.text).toContain("Wan");
  });

  it("returns null for ambiguity and for keys with no entry", () => {
    const bibliography = aaaiBibliography();
    // Yang 2025 without a suffix is ambiguous between 2025a and 2025b.
    expect(
      matchCitation(bibliography, {
        kind: "authorYear",
        surname: "Yang",
        year: "2025",
        suffix: null,
      }),
    ).toBeNull();
    expect(
      matchCitation(bibliography, {
        kind: "authorYear",
        surname: "Smith",
        year: "2020",
        suffix: null,
      }),
    ).toBeNull();
    // Numeric keys never resolve against an author-year bibliography —
    // this is what kills [0, 1] math intervals.
    expect(
      matchCitation(bibliography, { kind: "numeric", number: 1 }),
    ).toBeNull();
  });
});

describe("buildBibliography (numbered, hanging indent)", () => {
  it("detects the numbered style and finds the heading mid-page", () => {
    const bibliography = attentionBibliography();
    expect(bibliography.style).toBe("numbered");
    const numbers = bibliography.entries
      .map((entry) => entry.number)
      .filter((number): number is number => number !== null);
    expect(numbers).toContain(1);
    expect(numbers).toContain(5);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("indexes entries across the page break", () => {
    const bibliography = attentionBibliography();
    const two = matchCitation(bibliography, { kind: "numeric", number: 2 });
    expect(two?.pageNumber).toBe(10);
    expect(two?.text).toContain("Bahdanau");
    const five = matchCitation(bibliography, { kind: "numeric", number: 5 });
    expect(five?.pageNumber).toBe(11);
    expect(five?.text).toContain("Learning phrase representations");
  });

  it("rejects out-of-range numbers", () => {
    const bibliography = attentionBibliography();
    expect(
      matchCitation(bibliography, { kind: "numeric", number: 999 }),
    ).toBeNull();
  });
});

describe("buildBibliography guards", () => {
  it("returns null without a References heading", () => {
    const intro = AAAI.filter((page) => page.pageNumber === 1);
    expect(buildBibliography(intro)).toBeNull();
    expect(buildBibliography([])).toBeNull();
  });
});
