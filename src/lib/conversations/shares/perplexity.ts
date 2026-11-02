import { hiddenContent } from "../formats/visibility";
import { protectMarkdownCode } from "@/lib/chat/format/code";
import { shareLocation } from "./urls";
import {
  array,
  object,
  text,
  sourceTitle,
  publicSources,
  sharedMedia,
  validateTranscript,
  type ShareMessage,
  type ShareTranscript,
} from "./schema";

function json(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Perplexity returned an unreadable answer.");
  }
}

export function perplexityTranscript(
  payload: unknown,
  expectedId?: string,
): ShareTranscript {
  const root = object(payload);
  if (!root || !Array.isArray(root.entries))
    throw new Error("Perplexity did not expose a readable conversation.");
  if (root.has_next_page === true)
    throw new Error(
      "Perplexity returned only part of this conversation. Import a complete exported transcript instead.",
    );
  if (root.entries.length > 1000)
    throw new Error("Shared conversation exceeds the 2,000-message limit.");
  const messages: ShareMessage[] = [];
  for (const value of root.entries) {
    const entry = object(value);
    if (!entry)
      throw new Error("Perplexity returned an unsupported history entry.");
    if (hiddenContent(entry)) continue;
    if (
      expectedId &&
      shareLocation(
        `https://www.perplexity.ai/search/${text(entry.thread_url_slug)}`,
      ).id !== expectedId
    )
      throw new Error("Perplexity returned a mismatched public conversation.");
    if (
      (entry.access_level !== undefined &&
        entry.access_level !== "PUBLIC_READ") ||
      entry.thread_access !== 2 ||
      entry.privacy_state !== "NONE"
    )
      throw new Error(
        "This Perplexity conversation is not publicly available.",
      );
    if (text(entry.status).toLowerCase() !== "completed")
      throw new Error("The Perplexity answer is still generating.");
    const query = text(entry.query_str);
    const content: unknown[] = [];
    let sources: unknown[] = [];
    if (Array.isArray(entry.blocks)) {
      for (const value of entry.blocks) {
        const block = object(value);
        if (!block || hiddenContent(block)) continue;
        if (
          [
            "inline_entity_cards",
            "place_widgets",
            "finance_widgets",
            "news_widgets",
            "shopping_widgets",
            "search_result_widgets",
            "maps_preview",
          ].includes(text(block.intended_usage))
        ) {
          content.push({
            type: "widget",
            component: `Perplexity ${text(block.intended_usage)}`,
            state: block,
          });
          continue;
        }
        if (block.intended_usage === "ask_text") {
          const markdown = object(block.markdown_block);
          if (markdown && hiddenContent(markdown)) continue;
          if (markdown?.progress !== "DONE")
            throw new Error("The Perplexity answer is still generating.");
          if (
            typeof markdown.answer !== "string" &&
            (!Array.isArray(markdown.chunks) ||
              !markdown.chunks.every((part) => typeof part === "string"))
          )
            throw new Error("Perplexity returned an unsupported answer chunk.");
          const answer =
            typeof markdown.answer === "string"
              ? markdown.answer
              : array(markdown.chunks).join("");
          if (answer.trim()) content.push(answer);
        }
        if (block.intended_usage === "web_results") {
          const results = object(block.web_result_block);
          if (results && !hiddenContent(results))
            sources = array(results.web_results);
        }
        if (block.intended_usage === "media_items") {
          const mediaBlock = object(block.media_block);
          if (!mediaBlock || hiddenContent(mediaBlock)) continue;
          for (const value of array(mediaBlock.media_items)) {
            const media = object(value);
            if (media && hiddenContent(media)) continue;
            if (media?.medium === "image")
              content.push(...sharedMedia([media], "image"));
            else if (typeof media?.url === "string")
              content.push({
                type: "text",
                text: text(media.name) || "Shared media",
                citations: [
                  { url: media.url, title: text(media.name) || "Shared media" },
                ],
              });
          }
        }
      }
    } else if (typeof entry.text === "string") {
      for (const value of array(json(entry.text))) {
        const step = object(value);
        if (step?.step_type !== "FINAL") continue;
        const completed = object(step.content);
        if (hiddenContent(step) || (completed && hiddenContent(completed)))
          continue;
        const raw = completed?.answer;
        if (typeof raw !== "string")
          throw new Error("Perplexity omitted its completed answer.");
        const answer = object(json(raw));
        if (answer && hiddenContent(answer)) continue;
        if (typeof answer?.answer !== "string")
          throw new Error("Perplexity omitted its answer text.");
        content.push(answer.answer);
        sources = array(answer.web_results);
      }
    }
    if (!content.length)
      throw new Error("Perplexity did not include a completed visible answer.");
    const citations = publicSources(sources);
    const rendered = content.map((part) => {
      if (typeof part !== "string") return part;
      const code = protectMarkdownCode(part, true);
      return code.restore(
        code.text.replace(/\[(\d+)\]/g, (marker, ref: string) =>
          citations.some((citation) => citation.ref === ref)
            ? `\uE200cite\uE202${ref}\uE201`
            : marker,
        ),
      );
    });
    if (query.trim())
      messages.push({
        role: "user",
        content: [query, ...sharedMedia(entry.attachments, "file")],
      });
    messages.push({ role: "assistant", content: rendered, citations });
  }
  return validateTranscript({
    title: sourceTitle(object(root.thread_metadata)?.title, "Perplexity"),
    messages,
  });
}
