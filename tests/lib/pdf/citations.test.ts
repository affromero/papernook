import { describe, expect, it } from "vitest";
import { findCitations, type CitationKey } from "@/lib/pdf/citations";

function keys(text: string): CitationKey[] {
  return findCitations(text).map((citation) => citation.key);
}

describe("findCitations author-year", () => {
  it("finds every work in an AAAI-style multi-cite group split across lines", () => {
    // Verbatim from arXiv 2608.07463's introduction, with the text layer's
    // line breaks preserved.
    const text =
      "Recent advances in video diffusion models (VDMs) (Yang\n" +
      "et al. 2025b; Wan et al. 2025; Kong et al. 2024; HaCohen\n" +
      "et al. 2024) have enabled high-fidelity video synthesis";
    expect(keys(text)).toEqual([
      { kind: "authorYear", surname: "Yang", year: "2025", suffix: "b" },
      { kind: "authorYear", surname: "Wan", year: "2025", suffix: null },
      { kind: "authorYear", surname: "Kong", year: "2024", suffix: null },
      { kind: "authorYear", surname: "HaCohen", year: "2024", suffix: null },
    ]);
  });

  it("covers the author names with the first hotspot span", () => {
    const text = "supports movie creation (Xiao et al. 2026), and more";
    const [citation] = findCitations(text);
    expect(citation).toBeDefined();
    expect(text.slice(citation!.start, citation!.end)).toBe("Xiao et al. 2026");
  });

  it("finds narrative citations including the parenthesized year", () => {
    const text = "as Vaswani et al. (2017) demonstrated";
    const citations = findCitations(text);
    expect(citations.map((c) => c.key)).toEqual([
      { kind: "authorYear", surname: "Vaswani", year: "2017", suffix: null },
    ]);
    expect(text.slice(citations[0]!.start, citations[0]!.end)).toBe(
      "Vaswani et al. (2017)",
    );
  });

  it("handles APA commas, ampersands, and two-author forms", () => {
    expect(keys("(Smith & Jones, 2024)")).toEqual([
      { kind: "authorYear", surname: "Smith", year: "2024", suffix: null },
    ]);
    expect(keys("(Smith et al., 2020)")).toEqual([
      { kind: "authorYear", surname: "Smith", year: "2020", suffix: null },
    ]);
    expect(keys("(Smith and Jones 2024)")).toEqual([
      { kind: "authorYear", surname: "Smith", year: "2024", suffix: null },
    ]);
  });

  it("emits one citation per year for multi-work cites", () => {
    const text = "(Smith 2020, 2021b)";
    const citations = findCitations(text);
    expect(citations.map((c) => c.key)).toEqual([
      { kind: "authorYear", surname: "Smith", year: "2020", suffix: null },
      { kind: "authorYear", surname: "Smith", year: "2021", suffix: "b" },
    ]);
    expect(text.slice(citations[1]!.start, citations[1]!.end)).toBe("2021b");
  });

  it("keeps diacritics and nobiliary particles in the surname", () => {
    expect(keys("(Gülçehre et al. 2014)")).toEqual([
      { kind: "authorYear", surname: "Gülçehre", year: "2014", suffix: null },
    ]);
    expect(keys("(van der Berg 2019)")).toEqual([
      {
        kind: "authorYear",
        surname: "van der Berg",
        year: "2019",
        suffix: null,
      },
    ]);
  });

  it("re-joins a hyphenated surname split across a line break", () => {
    const [key] = keys("(Parker-\nHolder et al. 2023)");
    expect(key).toMatchObject({ kind: "authorYear", year: "2023" });
    expect((key as { surname: string }).surname.replace(/[\s-]/g, "")).toBe(
      "ParkerHolder",
    );
  });
});

describe("findCitations numeric", () => {
  it("gives each bracket-group member its own citation and span", () => {
    const text = "machine translation [35, 2, 5]. Numerous efforts";
    const citations = findCitations(text);
    expect(citations.map((c) => c.key)).toEqual([
      { kind: "numeric", number: 35 },
      { kind: "numeric", number: 2 },
      { kind: "numeric", number: 5 },
    ]);
    expect(text.slice(citations[0]!.start, citations[0]!.end)).toBe("35");
    expect(text.slice(citations[2]!.start, citations[2]!.end)).toBe("5");
  });

  it("keys a range member to its first number", () => {
    const text = "prior work [1–4, 7] shows";
    const citations = findCitations(text);
    expect(citations.map((c) => c.key)).toEqual([
      { kind: "numeric", number: 1 },
      { kind: "numeric", number: 7 },
    ]);
    expect(text.slice(citations[0]!.start, citations[0]!.end)).toBe("1–4");
  });

  it("finds single citations and hyphen ranges", () => {
    expect(keys("memory [13] and gated recurrent [7] networks")).toEqual([
      { kind: "numeric", number: 13 },
      { kind: "numeric", number: 7 },
    ]);
    expect(keys("architectures [38-40]")).toEqual([
      { kind: "numeric", number: 38 },
    ]);
  });
});

describe("findCitations rejections", () => {
  it("ignores parentheticals without a name-year shape", () => {
    expect(keys("(see Section 3)")).toEqual([]);
    expect(keys("a bare year (2025) is not a citation")).toEqual([]);
    expect(keys("the 2020s were formative")).toEqual([]);
  });

  it("ignores year-like tokens in bibliography prose", () => {
    // Real continuation lines from arXiv 2608.07463's references.
    expect(
      keys(
        "International Conference on Learning Representations, vol-\n" +
          "ume 2025, 102075–102121.",
      ),
    ).toEqual([]);
    expect(keys("arXiv preprint arXiv:2501.00103.")).toEqual([]);
  });

  it("ignores brackets holding anything but citation numbers", () => {
    expect(keys("the interval [0, a] is closed")).toEqual([]);
    expect(keys("tensors of shape [B, T, C]")).toEqual([]);
  });

  it("reports pattern-level look-alikes for the bibliography gate to kill", () => {
    // These are citation-shaped; only bibliography resolution can rule them
    // out, so the detector must keep them.
    expect(keys("the interval [0, 1] is closed")).toEqual([
      { kind: "numeric", number: 0 },
      { kind: "numeric", number: 1 },
    ]);
    expect(keys("(see Smith 2020)")).toEqual([
      { kind: "authorYear", surname: "Smith", year: "2020", suffix: null },
    ]);
  });

  it("returns sorted, non-overlapping citations for mixed styles", () => {
    const text = "Zhu et al. (2013) [40] improved parsing";
    const citations = findCitations(text);
    expect(citations.map((c) => c.key)).toEqual([
      { kind: "authorYear", surname: "Zhu", year: "2013", suffix: null },
      { kind: "numeric", number: 40 },
    ]);
    const [first, second] = citations;
    expect(first!.end).toBeLessThanOrEqual(second!.start);
  });
});
