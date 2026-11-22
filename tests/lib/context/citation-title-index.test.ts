import { describe, expect, it } from "vitest";
import { indexCitationTitles } from "@/lib/library/context/citation-title-index";
import {
  titleCited,
  tokenizeReference,
  tokenizeTitle,
} from "@/lib/library/context/reference-match";

describe("citation title index", () => {
  it("finds overlapping long titles when an indexed word is absent", () => {
    const match = indexCitationTitles([
      "Rare spectra spectra predict outcomes",
      "Rare spectra measures",
      "Spectra predict",
      "Spectra",
      "Rare spectra spectra predict outcomes",
    ]);
    const entry = tokenizeReference("Spectra predict outcomes in the study.");
    expect([...match(entry)].sort((a, b) => a - b)).toEqual([0, 2, 4]);
    expect([...match(tokenizeReference("Predict spectra outcomes"))]).toEqual([
      0, 4,
    ]);
  });

  it("returns the same matches as scanning every title", () => {
    const words = [
      "the",
      "for",
      "ação",
      "ALPHA",
      "beta",
      "gamma",
      "42",
      "2026",
    ];
    let state = 12345;
    const sample = (length: number) =>
      Array.from({ length }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return words[(state >>> 16) % words.length];
      }).join(" ");
    const titles = Array.from({ length: 250 }, (_, i) => sample(i % 25));
    const tokens = titles.map(tokenizeTitle);
    const match = indexCitationTitles(titles);
    const entries = titles.flatMap((title, i) => [
      `Author, A. ${title}. Venue, 2026.`,
      sample(i % 31),
    ]);

    for (const entry of entries) {
      const reference = tokenizeReference(entry);
      const expected = tokens.flatMap((title, i) =>
        titleCited(reference, title) ? [i] : [],
      );
      expect([...match(reference)].sort((a, b) => a - b)).toEqual(expected);
    }
  });
});
