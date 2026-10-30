import { z } from "zod";

export const MAX_BUNDLE_BYTES = 150 * 1024 * 1024;
export const MAX_CHAT_BYTES = 8 * 1024 * 1024;
export const sharingStatusSchema = z
  .object({ error: z.string().max(300).nullable(), at: z.string().datetime() })
  .strict();
export const secretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const idSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{C}]+$/u);
const imageNameSchema = z
  .string()
  .regex(/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/);
export const base64Schema = z
  .string()
  .refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    "Invalid base64 payload.",
  );
export const revisionSchema = z.string().regex(/^"[a-f0-9]{64}"$/);

export const conversationSchema = z
  .object({
    header: z
      .object({
        id: idSchema,
        title: z.string().max(500),
        titleSource: z
          .enum(["placeholder", "generated", "manual"])
          .default("manual"),
        username: slugSchema,
        createdAt: z.string().datetime(),
      })
      .strict(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().max(2 * 1024 * 1024),
            images: z
              .array(
                z
                  .string()
                  .regex(/^crops\/[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/),
              )
              .max(10)
              .optional(),
            at: z.string().datetime(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const assetsSchema = z
  .record(imageNameSchema, base64Schema)
  .refine((assets) => Object.keys(assets).length <= 100);
export const publishedThreadSchema = z
  .object({
    id: idSchema,
    actorId: idSchema,
    author: labelSchema,
    revision: revisionSchema,
    chat: conversationSchema,
    assets: assetsSchema,
  })
  .strict();
export type PublishedThread = z.infer<typeof publishedThreadSchema>;

export const bundleSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["fork", "collaborate"]),
    slug: slugSchema,
    meta: z
      .object({
        title: z.string().max(2000),
        authors: z.array(z.string().max(500)).max(200),
        year: z.number().int().min(0).max(9999).nullable(),
        venue: z.string().max(2000).nullable(),
        arxivId: z.string().max(100).nullable(),
        bibtex: z.string().max(100_000).nullable(),
        tags: z.array(z.string().max(100)).max(100),
        sourceUrl: z.string().max(4000),
      })
      .strict(),
    summary: z
      .string()
      .max(2 * 1024 * 1024)
      .nullable(),
    text: z
      .string()
      .max(10 * 1024 * 1024)
      .nullable(),
    pdf: base64Schema,
    etag: revisionSchema,
    conversations: z.array(publishedThreadSchema).max(100),
  })
  .strict();
export type PaperBundle = z.infer<typeof bundleSchema>;

export class SharingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function sharingFailure(error: unknown): Response {
  if (error instanceof SharingError)
    return Response.json(
      { error: error.message },
      {
        status: error.status,
        headers: { "cache-control": "private, no-store" },
      },
    );
  return Response.json(
    { error: "Sharing is temporarily unavailable." },
    { status: 503, headers: { "cache-control": "private, no-store" } },
  );
}
