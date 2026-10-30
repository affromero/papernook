import { createTLSchema, type TLStoreSnapshot } from "@tldraw/tlschema";

export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i0AAAAASUVORK5CYII=",
  "base64",
);
const schema = createTLSchema();
export function canvas(text = "A shared note"): TLStoreSnapshot {
  const document = schema.types.document.create({
    id: schema.types.document.createId("document"),
    name: "Shared notes",
  });
  const page = schema.types.page.create({
    id: schema.types.page.createId("main"),
    name: "Page 1",
    index: "a1",
  });
  const shape = schema.types.shape.create({
    id: schema.types.shape.createId("note"),
    type: "text",
    index: "a1",
    parentId: page.id,
    props: {
      color: "black",
      size: "m",
      font: "draw",
      textAlign: "start",
      w: 200,
      richText: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      scale: 1,
      autoSize: true,
    },
  });
  return {
    schema: schema.serialize(),
    store: { [document.id]: document, [page.id]: page, [shape.id]: shape },
  };
}
export function imageCanvas(source: string): TLStoreSnapshot {
  const value = canvas();
  const asset = schema.types.asset.create({
    id: schema.types.asset.createId("image"),
    type: "image",
    props: {
      name: "Uploaded image",
      src: source,
      w: 1,
      h: 1,
      mimeType: "image/png",
      isAnimated: false,
    },
  });
  const shape = schema.types.shape.create({
    id: schema.types.shape.createId("image"),
    type: "image",
    index: "a2",
    parentId: schema.types.page.createId("main"),
    props: {
      assetId: asset.id,
      w: 100,
      h: 100,
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: "",
    },
  });
  value.store[asset.id] = asset;
  value.store[shape.id] = shape;
  return value;
}
