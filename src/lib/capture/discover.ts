import { z } from "zod";
import { getProvider } from "../agent/registry";
import { listTopics, listPapers, readSummary } from "../library/papers";
import { extractJson } from "./analyze";

/**
 * Related-work discovery: one agent call that scouts papers NOT yet in the
 * library, grounded in what the library already holds. Suggestions carry a
 * source URL that feeds straight into the normal /add capture pipeline, so
 * a hallucinated or dead link fails there with the usual download error —
 * nothing is written to disk here.
 */

export const discoverySchema = z.object({
  suggestions: z
    .array(
      z.object({
        title: z.string().min(1),
        authors: z.array(z.string()).default([]),
        year: z.number().int().nullable().default(null),
        url: z.string().url(),
        why: z.string().min(1),
      }),
    )
    .max(8),
});

export type Discovery = z.infer<typeof discoverySchema>;

export interface DiscoverFocus {
  topic?: string;
  slug?: string;
}

function discoveryPrompt(focus: DiscoverFocus): {
  system: string;
  prompt: string;
} {
  const papers = listPapers();
  const library = papers
    .slice(0, 200)
    .map(
      (p) =>
        `${p.meta.title} — ${p.meta.authors.join(", ")}` +
        ` [topic: ${p.topic ?? "inbox"}; tags: ${p.meta.tags.join(", ") || "none"}]`,
    )
    .join("\n");
  const focusPaper = focus.slug
    ? papers.find((p) => p.slug === focus.slug)
    : undefined;
  const focusBlock = focusPaper
    ? `Focus on work related to this paper:\n${focusPaper.meta.title} — ` +
      `${focusPaper.meta.authors.join(", ")}\n` +
      `${readSummary(focusPaper.topic, focusPaper.slug) ?? ""}\n\n`
    : focus.topic
      ? `Focus on the "${focus.topic}" topic.\n\n`
      : "";
  const system =
    "You are a research librarian scouting related work for a personal " +
    "paper library. Respond with ONLY a JSON object, no markdown fences, " +
    'matching exactly: {"suggestions": [{"title": string, "authors": string[], ' +
    '"year": number|null, "url": string, "why": string}]}. ' +
    "Suggest 3-8 real, influential papers that are NOT already in the library. " +
    "Only include papers you are confident actually exist; url must be a real " +
    "arXiv abs/pdf link when the paper is on arXiv, otherwise the publisher or " +
    "author page. why: one sentence tying the suggestion to the library.";
  const prompt =
    focusBlock +
    `Topics: ${listTopics().join(", ") || "(none yet)"}\n\n` +
    `Current library:\n${library || "(empty)"}`;
  return { system, prompt };
}

export async function discoverRelated(
  focus: DiscoverFocus = {},
): Promise<Discovery> {
  const { system, prompt } = discoveryPrompt(focus);
  const raw = await getProvider().execute({
    system,
    prompt,
    responseFormat: "json_object",
  });
  return discoverySchema.parse(extractJson(raw));
}
