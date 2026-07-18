import { getPaper, readText, type Paper } from "./papers";

/**
 * System context injected into every per-paper chat turn: summary + metadata
 * always, extracted text windowed so huge papers never blow the context.
 */

const MAX_TEXT_CHARS = 50_000;

export function buildChatSystem(paper: Paper): string {
  const meta = paper.meta;
  const text = readText(paper.topic, paper.slug) ?? "";
  const window =
    text.length > MAX_TEXT_CHARS
      ? `${text.slice(0, MAX_TEXT_CHARS)}\n[...text truncated...]`
      : text;
  return [
    "You are a study companion for one research paper in the user's personal library.",
    "Ground every answer in the paper. Be precise; say so when something is not in the paper.",
    "",
    `Title: ${meta.title}`,
    `Authors: ${meta.authors.join(", ") || "unknown"}`,
    meta.year ? `Year: ${meta.year}` : "",
    meta.venue ? `Venue: ${meta.venue}` : "",
    meta.tags.length ? `Tags: ${meta.tags.join(", ")}` : "",
    "",
    paper.summary ? `Summary:\n${paper.summary}` : "",
    "",
    window ? `Paper text:\n${window}` : "(No extracted text available.)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Flatten prior turns into a single prompt for stateless providers. */
export function buildChatPrompt(
  history: { role: string; content: string }[],
  userMessage: string,
): string {
  const transcript = history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return transcript
    ? `${transcript}\n\nUser: ${userMessage}\n\nAssistant:`
    : userMessage;
}

export function requirePaper(topic: string, slug: string): Paper {
  const paper = getPaper(topic, slug);
  if (!paper) throw new Error(`Unknown paper ${topic}/${slug}`);
  return paper;
}
