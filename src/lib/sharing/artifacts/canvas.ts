import { assertSlug } from "../../library/slug";
import { withoutCanvasUsers } from "../../canvas/snapshot";
import { readCanvasAsset } from "../../canvas/assets";
import { CanvasError } from "../../canvas/errors";
import {
  MAX_SHARED_ASSETS_BYTES,
  portableAssetNameSchema,
  validateCanvasMedia,
  canvasMediaType,
} from "../../canvas/media";
import {
  validateSharedCanvas,
  type CanvasDocument,
} from "../../canvas/validation";

function assetPrefix(topic: string, slug: string): string {
  assertSlug(topic);
  assertSlug(slug);
  return `/api/v1/papers/${topic}/${slug}/canvas/assets/`;
}

/** Resolve only this paper's explicitly referenced uploads. Never fetch URLs. */
export function packageCanvas(
  value: unknown,
  directory: string,
  topic: string,
  slug: string,
) {
  const assets: Record<string, string> = {};
  const sourceNames: Record<string, string> = {};
  let total = 0;
  const prefix = assetPrefix(topic, slug);
  const canvas = validateSharedCanvas(withoutCanvasUsers(value), (source) => {
    if (!source.startsWith(prefix))
      throw new CanvasError(
        "Shared canvas media must be uploaded to this paper.",
        422,
      );
    const original = source.slice(prefix.length);
    const asset = readCanvasAsset(directory, original, true);
    if (!(asset.name in assets)) {
      total += asset.bytes.byteLength;
      if (total > MAX_SHARED_ASSETS_BYTES)
        throw new CanvasError(
          "Canvas media exceeds the 32 MB sharing limit.",
          413,
        );
      assets[asset.name] = asset.bytes.toString("base64");
      sourceNames[asset.name] = original;
    }
    return `/canvas-assets/${asset.name}`;
  });
  return { canvas, assets, sourceNames };
}

export function validatePortableCanvas(
  value: unknown,
  assets: Record<string, string>,
): CanvasDocument | null {
  const used = new Set<string>();
  let total = 0;
  const canvas = validateSharedCanvas(value, (source) => {
    if (!source.startsWith("/canvas-assets/"))
      throw new CanvasError("Shared canvas media has an invalid address.", 422);
    const name = portableAssetNameSchema.parse(source.slice(15));
    const encoded = assets[name];
    if (encoded === undefined)
      throw new CanvasError("Shared canvas media is missing.", 422);
    if (!used.has(name)) {
      const bytes = Buffer.from(encoded, "base64");
      if (validateCanvasMedia(bytes, canvasMediaType(name), true) !== name)
        throw new CanvasError(
          "Shared canvas media has an invalid digest.",
          422,
        );
      total += bytes.byteLength;
      if (total > MAX_SHARED_ASSETS_BYTES)
        throw new CanvasError(
          "Canvas media exceeds the 32 MB sharing limit.",
          413,
        );
      used.add(name);
    }
    return source;
  });
  if (used.size !== Object.keys(assets).length)
    throw new CanvasError("Only referenced canvas media can be shared.", 422);
  return canvas;
}

/** Rewrite validated portable addresses to fixed local routes only. */
export function localizeCanvas(
  canvas: CanvasDocument | null,
  topic: string,
  slug: string,
  sourceNames: Record<string, string> = {},
): CanvasDocument | null {
  if (!canvas) return null;
  const next = structuredClone(canvas);
  const prefix = assetPrefix(topic, slug);
  for (const record of Object.values(next.store)) {
    if (record.typeName !== "asset" || record.type === "bookmark") continue;
    const source = record.props.src;
    if (!source?.startsWith("/canvas-assets/"))
      throw new CanvasError("Shared canvas media has an invalid address.", 422);
    const name = portableAssetNameSchema.parse(source.slice(15));
    record.props.src = prefix + (sourceNames[name] ?? name);
  }
  return next;
}
