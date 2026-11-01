import { z } from "zod";

const publicUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value));
export const assetSchema = z.object({
  kind: z.enum(["image", "audio", "video", "file"]),
  name: z.string().max(1000),
  ref: z.string().max(2000).optional(),
  url: publicUrl.optional(),
  data: z
    .string()
    .max(6_000_000)
    .regex(/^data:[\w.+/-]+;base64,[A-Za-z0-9+/]*={0,2}$/)
    .optional(),
  mime: z.string().max(100).optional(),
});
export const citationSchema = z.object({
  ref: z.string().max(200),
  title: z.string().max(1000),
  url: publicUrl,
});
export type ConversationAsset = z.infer<typeof assetSchema>;
export type ConversationCitation = z.infer<typeof citationSchema>;

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function http(value: unknown): string | undefined {
  return typeof value === "string" && publicUrl.safeParse(value).success
    ? value
    : undefined;
}
