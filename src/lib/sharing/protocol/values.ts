import { z } from "zod";

export const MAX_BUNDLE_BYTES = 150 * 1024 * 1024;
export const MAX_CHAT_BYTES = 8 * 1024 * 1024;
export const base64Schema = z
  .string()
  .refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    "Invalid base64 payload.",
  );
export const revisionSchema = z.string().regex(/^"[a-f0-9]{64}"$/);
export const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{C}]+$/u);

export class SharingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
