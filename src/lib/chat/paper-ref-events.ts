/**
 * Contract for the chat → PDF reference bridge. Chat decorations carry
 * their payload in data attributes; ChatPanel turns an activated button
 * into a `papernook:paper-ref` CustomEvent; PdfReader's bridge validates
 * the detail before acting. Chat content is AI output influenced by
 * web-downloaded paper text, so every field is treated as untrusted:
 * whitelisted kinds, bounded lengths, and shape checks — never trust
 * a parsed JSON blob structurally.
 */

import { NOTE_CHARS_PER_LINE, NOTE_MAX_LINES } from "@/lib/chat/margin-note";
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

/**
 * Reverse direction: any surface (a reference popover, a text selection)
 * hands the chat composer a prompt. The chat fills its input, focuses it,
 * and sends immediately only when the requester asks for it.
 */
export const CHAT_PROMPT_EVENT = "papernook:chat-prompt";
export const CHAT_PROMPT_MAX_CHARS = 4000;

export interface ChatPromptDetail {
  text: string;
  send: boolean;
}

export function chatPromptDetail(
  text: string,
  options: { send?: boolean } = {},
): ChatPromptDetail {
  return {
    text: text.slice(0, CHAT_PROMPT_MAX_CHARS),
    send: options.send === true,
  };
}

export function requestChatPrompt(
  text: string,
  options: { send?: boolean } = {},
): void {
  window.dispatchEvent(
    new CustomEvent(CHAT_PROMPT_EVENT, {
      detail: chatPromptDetail(text, options),
    }),
  );
}

/** Validate a chat-prompt CustomEvent detail. Null: ignore it. */
export function parseChatPromptEvent(detail: unknown): ChatPromptDetail | null {
  if (!isRecord(detail)) return null;
  const { text, send } = detail;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  if (text.length > CHAT_PROMPT_MAX_CHARS) return null;
  return { text, send: send === true };
}

/**
 * Chat → PDF: save an answer into the paper as a FreeText margin note. The
 * chat pre-wraps the text (see `@/lib/chat/margin-note`); `ref` is the
 * answer's first in-paper locator so the note lands on the page it talks
 * about, else the reader's current page. The bounds are exactly what the
 * composer can emit: `wrapNote`'s line cap and its per-line width plus the
 * newline joining each line.
 */
export const MARGIN_NOTE_EVENT = "papernook:margin-note";
export const MARGIN_NOTE_MAX_LINES = NOTE_MAX_LINES;
export const MARGIN_NOTE_MAX_CHARS = NOTE_MAX_LINES * (NOTE_CHARS_PER_LINE + 1);

export interface MarginNoteDetail {
  text: string;
  ref: { kind: PaperRefKind; label: string } | null;
}

export function requestMarginNote(detail: MarginNoteDetail): void {
  window.dispatchEvent(new CustomEvent(MARGIN_NOTE_EVENT, { detail }));
}

/** Validate a margin-note CustomEvent detail. Null: ignore it. */
export function parseMarginNoteEvent(detail: unknown): MarginNoteDetail | null {
  if (!isRecord(detail)) return null;
  const { text } = detail;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  if (text.length > MARGIN_NOTE_MAX_CHARS) return null;
  if (text.split("\n").length > MARGIN_NOTE_MAX_LINES) return null;
  return { text, ref: "ref" in detail ? parsePaperRef(detail.ref) : null };
}
