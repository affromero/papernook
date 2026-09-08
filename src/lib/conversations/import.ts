import { fetchPublicUrl } from "@/lib/capture/download";
import { readBoundedResponse } from "@/lib/capture/bounded-response";
import {
  MAX_TRANSCRIPT_BYTES,
  sourceSchema,
  type ConversationSource,
} from "./store";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}
export function shareProvider(input: string): "chatgpt" | "claude" {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use a canonical HTTPS public share URL without query parameters.",
    );
  if (
    url.hostname === "chatgpt.com" &&
    /^\/share\/[a-f0-9-]{36}\/?$/.test(url.pathname)
  )
    return "chatgpt";
  if (
    url.hostname === "claude.ai" &&
    /^\/share\/[a-f0-9-]{36}\/?$/.test(url.pathname)
  )
    return "claude";
  throw new Error(
    "Supported share links are https://chatgpt.com/share/... and https://claude.ai/share/...",
  );
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(textContent).filter(Boolean).join("\n\n");
  const record = object(value);
  const type = record?.type ?? record?.content_type;
  if (
    typeof type === "string" &&
    /^(thinking|redacted_thinking|thoughts|reasoning_recap|model_editable_context|tool_use|tool_result)$/.test(
      type,
    )
  )
    return "";
  if (
    typeof type === "string" &&
    /^(image|image_url|image_asset_pointer|input_image|output_image|file|input_file|document|attachment|audio|video)(_|$)/.test(
      type,
    )
  )
    return "[Attachment unavailable in imported share]";
  return record
    ? textContent(record.parts ?? record.text ?? record.content)
    : "";
}
function message(
  value: unknown,
): ConversationSource["messages"][number] | null {
  const record = object(value);
  if (!record) return null;
  const metadata = object(record.metadata);
  if (
    metadata?.is_visually_hidden_from_conversation === true ||
    metadata?.is_redacted === true ||
    record.channel === "analysis" ||
    (typeof record.recipient === "string" && record.recipient !== "all")
  )
    return null;
  const author = object(record.author);
  const role =
    author?.role ??
    record.role ??
    (record.sender === "human" ? "user" : record.sender);
  if (role !== "user" && role !== "assistant") return null;
  const content = textContent(record.content ?? record.text).trim();
  return content ? { role, content } : null;
}
function transcript(value: unknown): ConversationSource["messages"] | null {
  const record = object(value);
  if (!record) return null;
  const mapping = object(record.mapping);
  if (mapping && typeof record.current_node === "string") {
    const nodes: unknown[] = [];
    const visited = new Set<string>();
    let id: unknown = record.current_node;
    while (typeof id === "string") {
      if (visited.has(id))
        throw new Error("Transcript contains a cyclic message branch.");
      visited.add(id);
      const node = object(mapping[id]);
      if (!node) throw new Error("Transcript message branch is incomplete.");
      nodes.push(node.message);
      id = node.parent;
    }
    return nodes.reverse().flatMap((value) => {
      const parsed = message(value);
      return parsed ? [parsed] : [];
    });
  }
  const messages =
    record.chat_messages ?? record.messages ?? record.linear_conversation;
  return Array.isArray(messages)
    ? messages.flatMap((value) => {
        const parsed = message(object(value)?.message ?? value);
        return parsed ? [parsed] : [];
      })
    : null;
}
function findTranscript(
  value: unknown,
): { title: string; messages: ConversationSource["messages"] } | null {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  for (let count = 0; queue.length && count < 100_000; count++) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const found = transcript(current);
    if (found?.length) {
      const record = object(current);
      return {
        title:
          typeof record?.title === "string"
            ? record.title
            : typeof record?.name === "string"
              ? record.name
              : "Imported conversation",
        messages: found,
      };
    }
    queue.push(...Object.values(current));
  }
  return null;
}
function decodeReferences(table: unknown[]): unknown {
  const cache = new Map<number, unknown>();
  function resolve(index: number, depth = 0): unknown {
    if (depth > 200) throw new Error("Share payload nesting is too deep.");
    if (index < 0) return null;
    if (cache.has(index)) return cache.get(index);
    const raw = table[index];
    if (!raw || typeof raw !== "object") return raw;
    const result: unknown[] | ObjectValue = Array.isArray(raw) ? [] : {};
    cache.set(index, result);
    for (const [key, value] of Object.entries(raw)) {
      const name = key.startsWith("_")
        ? String(table[Number(key.slice(1))])
        : key;
      if (
        name === "__proto__" ||
        name === "constructor" ||
        name === "prototype"
      )
        continue;
      (result as ObjectValue)[name] =
        typeof value === "number" ? resolve(value, depth + 1) : value;
    }
    return result;
  }
  return resolve(0);
}
export function parseShareHtml(
  html: string,
  provider: "chatgpt" | "claude",
): ConversationSource {
  const candidates: unknown[] = [];
  for (const match of html.matchAll(
    /streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/g,
  )) {
    try {
      const table: unknown = JSON.parse(JSON.parse(match[1]));
      if (Array.isArray(table)) candidates.push(decodeReferences(table));
    } catch {
      /* Other stream events do not contain transcript tables. */
    }
  }
  for (const match of html.matchAll(
    /(?:self\.)?__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")\]\)/g,
  )) {
    try {
      const flight: unknown = JSON.parse(match[1]);
      if (typeof flight !== "string") continue;
      for (const line of flight.split("\n")) {
        const row = /^[a-f0-9]+:(.*)$/.exec(line)?.[1];
        if (!row || !["{", "["].includes(row[0])) continue;
        try {
          candidates.push(JSON.parse(row));
        } catch {
          /* Non-JSON Flight rows are not transcript data. */
        }
      }
    } catch {
      /* Reject unsupported share payloads below. */
    }
  }
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      candidates.push(JSON.parse(match[1]));
    } catch {
      /* Reject unsuccessful extraction below. */
    }
  }
  for (const candidate of candidates) {
    const found = findTranscript(candidate);
    if (found)
      return sourceSchema.parse({
        ...found,
        provider,
        topic: "Uncategorized",
        tags: [],
      });
  }
  throw new Error(
    "The provider did not expose a readable conversation. It may require login or block automated access. Import an exported JSON or Markdown transcript instead.",
  );
}
let inflight = 0;
export async function importShare(url: string): Promise<ConversationSource> {
  const provider = shareProvider(url);
  if (inflight >= 3)
    throw new Error("Too many imports are running. Try again shortly.");
  inflight++;
  try {
    const fetched = await fetchPublicUrl(url);
    if (!fetched.response.ok) {
      await fetched.response.body?.cancel();
      await fetched.close();
      throw new Error(
        `Share provider returned HTTP ${fetched.response.status}. Import an exported transcript instead.`,
      );
    }
    try {
      if (shareProvider(fetched.url) !== provider)
        throw new Error("Unexpected share redirect.");
    } catch (error) {
      await fetched.response.body?.cancel();
      await fetched.close();
      throw error;
    }
    const html = (
      await readBoundedResponse(
        fetched.response,
        8 * 1024 * 1024,
        fetched.close,
      )
    ).toString("utf8");
    return { ...parseShareHtml(html, provider), sourceUrl: url };
  } finally {
    inflight--;
  }
}
export function importTranscript(
  content: string,
  format: "json" | "markdown",
): ConversationSource {
  if (Buffer.byteLength(content) > MAX_TRANSCRIPT_BYTES)
    throw new Error("Transcript exceeds the 4 MB limit.");
  if (format === "markdown")
    return sourceSchema.parse({
      title: "Imported transcript",
      topic: "Uncategorized",
      tags: [],
      provider: "transcript",
      messages: [{ role: "user", content: content.trim() }],
    });
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    value = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown);
  }
  if (Array.isArray(value)) {
    const messages = value.flatMap((entry) => {
      const record = object(entry);
      const payload = object(record?.payload);
      if (record?.type !== "response_item" || payload?.type !== "message")
        return [];
      const parsed = message(payload);
      return parsed ? [parsed] : [];
    });
    if (messages.length)
      return sourceSchema.parse({
        title: "Imported Codex session",
        topic: "Uncategorized",
        tags: [],
        provider: "codex",
        messages,
      });
  }
  const direct = sourceSchema.safeParse(value);
  if (direct.success) return direct.data;
  const found = findTranscript(value);
  if (!found)
    throw new Error(
      "JSON must contain a messages array with user/assistant roles and text content.",
    );
  return sourceSchema.parse({
    ...found,
    topic: "Uncategorized",
    tags: [],
    provider: "transcript",
  });
}
