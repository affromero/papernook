import { z } from "zod";
import {
  base64Schema,
  revisionSchema,
  labelSchema,
  SharingError,
} from "./protocol/values";
import { artifactSnapshotSchema } from "./artifacts/schema";
import { CanvasError } from "../canvas/errors";
import { ExerciseError } from "../library/exercises/schema";
import { RequestBodyError } from "../bounded-request";
import { isAccessError } from "thesidedoor-core/access";
import { accessErrorStatus } from "thesidedoor-core/access/http";
export {
  base64Schema,
  revisionSchema,
  MAX_BUNDLE_BYTES,
  MAX_CHAT_BYTES,
  SharingError,
  labelSchema,
} from "./protocol/values";

export const sharingStatusSchema = z
  .object({ error: z.string().max(300).nullable(), at: z.string().datetime() })
  .strict();
export const secretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const idSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const imageNameSchema = z
  .string()
  .regex(/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/);

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
    artifacts: artifactSnapshotSchema,
  })
  .strict();
export type PaperBundle = z.infer<typeof bundleSchema>;

export function sharingFailure(error: unknown): Response {
  if (isAccessError(error)) {
    return Response.json(
      { error: error.message, code: error.code },
      {
        status: accessErrorStatus(error),
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
  if (
    error instanceof SharingError ||
    error instanceof CanvasError ||
    error instanceof ExerciseError ||
    error instanceof RequestBodyError
  )
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
