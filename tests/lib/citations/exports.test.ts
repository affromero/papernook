import { describe, expect, it } from "vitest";
import type { Paper, PaperMeta } from "@/lib/library/papers";
import { exportCitations, paperToCsl } from "@/lib/library/citations";

function paper(
  slug: string,
  overrides: Partial<PaperMeta> = {},
  topic = "ml",
): Paper {
  const meta: PaperMeta = {
    title: "Attention & Transformation",
    authors: ["Legacy Author"],
    year: 2024,
    venue: "Legacy Venue",
    arxivId: null,
    bibtex: "@article{wrong, title={Wrong legacy title}}",
    tags: [],
    related: [],
    sourceUrl: "https://example.org/paper",
    addedAt: "2024-01-01T00:00:00.000Z",
    addedBy: "andres",
    citation: {
      type: "article-journal",
      authors: [{ family: "Doe", given: "Jane" }],
      DOI: "10.5555/example.1",
      containerTitle: "Journal of Examples",
      volume: "7",
      issue: "2",
      pages: "10-20",
    },
    ...overrides,
  };
  return {
    slug,
    topic,
    meta,
    pdfPath: `/tmp/${slug}.pdf`,
    companionDir: `/tmp/${slug}`,
    summary: null,
  };
}

describe("citation exports", () => {
  it("uses canonical metadata ahead of conflicting legacy BibTeX", () => {
    const record = paperToCsl(paper("attention"));
    expect(record).toMatchObject({
      title: "Attention & Transformation",
      type: "article-journal",
      author: [{ family: "Doe", given: "Jane" }],
      DOI: "10.5555/example.1",
      "container-title": "Journal of Examples",
      issued: { "date-parts": [[2024]] },
    });
    expect(record.id).toMatch(/^ml_attention_[a-f0-9]{10}$/);
    expect(record["citation-key"]).toBe(record.id);
  });

  it("emits CSL JSON, RIS, BibTeX, and a plain APA bibliography entry", () => {
    const source = [paper("attention")];
    const csl = JSON.parse(exportCitations(source, "csl-json")) as {
      DOI: string;
    }[];
    expect(csl[0].DOI).toBe("10.5555/example.1");

    const ris = exportCitations(source, "ris");
    expect(ris).toContain("TY  - JOUR");
    expect(ris).toContain("DO  - 10.5555/example.1");

    const bibtex = exportCitations(source, "bibtex");
    expect(bibtex).toContain(`@article{${paperToCsl(source[0]).id},`);
    expect(bibtex).toContain("title = {Attention \\& {Transformation}}");

    const apa = exportCitations(source, "apa");
    expect(apa).toContain("Doe, J.");
    expect(apa).toContain("https://doi.org/10.5555/example.1");
    expect(apa).not.toContain("<div");
  });

  it("parses legacy BibTeX only when canonical metadata is absent", () => {
    const legacy = paper("legacy", {
      citation: undefined,
      bibtex:
        "@inproceedings{legacy, author={Lovelace, Ada}, title={Analytical Engines}, year={1843}, booktitle={Proceedings}}",
    });
    expect(paperToCsl(legacy)).toMatchObject({
      title: "Analytical Engines",
      author: [{ family: "Lovelace", given: "Ada" }],
      issued: { "date-parts": [[1843]] },
      "container-title": "Proceedings",
    });
  });

  it("falls back safely and assigns stable unique BibTeX keys", () => {
    const first = paper("first", {
      citation: undefined,
      bibtex: "not valid bibtex",
    });
    const second = paper(
      "first",
      { citation: undefined, bibtex: null },
      "other-topic",
    );
    expect(paperToCsl(first).author).toEqual([{ literal: "Legacy Author" }]);
    const bibtex = exportCitations([second, first], "bibtex");
    const firstKey = paperToCsl(first).id;
    const secondKey = paperToCsl(second).id;
    expect(firstKey).not.toBe(secondKey);
    expect(bibtex).toContain(`@misc{${firstKey},`);
    expect(bibtex).toContain(`@misc{${secondKey},`);
  });
});
