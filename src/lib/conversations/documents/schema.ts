import { z } from "zod";

const blockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(500_000) }),
  z.object({
    kind: z.literal("table"),
    rows: z.array(z.array(z.string().max(20_000)).max(200)).max(2000),
  }),
  z.object({
    kind: z.literal("image"),
    source: z.string().max(3_000_000),
    name: z.string().max(1000),
  }),
]);
export const documentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pdf") }),
  z.object({ kind: z.literal("notebook"), content: z.string().max(500_000) }),
  z.object({
    kind: z.literal("artifact"),
    format: z.enum(["html-preview", "svg-preview"]),
    content: z.string().max(500_000),
  }),
  z.object({
    kind: z.literal("document"),
    sections: z
      .array(
        z.object({
          title: z.string().max(1000),
          blocks: z.array(blockSchema).max(5000),
        }),
      )
      .max(200),
    notice: z.string().max(1000).optional(),
  }),
]);
export type DocumentPreview = z.infer<typeof documentSchema>;
export const previewResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), document: documentSchema }),
  z.object({ ok: z.literal(false), error: z.string().max(1000) }),
]);
