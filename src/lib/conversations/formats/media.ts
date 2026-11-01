import { imageMime } from "../images";
import { displayChildren } from "./cards";
import {
  assetSchema,
  object,
  text,
  http,
  type ConversationAsset,
} from "./schema";

export function registerCardImages(
  card: unknown,
  assets: ConversationAsset[],
): void {
  let count = 0;
  function visit(value: unknown, depth = 0): void {
    if (++count > 2000 || depth > 30)
      throw new Error("Card exceeds the display limit.");
    const node = object(value);
    if (!node) return;
    if (node.type === "Image") {
      const url = text(node.url);
      if (
        !assets.some(
          (asset) =>
            asset.kind === "image" && (asset.url === url || asset.data === url),
        )
      ) {
        const asset = importedMedia({
          type: "image",
          url,
          name: text(node.altText) || "Card image",
        });
        if (asset) assets.push(asset);
      }
    }
    for (const child of displayChildren(node)) visit(child, depth + 1);
  }
  visit(card);
}

/** Normalize declared bytes and locations without inventing provider download URLs. */
export function importedMedia(
  block: Record<string, unknown>,
): ConversationAsset | null {
  const declared = text(block.type ?? block.content_type);
  const inline = object(block.inlineData ?? block.inline_data);
  const file = object(block.fileData ?? block.file_data);
  if (
    !inline &&
    !file &&
    !/^(image|image_url|image_asset_pointer|input_image|output_image|file|input_file|document|attachment|audio|input_audio|output_audio|video)(_|$)/.test(
      declared,
    )
  )
    return null;
  const source =
    inline ??
    file ??
    object(block.source) ??
    object(block.image_url) ??
    object(block.input_audio) ??
    object(block.file) ??
    block;
  const url =
    block.url ??
    (typeof block.image_url === "string" ? block.image_url : source.url) ??
    source.uri ??
    source.fileUri ??
    source.file_uri ??
    source.file_url ??
    source.download_url ??
    block.file_url ??
    block.download_url ??
    source.file_data ??
    block.file_data ??
    block.asset_pointer;
  const format = text(source.format ?? block.format ?? block.output_format);
  const data = text(
    source.data ?? block.data ?? block.b64_json ?? block.result,
  );
  const declaredMime = text(
    source.media_type ??
      source.mimeType ??
      source.mime_type ??
      block.mime_type ??
      block.mimeType,
  );
  const mime =
    declaredMime ||
    (/image/.test(declared) && /^(png|jpe?g|webp|gif)$/.test(format)
      ? `image/${format === "jpg" ? "jpeg" : format}`
      : "") ||
    (/image/.test(declared) && data
      ? imageMime(Buffer.from(data, "base64"))
      : "") ||
    (/audio/.test(declared) && format
      ? `audio/${format === "mp3" ? "mpeg" : format}`
      : "") ||
    (typeof source.file_data === "string"
      ? (/^data:([^;]+);/.exec(source.file_data)?.[1] ?? "")
      : "");
  const baseMime = mime.split(";")[0].trim().toLowerCase();
  const rawAudio =
    /^audio\/(l16|l24|pcm|pcm16|raw)$/.test(baseMime) || format === "pcm16";
  const kind = rawAudio
    ? "file"
    : inline || file
      ? /^image\//.test(baseMime)
        ? "image"
        : /^audio\//.test(baseMime)
          ? "audio"
          : /^video\//.test(baseMime)
            ? "video"
            : "file"
      : /image/.test(declared)
        ? "image"
        : /audio/.test(declared)
          ? "audio"
          : /video/.test(declared)
            ? "video"
            : "file";
  const name =
    text(
      block.name ??
        source.filename ??
        source.file_name ??
        block.filename ??
        block.file_name ??
        block.alt ??
        block.title,
    ) ||
    (rawAudio
      ? "Raw PCM audio (download; playback format must be specified)"
      : `${kind[0].toUpperCase()}${kind.slice(1)} attachment`);
  const dataUrl =
    typeof url === "string" && url.startsWith("data:")
      ? url
      : data
        ? `data:${rawAudio ? "application/octet-stream" : baseMime || "application/octet-stream"};base64,${source.type === "text" ? Buffer.from(data).toString("base64") : data}`
        : undefined;
  const candidate = assetSchema.safeParse({
    kind,
    name,
    url: http(url),
    data: dataUrl,
    mime: mime || undefined,
    ref:
      text(
        block.asset_pointer ??
          block.file_id ??
          source.file_id ??
          (typeof url === "string" && !http(url) && !url.startsWith("data:")
            ? url
            : ""),
      ) || undefined,
  });
  if (!candidate.success)
    throw new Error("Invalid imported attachment metadata.");
  return candidate.data;
}
