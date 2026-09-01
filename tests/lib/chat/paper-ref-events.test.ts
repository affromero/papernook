import { describe, expect, it } from "vitest";
import { wrapNote } from "@/lib/chat/margin-note";
import {
  CHAT_PROMPT_MAX_CHARS,
  MARGIN_NOTE_MAX_CHARS,
  MARGIN_NOTE_MAX_LINES,
  chatPromptDetail,
  parseChatPromptEvent,
  parseMarginNoteEvent,
} from "@/lib/chat/paper-ref-events";

describe("chat prompt events", () => {
  it("builds a bounded detail that only sends when asked", () => {
    expect(chatPromptDetail("Explain Figure 3")).toEqual({
      text: "Explain Figure 3",
      send: false,
    });
    expect(
      chatPromptDetail("x".repeat(CHAT_PROMPT_MAX_CHARS + 50), { send: true }),
    ).toEqual({
      text: "x".repeat(CHAT_PROMPT_MAX_CHARS),
      send: true,
    });
  });

  it("accepts only a non-empty bounded text and a boolean send flag", () => {
    expect(parseChatPromptEvent({ text: "About [12]", send: true })).toEqual({
      text: "About [12]",
      send: true,
    });
    expect(parseChatPromptEvent({ text: "About [12]" })).toEqual({
      text: "About [12]",
      send: false,
    });
    expect(
      parseChatPromptEvent({ text: "About [12]", send: "yes" })?.send,
    ).toBe(false);
    expect(parseChatPromptEvent({ text: "   " })).toBeNull();
    expect(parseChatPromptEvent({ text: 42 })).toBeNull();
    expect(
      parseChatPromptEvent({ text: "x".repeat(CHAT_PROMPT_MAX_CHARS + 1) }),
    ).toBeNull();
    expect(parseChatPromptEvent("About [12]")).toBeNull();
    expect(parseChatPromptEvent(null)).toBeNull();
  });
});

describe("margin note events", () => {
  it("accepts wrapped text with an optional validated locator", () => {
    expect(
      parseMarginNoteEvent({
        text: "line one\nline two",
        ref: { kind: "figure", label: "3" },
      }),
    ).toEqual({
      text: "line one\nline two",
      ref: { kind: "figure", label: "3" },
    });
    expect(parseMarginNoteEvent({ text: "note" })).toEqual({
      text: "note",
      ref: null,
    });
    // A malformed locator never blocks the note; it just loses its page.
    expect(
      parseMarginNoteEvent({ text: "note", ref: { kind: "poem", label: "1" } })
        ?.ref,
    ).toBeNull();
  });

  it("accepts the largest note the composer can produce", () => {
    const text = wrapNote("word ".repeat(2000).trim()).join("\n");
    expect(parseMarginNoteEvent({ text })).toEqual({ text, ref: null });
  });

  it("rejects empty, oversized or over-long notes and non-objects", () => {
    expect(parseMarginNoteEvent({ text: " \n " })).toBeNull();
    expect(
      parseMarginNoteEvent({ text: "x".repeat(MARGIN_NOTE_MAX_CHARS + 1) }),
    ).toBeNull();
    expect(
      parseMarginNoteEvent({
        text: Array(MARGIN_NOTE_MAX_LINES + 1)
          .fill("a")
          .join("\n"),
      }),
    ).toBeNull();
    expect(parseMarginNoteEvent("note")).toBeNull();
    expect(parseMarginNoteEvent(null)).toBeNull();
  });
});
