import { describe, expect, it } from "vitest";
import {
  captionPattern,
  destinationCandidates,
  findPaperRefs,
  type PaperRef,
} from "@/lib/pdf/paper-refs";

function refs(text: string): [PaperRef["kind"], string][] {
  return findPaperRefs(text).map((ref) => [ref.kind, ref.label]);
}

describe("findPaperRefs", () => {
  it("finds figures, tables, and equations in prose", () => {
    expect(
      refs("As Figure 3 shows (cf. Table 2), Eq. (5) bounds the loss."),
    ).toEqual([
      ["figure", "3"],
      ["table", "2"],
      ["equation", "5"],
    ]);
  });

  it("finds abbreviated and parenthesized section refs", () => {
    expect(refs("the paper reports (Sec. 4.3) that pruning breaks")).toEqual([
      ["section", "4.3"],
    ]);
    expect(refs("see §2.1 and Section 5")).toEqual([
      ["section", "2.1"],
      ["section", "5"],
    ]);
  });

  it("finds appendices, algorithms, and theorem-like refs", () => {
    expect(
      refs("Appendix B.2 proves Theorem 1 used by Algorithm 2 and Lemma 3"),
    ).toEqual([
      ["appendix", "B.2"],
      ["theorem", "1"],
      ["algorithm", "2"],
      ["lemma", "3"],
    ]);
  });

  it("finds appendix and supplement-style locators", () => {
    expect(
      refs("Eq. (A.1), Figure S1, and Table S2 support Appendix B."),
    ).toEqual([
      ["equation", "A.1"],
      ["figure", "S1"],
      ["table", "S2"],
      ["appendix", "B"],
    ]);
  });

  it("reports match offsets that cover the whole reference", () => {
    const text = "see Eq. (12) here";
    const [ref] = findPaperRefs(text);
    expect(text.slice(ref!.start, ref!.end)).toBe("Eq. (12)");
  });

  it("skips references into other papers", () => {
    expect(refs("Figure 3 of [12] uses the same setup")).toEqual([]);
    expect(refs("Sec. 2 in Smith et al. defines it")).toEqual([]);
    expect(refs("Figure 3 in the appendix")).toEqual([["figure", "3"]]);
  });

  it("skips words without labels and numeric appendix labels", () => {
    expect(refs("the figure below has no printed locator")).toEqual([]);
    expect(refs("Appendix 3 is not a thing either")).toEqual([]);
  });

  it("requires capitalized reference words", () => {
    expect(refs("a section 2 subgroup of order 4")).toEqual([]);
  });
});

describe("destinationCandidates", () => {
  it("maps sections depth-aware", () => {
    expect(destinationCandidates({ kind: "section", label: "4" })).toEqual([
      "section.4",
    ]);
    expect(destinationCandidates({ kind: "section", label: "4.3" })[0]).toBe(
      "subsection.4.3",
    );
    expect(destinationCandidates({ kind: "section", label: "4.3.1" })[0]).toBe(
      "subsubsection.4.3.1",
    );
  });

  it("treats letter-led section labels as appendices", () => {
    expect(destinationCandidates({ kind: "section", label: "B" })).toEqual([
      "appendix.B",
      "section.B",
    ]);
    expect(destinationCandidates({ kind: "appendix", label: "B.1" })).toEqual([
      "subsection.B.1",
      "appendix.B.1",
    ]);
  });

  it("covers unsectioned equation numbering", () => {
    expect(destinationCandidates({ kind: "equation", label: "5" })).toEqual([
      "equation.5",
      "equation.0.5",
    ]);
    expect(destinationCandidates({ kind: "equation", label: "4.5" })).toEqual([
      "equation.4.5",
    ]);
    expect(destinationCandidates({ kind: "equation", label: "A.1" })).toEqual([
      "equation.A.1",
    ]);
    expect(destinationCandidates({ kind: "figure", label: "S1" })).toEqual([
      "figure.S1",
    ]);
  });

  it("lists common theorem-environment abbreviations", () => {
    expect(destinationCandidates({ kind: "theorem", label: "1" })).toEqual([
      "theorem.1",
      "thm.1",
    ]);
    expect(destinationCandidates({ kind: "algorithm", label: "2" })).toContain(
      "algocf.2",
    );
  });
});

describe("captionPattern", () => {
  it("matches figure captions with either separator", () => {
    const pattern = captionPattern({ kind: "figure", label: "3" })!;
    expect(pattern.test("Figure 3: Overview of the pipeline")).toBe(true);
    expect(pattern.test("Fig. 3. Overview of the pipeline")).toBe(true);
    expect(pattern.test("Figure 30: a different figure")).toBe(false);
    expect(pattern.test("see Figure 3: mid-line mention")).toBe(false);
    expect(
      captionPattern({ kind: "figure", label: "S1" })!.test(
        "Figure S1: Supplementary overview",
      ),
    ).toBe(true);
  });

  it("matches section headings without matching prose", () => {
    const pattern = captionPattern({ kind: "section", label: "4.3" })!;
    expect(pattern.test("4.3 Ablations")).toBe(true);
    expect(pattern.test("4.3.1 More ablations")).toBe(false);
  });

  it("returns null for equations", () => {
    expect(captionPattern({ kind: "equation", label: "5" })).toBeNull();
  });
});
