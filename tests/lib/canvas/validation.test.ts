import { createTLSchema, type TLStoreSnapshot } from "@tldraw/tlschema";
import { describe, expect, it } from "vitest";
import { attributeCanvas, validateSharedCanvas } from "@/lib/canvas/validation";

const schema = createTLSchema();
function canvas(): TLStoreSnapshot {
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
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "A shared note" }],
          },
        ],
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
function textShape(document: TLStoreSnapshot) {
  const record = Object.values(document.store).find(
    (entry) => entry.typeName === "shape" && entry.type === "text",
  );
  if (!record || record.typeName !== "shape" || record.type !== "text")
    throw new Error("Text fixture missing");
  return record;
}
const identity = (source: string) => source;

describe("portable canvas validation", () => {
  it("accepts nested frames and groups while rejecting cyclic containers", () => {
    const document = canvas();
    const note = textShape(document);
    const frame = schema.types.shape.create({
      id: schema.types.shape.createId("frame"),
      type: "frame",
      index: "a2",
      parentId: note.parentId,
      props: { w: 500, h: 500, name: "Study group", color: "black" },
    });
    const group = schema.types.shape.create({
      id: schema.types.shape.createId("group"),
      type: "group",
      index: "a1",
      parentId: frame.id,
      props: {},
    });
    if (frame.typeName !== "shape" || group.typeName !== "shape")
      throw new Error("Container fixture missing");
    note.parentId = group.id;
    document.store[frame.id] = frame;
    document.store[group.id] = group;
    expect(
      validateSharedCanvas(document, identity)?.store[note.id],
    ).toBeDefined();
    group.parentId = note.id;
    expect(() => validateSharedCanvas(document, identity)).toThrow(
      /relationships/,
    );
  });

  it("accepts valid arrow bindings and rejects self, arrow, foreign page and duplicate terminal bindings", () => {
    const document = canvas();
    const note = textShape(document);
    const arrow = schema.types.shape.create({
      id: schema.types.shape.createId("arrow"),
      type: "arrow",
      index: "a2",
      parentId: note.parentId,
      props: {
        kind: "arc",
        elbowMidPoint: 0.5,
        dash: "draw",
        size: "m",
        fill: "none",
        color: "black",
        labelColor: "black",
        bend: 0,
        start: { x: 0, y: 0 },
        end: { x: 200, y: 100 },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
        richText: { type: "doc", content: [{ type: "paragraph" }] },
        labelPosition: 0.5,
        font: "draw",
        scale: 1,
      },
    });
    const binding = schema.types.binding.create({
      id: schema.types.binding.createId("arrow"),
      type: "arrow",
      fromId: arrow.id,
      toId: note.id,
      props: {
        terminal: "end",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    });
    if (arrow.typeName !== "shape" || binding.typeName !== "binding")
      throw new Error("Arrow fixture missing");
    document.store[arrow.id] = arrow;
    document.store[binding.id] = binding;
    expect(
      validateSharedCanvas(document, identity)?.store[binding.id],
    ).toBeDefined();
    const self = structuredClone(document);
    const selfBinding = self.store[binding.id];
    if (selfBinding.typeName !== "binding")
      throw new Error("Binding fixture missing");
    selfBinding.toId = arrow.id;
    expect(() => validateSharedCanvas(self, identity)).toThrow(/bindings/);
    const text = structuredClone(document);
    const textBinding = text.store[binding.id];
    if (textBinding.typeName !== "binding")
      throw new Error("Binding fixture missing");
    textBinding.fromId = note.id;
    expect(() => validateSharedCanvas(text, identity)).toThrow(/bindings/);
    const duplicate = structuredClone(document);
    const second = schema.types.binding.create({
      ...binding,
      id: schema.types.binding.createId("duplicate"),
    });
    duplicate.store[second.id] = second;
    expect(() => validateSharedCanvas(duplicate, identity)).toThrow(/bindings/);
    const foreign = structuredClone(document);
    const page = schema.types.page.create({
      id: schema.types.page.createId("other"),
      name: "Other",
      index: "a2",
    });
    if (page.typeName !== "page") throw new Error("Page fixture missing");
    foreign.store[page.id] = page;
    textShape(foreign).parentId = page.id;
    expect(() => validateSharedCanvas(foreign, identity)).toThrow(/bindings/);
  });
  it("preserves normal notes and stamps authenticated contributors", () => {
    const first = attributeCanvas(
      validateSharedCanvas(canvas(), identity)!,
      null,
      { id: "profile:ana", name: "Ana" },
    );
    expect(textShape(first).props.richText.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "A shared note" }] },
    ]);
    expect(textShape(first).meta.papernookCreatedByName).toBe("Ana");
    const changed = structuredClone(first);
    const note = textShape(changed);
    note.props.richText.content = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "A collaborator's revision" }],
      },
    ];
    note.meta.papernookCreatedByName = "Forged owner";
    const saved = attributeCanvas(
      validateSharedCanvas(changed, identity)!,
      first,
      { id: "participant:1111111111111111", name: "Maya" },
    );
    expect(textShape(saved).meta).toMatchObject({
      papernookCreatedByName: "Ana",
      papernookUpdatedByName: "Maya",
    });
    expect(textShape(saved).props.richText.content).toContainEqual({
      type: "paragraph",
      content: [{ type: "text", text: "A collaborator's revision" }],
    });
  });
  it("ignores forged attribution on otherwise unchanged records", () => {
    const first = attributeCanvas(canvas(), null, {
      id: "profile:ana",
      name: "Ana",
    });
    const forged = structuredClone(first);
    textShape(forged).meta.papernookUpdatedByName = "Someone else";
    const saved = attributeCanvas(forged, first, {
      id: "participant:1111111111111111",
      name: "Maya",
    });
    expect(textShape(saved).meta).toEqual(textShape(first).meta);
  });
  it.each([
    {
      type: "paragraph",
      attrs: { style: "background:url(javascript:alert(1))" },
    },
    {
      type: "text",
      text: "link",
      marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
    },
    {
      type: "text",
      text: "link",
      marks: [
        {
          type: "link",
          attrs: { href: "https://example.org", onclick: "alert(1)" },
        },
      ],
    },
    { type: "html", text: "<script>alert(1)</script>" },
    { type: "image", attrs: { src: "/api/v1/profiles" } },
  ])("rejects executable or unknown rich-text content %#", (content) => {
    const document = canvas();
    textShape(document).props.richText.content = [content];
    expect(() => validateSharedCanvas(document, identity)).toThrow(
      /unsafe|unsupported/,
    );
  });
  it("keeps links click-only and forces safe window attributes", () => {
    const document = canvas();
    textShape(document).props.richText.content = [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Source",
            marks: [
              {
                type: "link",
                attrs: {
                  href: "https://example.org/paper",
                  rel: null,
                  target: null,
                  class: null,
                },
              },
            ],
          },
        ],
      },
    ];
    const saved = validateSharedCanvas(document, identity)!;
    expect(JSON.stringify(textShape(saved).props.richText)).toContain(
      '"rel":"noopener noreferrer"',
    );
    expect(JSON.stringify(textShape(saved).props.richText)).toContain(
      '"target":"_blank"',
    );
  });
  it("rejects private session records, malformed records, and cyclic parents", () => {
    const original = canvas();
    const session = {
      ...original,
      store: {
        ...original.store,
        "user:secret": {
          id: "user:secret",
          typeName: "user",
          secret: "PRIVATE_SESSION",
        },
      },
    };
    expect(() => validateSharedCanvas(session, identity)).toThrow(
      /Session|invalid/,
    );
    const malformed = canvas();
    const note = textShape(malformed);
    note.props.w = Number.NaN;
    expect(() => validateSharedCanvas(malformed, identity)).toThrow();
    const cycle = canvas();
    textShape(cycle).parentId = textShape(cycle).id;
    expect(() => validateSharedCanvas(cycle, identity)).toThrow(/parent/);
  });
  it("drops unreferenced media and rejects automatic external loads", () => {
    const document = canvas();
    const asset = schema.types.asset.create({
      id: schema.types.asset.createId("media"),
      type: "image",
      props: {
        w: 10,
        h: 10,
        name: "image.png",
        isAnimated: false,
        mimeType: "image/png",
        src: "https://attacker.example/secret.png",
      },
    });
    document.store[asset.id] = asset;
    expect(
      Object.values(validateSharedCanvas(document, identity)!.store).some(
        (record) => record.typeName === "asset",
      ),
    ).toBe(false);
    const image = schema.types.shape.create({
      id: schema.types.shape.createId("image"),
      type: "image",
      parentId: textShape(document).parentId,
      index: "a2",
      props: {
        w: 10,
        h: 10,
        assetId: asset.id,
        playing: true,
        url: "",
        crop: null,
        flipX: false,
        flipY: false,
        altText: "",
      },
    });
    document.store[image.id] = image;
    expect(() => validateSharedCanvas(document, identity)).toThrow(
      /content addresses/,
    );
    const portable = `/canvas-assets/${"a".repeat(64)}.png`;
    const saved = validateSharedCanvas(document, () => portable)!;
    expect(
      Object.values(saved.store).find((record) => record.typeName === "asset")
        ?.props.src,
    ).toBe(portable);
  });
  it("rejects prototype keys and excessive nesting before migrations", () => {
    const document = canvas();
    const malicious = JSON.parse(
      JSON.stringify(document).replace(
        '"meta":{}',
        '"meta":{"__proto__":{"polluted":true}}',
      ),
    );
    expect(() => validateSharedCanvas(malicious, identity)).toThrow();
    let nested: unknown = "x";
    for (let index = 0; index < 40; index++) nested = { nested };
    expect(() => validateSharedCanvas({ document: nested }, identity)).toThrow(
      /complex/,
    );
  });
});
