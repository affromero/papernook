import { hiddenContent } from "../formats/visibility";
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

function chunkText(value: unknown, assistant: boolean): string[] {
  return array(value).flatMap((chunk) => {
    const outer = object(chunk);
    const body = object(outer?.text);
    if ((outer && hiddenContent(outer)) || (body && hiddenContent(body)))
      return [];
    const channel = body?.channel ?? outer?.channel;
    if (assistant && channel !== "CHANNEL_ASSISTANT_RESPONSE") return [];
    const content =
      typeof chunk === "string" && !assistant
        ? chunk
        : text(body?.text ?? outer?.text);
    return content.trim() ? [content] : [];
  });
}

export function grokTranscript(payload: unknown): ShareTranscript {
  const root = object(payload);
  if (root?.isPublic !== true)
    throw new Error("This Grok conversation is not publicly available.");
  if (!Array.isArray(root.responses))
    throw new Error("Grok returned an unreadable conversation.");
  if (root.responses.length > 20_000)
    throw new Error("Grok conversation exceeds the response limit.");
  const messages: ShareMessage[] = [];
  for (const value of root.responses) {
    const response = object(value);
    if (!response) throw new Error("Grok returned an unsupported response.");
    if (response.isControl === true || hiddenContent(response)) continue;
    const sender = text(response.sender).toLowerCase();
    if (!["human", "user", "assistant"].includes(sender)) continue;
    if (response.partial !== undefined && typeof response.partial !== "boolean")
      throw new Error("Grok returned an unsupported response state.");
    if (response.partial === true)
      throw new Error(
        "The Grok conversation is still generating. Try again after it finishes.",
      );
    const assistant = sender === "assistant";
    if (
      assistant &&
      response.channel !== undefined &&
      response.channel !== "CHANNEL_ASSISTANT_RESPONSE"
    )
      continue;
    const chunks = chunkText(
      assistant ? response.outputChunks : response.inputChunks,
      assistant,
    );
    const direct =
      text(response.message) || (!assistant ? text(response.query) : "");
    const content: unknown[] = direct.trim() ? [direct] : chunks;
    content.push(
      ...sharedMedia(response.generatedImageUrls, "image"),
      ...sharedMedia(response.imageAttachments, "image"),
      ...sharedMedia(response.fileAttachments, "file"),
      ...sharedMedia(response.fileUris, "file"),
    );
    for (const encoded of array(response.cardAttachmentsJson)) {
      if (typeof encoded !== "string")
        throw new Error("Grok returned unsupported saved card data.");
      let card: unknown;
      try {
        card = JSON.parse(encoded) as unknown;
      } catch {
        throw new Error("Grok returned unreadable saved card data.");
      }
      const value = object(card);
      if (value && !hiddenContent(value))
        content.push({
          type: "widget",
          component: text(value.component ?? value.type) || "Grok card",
          state: object(value.state ?? value.data) ?? value,
        });
    }
    if (content.length)
      messages.push({
        role: assistant ? "assistant" : "user",
        content,
        citations: publicSources(response.citedWebSearchResults),
      });
  }
  return validateTranscript({
    title: sourceTitle(object(root.conversation)?.title, "Grok"),
    messages,
  });
}
