import { z } from "zod";

const boundedString = z.string().max(10_000);
const permissionSchema = z
  .object({
    library: z.boolean().optional(),
    files: z.boolean().optional(),
  })
  .passthrough();

export const keyResponseSchema = z.object({
  userID: z.number().int().nonnegative(),
  username: z.string().max(1_000).optional(),
  access: z
    .object({
      user: permissionSchema.optional(),
      groups: z.record(z.string(), permissionSchema).optional(),
    })
    .optional(),
});

export const itemDataSchema = z.object({
  key: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  itemType: z.string().min(1).max(64),
  parentItem: z.string().min(1).max(64).optional(),
  contentType: z.string().max(256).optional(),
  linkMode: z.string().max(64).optional(),
  filename: z.string().max(1_000).optional(),
  title: boundedString.optional(),
  creators: z
    .array(
      z.object({
        creatorType: z.string().max(64).optional(),
        name: z.string().max(1_000).optional(),
        firstName: z.string().max(1_000).optional(),
        lastName: z.string().max(1_000).optional(),
      }),
    )
    .max(500)
    .optional(),
  date: z.string().max(256).optional(),
  publicationTitle: boundedString.optional(),
  conferenceName: boundedString.optional(),
  university: boundedString.optional(),
  institution: boundedString.optional(),
  url: boundedString.optional(),
  DOI: z.string().max(1_000).optional(),
  extra: boundedString.optional(),
  volume: z.string().max(256).optional(),
  issue: z.string().max(256).optional(),
  pages: z.string().max(256).optional(),
  publisher: boundedString.optional(),
  place: boundedString.optional(),
  abstractNote: boundedString.optional(),
  language: z.string().max(256).optional(),
  ISBN: z.string().max(256).optional(),
  ISSN: z.string().max(256).optional(),
  tags: z
    .array(z.object({ tag: z.string().max(500) }))
    .max(1_000)
    .optional(),
  collections: z.array(z.string().min(1).max(64)).max(1_000).optional(),
  annotationType: z.string().max(64).optional(),
  annotationText: z.string().max(50_000).optional(),
  annotationComment: z.string().max(50_000).optional(),
  annotationColor: z.string().max(64).optional(),
  annotationPageLabel: z.string().max(256).optional(),
  annotationSortIndex: z.string().max(256).optional(),
});

export type ZoteroItemData = z.infer<typeof itemDataSchema>;

export const itemSchema = z.object({
  key: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  data: itemDataSchema,
});

export const collectionSchema = z.object({
  data: z.object({
    key: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(1_000),
    parentCollection: z
      .union([z.string().min(1).max(64), z.literal(false)])
      .optional(),
  }),
});

export const groupSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  data: z.object({
    name: z.string().trim().min(1).max(1_000),
  }),
});
