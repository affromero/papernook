import { z } from "zod";
import DecodeStream from "pdf-lib/cjs/core/streams/DecodeStream";
import { applyCollaborativeAnnotations } from "./annotations";
import { base64Schema, labelSchema, SharingError } from "./protocol/values";
import {
  pdfCommentActionSchema,
  updatePdfComment,
  PdfCommentError,
} from "../library/pdf/comments";
import {
  renderExerciseDocument,
  ExerciseRenderError,
} from "../library/exercises/render";

const descriptor = Object.getOwnPropertyDescriptor(
  DecodeStream.prototype,
  "ensureBuffer",
);
const original: unknown = descriptor?.value;
if (typeof original !== "function")
  throw new Error("The PDF decompression budget could not be installed.");
const allocate = original as (
  this: DecodeStream,
  requested: number,
) => Uint8Array;
const allocations = new WeakMap<DecodeStream, number>();
let allocatedBytes = 0;
let decodingRejected = false;
// Keep the canonical decompressor, but reject oversized allocations before it runs.
Object.defineProperty(DecodeStream.prototype, "ensureBuffer", {
  ...descriptor,
  value: function (this: DecodeStream, requested: number): Uint8Array {
    const reject = () => {
      decodingRejected = true;
      throw new SharingError("The PDF exceeds the decompression budget.", 413);
    };
    if (
      decodingRejected ||
      !Number.isSafeInteger(requested) ||
      requested < 0 ||
      requested > 16 * 1024 * 1024
    )
      return reject();
    let capacity = 512;
    const minimum: unknown = Reflect.get(this, "minBufferLength");
    if (
      typeof minimum !== "number" ||
      !Number.isSafeInteger(minimum) ||
      minimum < 0 ||
      minimum > 16 * 1024 * 1024
    )
      return reject();
    capacity = Math.max(capacity, minimum);
    while (capacity < requested) capacity *= 2;
    if (capacity > (allocations.get(this) ?? 0)) {
      allocatedBytes += capacity;
      if (allocatedBytes > 128 * 1024 * 1024) return reject();
      allocations.set(this, capacity);
    }
    return allocate.call(this, requested);
  },
});

const baseSchema = z
  .object({
    current: base64Schema,
    actor: z.object({ id: z.string().max(100), name: labelSchema }).strict(),
  })
  .strict();
const inputSchema = z.discriminatedUnion("action", [
  baseSchema.extend({
    action: z.literal("annotations"),
    proposed: base64Schema,
    owner: z.boolean(),
  }),
  baseSchema.extend({
    action: z.literal("comment"),
    comment: pdfCommentActionSchema,
  }),
  z
    .object({
      action: z.literal("exercises"),
      current: base64Schema,
      title: z.string().max(2000),
      entries: z
        .array(
          z
            .object({
              operationId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
              markdown: z.string().min(1).max(100_000),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
]);
const chunks: Buffer[] = [];
let size = 0;
process.stdin.on("data", (chunk: Buffer) => {
  size += chunk.byteLength;
  if (size > 90 * 1024 * 1024) process.exit(1);
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  void (async () => {
    try {
      const input = inputSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const pdf =
        input.action === "exercises"
          ? await renderExerciseDocument(
              input.title,
              input.entries,
              input.current ? Buffer.from(input.current, "base64") : undefined,
            )
          : input.action === "comment"
            ? await updatePdfComment(
                Buffer.from(input.current, "base64"),
                input.comment,
                input.actor.name,
                input.actor.id,
              )
            : await applyCollaborativeAnnotations(
                Buffer.from(input.current, "base64"),
                Buffer.from(input.proposed, "base64"),
                input.actor,
                input.owner,
              );
      if (decodingRejected)
        throw new SharingError(
          "The PDF exceeds the decompression budget.",
          413,
        );
      process.stdout.write(
        JSON.stringify({ ok: true, pdf: Buffer.from(pdf).toString("base64") }),
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          status: decodingRejected
            ? 413
            : error instanceof SharingError
              ? error.status
              : 422,
          message: decodingRejected
            ? "The PDF exceeds the decompression budget."
            : error instanceof SharingError ||
                error instanceof PdfCommentError ||
                error instanceof ExerciseRenderError
              ? error.message
              : "The PDF contains unsupported or invalid annotation data.",
        }),
      );
    }
  })();
});
