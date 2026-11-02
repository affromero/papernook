import { object, text, http } from "../formats/schema";
import type { ConversationCitation } from "../formats/schema";
import { hiddenContent } from "../formats/visibility";
export { object, text, http };

export interface ShareMessage {
  role: "user" | "assistant";
  content: unknown;
  citations?: ConversationCitation[];
}
export interface ShareTranscript {
  title: string;
  messages: ShareMessage[];
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new Error(`The provider returned an unsupported ${label}.`);
  return value;
}

export function sourceTitle(value: unknown, provider: string): string {
  return (text(value).trim() || `${provider} conversation`).slice(0, 200);
}

export function publicSources(value: unknown): ConversationCitation[] {
  return array(value).flatMap((entry, index) => {
    const record = object(entry);
    if (record && hiddenContent(record)) return [];
    const url = http(record?.url);
    return url
      ? [
          {
            ref: String(index + 1),
            url,
            title: (
              text(record?.title ?? record?.name) || new URL(url).hostname
            ).slice(0, 1000),
          },
        ]
      : [];
  });
}

export function sharedMedia(value: unknown, kind: "image" | "file"): unknown[] {
  return array(value).flatMap((entry) => {
    const record = object(entry);
    if (record && hiddenContent(record)) return [];
    const url = http(
      typeof entry === "string"
        ? entry
        : (record?.url ?? record?.uri ?? record?.imageUrl),
    );
    return url
      ? [
          {
            type: kind,
            url,
            name:
              text(record?.filename ?? record?.name ?? record?.title) ||
              `Shared ${kind}`,
            mime_type: text(record?.mimeType ?? record?.mime_type),
          },
        ]
      : [];
  });
}

export function validateTranscript(source: ShareTranscript): ShareTranscript {
  if (!source.messages.some((message) => message.role === "assistant"))
    throw new Error(
      "The public share does not include a completed visible answer.",
    );
  if (source.messages.length > 2000)
    throw new Error("Shared conversation exceeds the 2,000-message limit.");
  return source;
}
