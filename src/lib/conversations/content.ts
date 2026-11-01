import { formatTableCell } from "@/lib/chat/format/table";
import { fenceCode as fence } from "@/lib/chat/format/code";
import { importedMedia, registerCardImages } from "./formats/media";
import { citationLinks } from "./formats/citations";
import { notebookOutput } from "./formats/notebook";
import { previewKind, chartMime } from "./formats/presentation";
import { hiddenContent } from "./formats/visibility";
import {
  citationSchema,
  object as asObject,
  text as string,
  http,
  type ConversationAsset,
  type ConversationCitation,
} from "./formats/schema";
export {
  assetSchema,
  citationSchema,
  type ConversationAsset,
  type ConversationCitation,
} from "./formats/schema";
export type RichMessage = {
  content: string;
  assets?: ConversationAsset[];
  citations?: ConversationCitation[];
};

/** Keep visible multimodal content and the metadata needed to resolve it. */
export function richMessage(value: unknown, metadata?: unknown): RichMessage {
  const assets: ConversationAsset[] = [];
  const citations: ConversationCitation[] = [];
  function read(value: unknown, depth = 0): string {
    if (depth > 100) throw new Error("Imported content nesting is too deep.");
    if (typeof value === "string") return value;
    if (Array.isArray(value))
      return value
        .map((value) => read(value, depth + 1))
        .filter(Boolean)
        .join("\n\n");
    const block = asObject(value);
    if (!block) return "";
    const type = string(block.type ?? block.content_type);
    if (hiddenContent(block)) return "";
    if (
      /^(audio_transcription|input_audio_transcription|transcription)$/.test(
        type,
      )
    )
      return read(block.text ?? block.transcript ?? block.content, depth + 1);
    const media = importedMedia(block);
    if (media) {
      const { kind, name } = media;
      const index = assets.push(media) - 1;
      const rendered =
        kind === "image"
          ? `![${name.replace(/[\[\]\\]/g, "")}](#asset-${index})`
          : `[${name.replace(/[\[\]\\]/g, "")}](#asset-${index})`;
      const transcript = string(block.transcript ?? block.transcription);
      return transcript ? `${rendered}\n\n${transcript}` : rendered;
    }
    const notebook = notebookOutput(block);
    if (notebook !== null) return notebook;
    if (type === "AdaptiveCard") {
      registerCardImages(block, assets);
      return fence(JSON.stringify(block), "card-preview");
    }
    if (type === "resource") {
      const resource = asObject(block.resource);
      const mime = string(resource?.mimeType);
      if (
        resource &&
        /^(text\/html;profile=mcp-app|text\/html\+skybridge)$/.test(mime)
      )
        return fence(
          JSON.stringify({
            template: string(resource.text),
            mime,
            structuredContent:
              block.structuredContent ?? resource.structuredContent ?? null,
          }),
          "mcp-preview",
        );
    }
    const chart = chartMime(block);
    if (chart)
      return fence(
        JSON.stringify({
          data: { [chart]: block.data ?? block.spec ?? block.content },
          metadata: block.metadata ?? {},
        }),
        "notebook-preview",
      );
    if (type === "code")
      return fence(
        string(block.code ?? block.text ?? block.content),
        string(block.language) || "text",
      );
    if (type === "math" || type === "equation")
      return `$$\n${string(block.latex ?? block.text ?? block.content)}\n$$`;
    if (type === "table" && Array.isArray(block.rows)) {
      const cell = (value: unknown) => formatTableCell(string(value));
      const rows = block.rows
        .filter(Array.isArray)
        .map((row) =>
          row.map((value) =>
            cell(typeof value === "number" ? String(value) : value),
          ),
        );
      const header = Array.isArray(block.columns)
        ? block.columns.map(cell)
        : rows.shift();
      return header
        ? [header, header.map(() => "---"), ...rows]
            .map((row) => `| ${row.join(" | ")} |`)
            .join("\n")
        : "";
    }
    if (
      type === "artifact" ||
      type === "render" ||
      type === "svg" ||
      type === "html" ||
      type === "mermaid"
    ) {
      const mime = string(
        block.mime_type ?? block.artifact_type ?? block.language ?? type,
      );
      const language =
        previewKind(mime) ??
        (/svg/.test(mime)
          ? "svg-preview"
          : /html/.test(mime)
            ? "html-preview"
            : /mermaid/.test(mime)
              ? "mermaid"
              : string(block.language) || "text");
      if (language === "mcp-preview")
        return fence(
          JSON.stringify({
            template: string(block.content ?? block.text),
            mime,
            structuredContent: block.structuredContent ?? null,
          }),
          language,
        );
      return fence(string(block.content ?? block.text ?? block.code), language);
    }
    const body = block.parts ?? block.text ?? block.content;
    if (body !== undefined)
      return read(body, depth + 1) + citationLinks(block, citations);
    if (
      block.thoughtSignature !== undefined ||
      block.thought_signature !== undefined
    )
      return "";
    return type ? fence(JSON.stringify(block, null, 2), "json") : "";
  }
  const content = read(value);
  const meta = asObject(metadata);
  const groups = Array.isArray(meta?.search_result_groups)
    ? meta.search_result_groups
    : [];
  for (const group of groups) {
    const entries = asObject(group)?.entries;
    for (const value of Array.isArray(entries) ? entries : []) {
      const entry = asObject(value);
      const id = asObject(entry?.ref_id);
      const ref =
        typeof entry?.ref_id === "string"
          ? entry.ref_id
          : id
            ? `turn${id.turn_index}${id.ref_type}${id.ref_index}`
            : "";
      const parsed = citationSchema.safeParse({
        ref,
        title: entry?.title,
        url: entry?.url,
      });
      if (ref && parsed.success) citations.push(parsed.data);
    }
  }
  const components = Array.isArray(meta?.genui_components)
    ? meta.genui_components
    : [];
  const imageTags = [...content.matchAll(/<AsyncImage\b[^>]*>/g)].map(
    (match) => match[0],
  );
  let imageIndex = 0;
  for (const value of components) {
    const component = asObject(value);
    const urls = (
      Array.isArray(component?.safe_urls) ? component.safe_urls : []
    )
      .map((value) => http(asObject(value)?.url ?? value))
      .filter((value): value is string => Boolean(value));
    const entities = (
      Array.isArray(component?.entities) ? component.entities : []
    ).map(asObject);
    if (component?.type === "async_image") {
      const start = component.start_index;
      const end = component.end_index;
      const candidate =
        typeof start === "number" && typeof end === "number"
          ? content.slice(start, end)
          : "";
      const tag = candidate.startsWith("<AsyncImage")
        ? candidate
        : (imageTags[imageIndex] ?? "");
      imageIndex++;
      const ref =
        entities.find((entry) => entry?.entity_type === "image")?.ref ??
        /\b(?:ref|query)="([^"]*)"/.exec(tag)?.[1];
      const url =
        urls.find(
          (url) =>
            /^https:\/\/images\.openai\.com\//.test(url) &&
            url.includes("purpose=fullsize"),
        ) ?? urls.find((url) => /\.(png|jpe?g|webp|gif)(?:\?|$)/i.test(url));
      assets.push({
        kind: "image",
        name: "Conversation image",
        ref: string(ref) || undefined,
        url,
      });
    }
    if (component?.type === "cite") {
      entities.forEach((entity, index) => {
        const ref = string(entity?.ref);
        const url = urls[index];
        if (ref && url && !citations.some((citation) => citation.ref === ref))
          citations.push({ ref, url, title: new URL(url).hostname });
      });
    }
  }
  return {
    content,
    ...(assets.length ? { assets } : {}),
    ...(citations.length ? { citations } : {}),
  };
}
