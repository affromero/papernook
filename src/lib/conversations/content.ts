import { z } from "zod";
import { imageMime } from "./images";
import { formatTableCell } from "@/lib/chat/format/table";

const publicUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value));
export const assetSchema = z.object({
  kind: z.enum(["image", "audio", "video", "file"]),
  name: z.string().max(1000),
  ref: z.string().max(2000).optional(),
  url: publicUrl.optional(),
  data: z
    .string()
    .max(6_000_000)
    .regex(/^data:[\w.+/-]+;base64,[A-Za-z0-9+/]*={0,2}$/)
    .optional(),
  mime: z.string().max(100).optional(),
});
export const citationSchema = z.object({
  ref: z.string().max(200),
  title: z.string().max(1000),
  url: publicUrl,
});
export type ConversationAsset = z.infer<typeof assetSchema>;
export type ConversationCitation = z.infer<typeof citationSchema>;
export type RichMessage = {
  content: string;
  assets?: ConversationAsset[];
  citations?: ConversationCitation[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function http(value: unknown): string | undefined {
  return typeof value === "string" && publicUrl.safeParse(value).success
    ? value
    : undefined;
}
function fence(text: string, language: string): string {
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  const marker = "`".repeat(Math.max(3, ...runs.map((length) => length + 1)));
  return `${marker}${language.replace(/[^\w+-]/g, "")}\n${text}\n${marker}`;
}

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
    if (
      /^(thinking|redacted_thinking|redacted_reasoning|thoughts|reasoning|reasoning_recap|analysis|model_editable_context|tool_use|tool_result|tool_call|tool_request|tool_response|function_call|function_call_output)$/.test(
        type,
      )
    )
      return "";
    if (
      /^(audio_transcription|input_audio_transcription|transcription)$/.test(
        type,
      )
    )
      return read(block.text ?? block.transcript ?? block.content, depth + 1);
    if (
      /^(image|image_url|image_asset_pointer|input_image|output_image|file|input_file|document|attachment|audio|input_audio|output_audio|video)(_|$)/.test(
        type,
      )
    ) {
      const source =
        asObject(block.source) ??
        asObject(block.image_url) ??
        asObject(block.input_audio) ??
        asObject(block.file) ??
        block;
      const urlValue =
        block.url ??
        (typeof block.image_url === "string" ? block.image_url : source.url) ??
        source.file_url ??
        source.download_url ??
        block.file_url ??
        block.download_url ??
        source.file_data ??
        block.file_data ??
        block.asset_pointer;
      const format = string(
        source.format ?? block.format ?? block.output_format,
      );
      const data = string(
        source.data ?? block.data ?? block.b64_json ?? block.result,
      );
      const mime =
        string(source.media_type ?? source.mime_type ?? block.mime_type) ||
        (/image/.test(type) && /^(png|jpe?g|webp|gif)$/.test(format)
          ? `image/${format === "jpg" ? "jpeg" : format}`
          : "") ||
        (/image/.test(type) && data
          ? imageMime(Buffer.from(data, "base64"))
          : "") ||
        (/audio/.test(type) && format
          ? `audio/${format === "mp3" ? "mpeg" : format}`
          : "") ||
        (typeof source.file_data === "string"
          ? (/^data:([^;]+);/.exec(source.file_data)?.[1] ?? "")
          : "");
      const dataUrl =
        typeof urlValue === "string" && urlValue.startsWith("data:")
          ? urlValue
          : data
            ? `data:${mime || "application/octet-stream"};base64,${source.type === "text" ? Buffer.from(data).toString("base64") : data}`
            : undefined;
      const kind = /image/.test(type)
        ? "image"
        : /audio/.test(type)
          ? "audio"
          : /video/.test(type)
            ? "video"
            : "file";
      const name =
        string(
          block.name ??
            source.filename ??
            source.file_name ??
            block.filename ??
            block.file_name ??
            block.alt ??
            block.title,
        ) || `${kind[0].toUpperCase()}${kind.slice(1)} attachment`;
      const candidate = assetSchema.safeParse({
        kind,
        name,
        url: http(urlValue),
        data: dataUrl,
        mime: mime || undefined,
        ref:
          string(block.asset_pointer ?? block.file_id ?? source.file_id) ||
          undefined,
      });
      if (!candidate.success)
        throw new Error("Invalid imported attachment metadata.");
      const index = assets.push(candidate.data) - 1;
      const rendered =
        kind === "image"
          ? `![${name.replace(/[\[\]\\]/g, "")}](#asset-${index})`
          : `[${name.replace(/[\[\]\\]/g, "")}](#asset-${index})`;
      const transcript = string(block.transcript ?? block.transcription);
      return transcript ? `${rendered}\n\n${transcript}` : rendered;
    }
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
      const language = /svg/.test(mime)
        ? "svg-preview"
        : /html/.test(mime)
          ? "html-preview"
          : /mermaid/.test(mime)
            ? "mermaid"
            : string(block.language) || "text";
      return fence(string(block.content ?? block.text ?? block.code), language);
    }
    const body = block.parts ?? block.text ?? block.content;
    if (body !== undefined) return read(body, depth + 1);
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
