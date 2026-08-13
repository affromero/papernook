/**
 * Contract for the chat → PDF reference bridge. Chat decorations carry
 * their payload in data attributes; ChatPanel turns an activated button
 * into a `papernook:paper-ref` CustomEvent; PdfReader's bridge validates
 * the detail before acting. Chat content is AI output influenced by
 * web-downloaded paper text, so every field is treated as untrusted:
 * whitelisted kinds, bounded lengths, and shape checks — never trust
 * a parsed JSON blob structurally.
 */

import type { CitationKey } from "@/lib/pdf/citations";
import type { PaperRefKind } from "@/lib/pdf/paper-refs";

export const PAPER_REF_EVENT = "papernook:paper-ref";
/** PdfReader publishes the scanned bibliography for citation gating. */
export const BIBLIOGRAPHY_EVENT = "papernook:bibliography";

export type PaperRefAction = "goto" | "preview";

export type PaperRefEventDetail =
  | { action: PaperRefAction; ref: { kind: PaperRefKind; label: string } }
  | { action: "preview"; citation: CitationKey };

const KINDS: readonly PaperRefKind[] = [
  "figure",
  "table",
  "equation",
  "section",
  "algorithm",
  "appendix",
  "theorem",
  "lemma",
  "proposition",
  "definition",
  "corollary",
];

const LABEL_SHAPE = /^(?:\d+(?:\.\d+)*|[A-Z](?:(?:\.\d+)+|\d*)?)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parsePaperRef(
  value: unknown,
): { kind: PaperRefKind; label: string } | null {
  if (!isRecord(value)) return null;
  const { kind, label } = value;
  if (typeof kind !== "string" || typeof label !== "string") return null;
  if (!(KINDS as readonly string[]).includes(kind)) return null;
  if (label.length > 16 || !LABEL_SHAPE.test(label)) return null;
  return { kind: kind as PaperRefKind, label };
}

export function parseCitationKey(value: unknown): CitationKey | null {
  if (!isRecord(value)) return null;
  if (value.kind === "numeric") {
    const { number } = value;
    if (typeof number !== "number" || !Number.isInteger(number)) return null;
    if (number < 1 || number > 999) return null;
    return { kind: "numeric", number };
  }
  if (value.kind === "authorYear") {
    const { surname, year, suffix } = value;
    if (typeof surname !== "string" || surname.length === 0) return null;
    if (surname.length > 80) return null;
    if (typeof year !== "string" || !/^(?:19|20)\d{2}$/.test(year)) {
      return null;
    }
    if (suffix !== null && (typeof suffix !== "string" || suffix.length > 1)) {
      return null;
    }
    return { kind: "authorYear", surname, year, suffix };
  }
  return null;
}

/** Validate a CustomEvent detail from the chat side. Null: ignore it. */
export function parsePaperRefEvent(
  detail: unknown,
): PaperRefEventDetail | null {
  if (!isRecord(detail)) return null;
  const { action } = detail;
  if ("ref" in detail && (action === "goto" || action === "preview")) {
    const ref = parsePaperRef(detail.ref);
    return ref ? { action, ref } : null;
  }
  if ("citation" in detail && action === "preview") {
    const citation = parseCitationKey(detail.citation);
    return citation ? { action: "preview", citation } : null;
  }
  return null;
}

function parseJson(raw: string | undefined): unknown {
  if (!raw || raw.length > 200) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Build the event detail for an activated decoration button.
 * `dataset.paperRef` / `dataset.citation` hold the JSON the rehype
 * decorator emitted; citations only ever preview.
 */
export function detailFromDataset(
  dataset: { paperRef?: string; citation?: string },
  action: PaperRefAction,
): PaperRefEventDetail | null {
  const ref = parsePaperRef(parseJson(dataset.paperRef));
  if (ref) return { action, ref };
  const citation = parseCitationKey(parseJson(dataset.citation));
  if (citation) return { action: "preview", citation };
  return null;
}
