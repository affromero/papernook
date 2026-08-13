/**
 * In-paper reference detection ("Figure 3", "Sec. 4.1", "Eq. (5)") over
 * chat/prose text, plus resolution helpers: hyperref destination-name
 * candidates to try against the PDF's named destinations, and a caption
 * pattern for the text-search fallback when a PDF carries no destinations.
 *
 * Pure and deliberately conservative: matching requires the capitalized
 * reference word (how both papers and AI chat write them), and a reference
 * followed by "of/in/from <citation or Title>" is dropped — "Figure 3 of
 * [12]" points into a different paper and must not navigate this one.
 */

export type PaperRefKind =
  | "figure"
  | "table"
  | "equation"
  | "section"
  | "algorithm"
  | "appendix"
  | "theorem"
  | "lemma"
  | "proposition"
  | "definition"
  | "corollary";

export interface PaperRef {
  /** Offsets into the searched text, [start, end). */
  start: number;
  end: number;
  kind: PaperRefKind;
  /** Counter value as printed: "3", "4.1", "B", "B.2". */
  label: string;
}

/** "4", "4.1", "B", "B.2", "S1" — numeric or supplement-led. */
const LABEL = "(?:\\d+(?:\\.\\d+)*|[A-Z](?:(?:\\.\\d+)+|\\d*)?)";

const WORDS: [PaperRefKind, string][] = [
  ["figure", "Figures?|Fig\\.?"],
  ["table", "Tables?|Tab\\."],
  ["equation", "Equations?|Eqn?s?\\.?"],
  ["section", "Sections?|Sec\\.?|§"],
  ["algorithm", "Algorithms?|Alg\\.?"],
  ["appendix", "Appendix|Appendices"],
  ["theorem", "Theorems?|Thm\\.?"],
  ["lemma", "Lemmas?|Lem\\.?"],
  ["proposition", "Propositions?|Prop\\.?"],
  ["definition", "Definitions?|Defn?\\.?"],
  ["corollary", "Corollary|Corollaries|Cor\\.?"],
];

// A word boundary fails before "§" (non-word on both sides); a
// letter/digit lookbehind guards every alternative, including it. The label
// is either parenthesized ("Eq. (5)") or bare — a bare label must not
// consume a stray ")" from surrounding text like "(Sec. 4.3)".
const REF_PATTERN = new RegExp(
  `(?<![\\p{L}\\d])(${WORDS.map(([, word]) => word).join("|")})\\s*(?:\\(\\s*(${LABEL})\\s*\\)|(${LABEL}))`,
  "gu",
);

const KIND_MATCHERS: [PaperRefKind, RegExp][] = WORDS.map(([kind, word]) => [
  kind,
  new RegExp(`^(?:${word})$`),
]);

/** "Figure 3 of [12]" / "Sec. 2 in Smith et al." — someone else's paper. */
const OTHER_PAPER = /^\s+(?:of|in|from)\s+(?:\[|\p{Lu})/u;

function kindOf(word: string): PaperRefKind | null {
  for (const [kind, matcher] of KIND_MATCHERS) {
    if (matcher.test(word)) return kind;
  }
  return null;
}

/**
 * Find everything reference-shaped in `text`, sorted by position. A section
 * label may be letter-led ("Sec. B.2", "Eq. (A.1)", "Figure S1"); appendix
 * labels must be letter-led ("Appendix B").
 */
export function findPaperRefs(text: string): PaperRef[] {
  const refs: PaperRef[] = [];
  REF_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(REF_PATTERN)) {
    const word = match[1];
    const label = match[2] ?? match[3];
    if (!word || !label) continue;
    const kind = kindOf(word);
    if (!kind) continue;
    const letterLed = /^[A-Z]/.test(label);
    if (!letterLed && kind === "appendix") continue;
    if (OTHER_PAPER.test(text.slice(match.index + match[0].length))) continue;
    refs.push({
      start: match.index,
      end: match.index + match[0].length,
      kind,
      label,
    });
  }
  return refs;
}

/**
 * hyperref destination names to try, most specific first. hyperref anchors
 * are `<counter>.<value>`: sections deepen to subsection/subsubsection,
 * appendices keep the section counter, equations may carry a section prefix
 * (`equation.0.5` in unsectioned documents), and theorem-like environments
 * use whatever name the author gave `\newtheorem` — so those list the
 * common abbreviations and lean on the caption fallback otherwise.
 */
export function destinationCandidates(ref: {
  kind: PaperRefKind;
  label: string;
}): string[] {
  const { kind, label } = ref;
  const depth = label.split(".").length;
  switch (kind) {
    case "figure":
      return [`figure.${label}`];
    case "table":
      return [`table.${label}`];
    case "equation":
      return depth === 1
        ? [`equation.${label}`, `equation.0.${label}`]
        : [`equation.${label}`];
    case "section": {
      if (/^[A-Z]/.test(label) && depth === 1) {
        return [`appendix.${label}`, `section.${label}`];
      }
      const counter =
        depth === 1 ? "section" : depth === 2 ? "subsection" : "subsubsection";
      return counter === "section"
        ? [`section.${label}`]
        : [`${counter}.${label}`, `section.${label}`];
    }
    case "appendix":
      return depth === 1
        ? [`appendix.${label}`, `section.${label}`]
        : [`subsection.${label}`, `appendix.${label}`];
    case "algorithm":
      return [`algorithm.${label}`, `algocf.${label}`, `alg.${label}`];
    case "theorem":
      return [`theorem.${label}`, `thm.${label}`];
    case "lemma":
      return [`lemma.${label}`, `lem.${label}`];
    case "proposition":
      return [`proposition.${label}`, `prop.${label}`];
    case "definition":
      return [`definition.${label}`, `defn.${label}`, `def.${label}`];
    case "corollary":
      return [`corollary.${label}`, `cor.${label}`];
  }
}

const CAPTION_WORDS: Partial<Record<PaperRefKind, string>> = {
  figure: "(?:Figure|Fig\\.)",
  table: "(?:Table|Tab\\.)",
  algorithm: "(?:Algorithm|Alg\\.)",
  theorem: "Theorem",
  lemma: "Lemma",
  proposition: "Proposition",
  definition: "Definition",
  corollary: "Corollary",
};

function escapeLabel(label: string): string {
  return label.replaceAll(".", "\\.");
}

/**
 * Line-start pattern locating the ref's caption (or heading) in page text,
 * for PDFs without named destinations. Null for equations — equation
 * numbers sit at line ends inside math and cannot be matched reliably.
 */
export function captionPattern(ref: {
  kind: PaperRefKind;
  label: string;
}): RegExp | null {
  const label = escapeLabel(ref.label);
  if (ref.kind === "equation") return null;
  if (ref.kind === "section" || ref.kind === "appendix") {
    // "4.3  Ablations" / "B.2 Proofs" — a heading line, not a sentence.
    return new RegExp(`^${label}\\.?\\s+\\S`);
  }
  const word = CAPTION_WORDS[ref.kind];
  if (!word) return null;
  return new RegExp(`^${word}\\s*${label}\\s*[.:]`, "i");
}
