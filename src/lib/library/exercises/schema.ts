import { z } from "zod";
export const exerciseMarkdownSchema = z.string().trim().min(1).max(100_000);
export const exerciseNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}\.md$/);
export const exerciseOperationSchema = z.string().regex(/^[a-f0-9-]{16,64}$/);
export const exerciseRecordSchema = z
  .object({
    name: exerciseNameSchema,
    markdown: exerciseMarkdownSchema,
    operationId: exerciseOperationSchema,
    actorId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9:-]+$/),
    author: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\p{C}]+$/u),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ExerciseRecord = z.infer<typeof exerciseRecordSchema>;

export class ExerciseError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
