import { spawn } from "node:child_process";
import { z } from "zod";
import { getProvider } from "../agent/registry";
import { listTopics, listPapers } from "../library/papers";

/**
 * Post-download analysis: pdftotext extraction, then one agent call that
 * files the paper: metadata + bibtex, a topic-folder proposal (existing
 * folders offered first), tags, a summary, related papers already in the
 * library, and starter questions for the seeded first chat.
 */

export function extractPdfText(pdfPath: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("pdftotext", ["-q", pdfPath, "-"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on("error", () => {
      // poppler missing; analysis degrades to metadata-from-agent only
      clearTimeout(timer);
      resolve("");
    });
  });
}

export const analysisSchema = z.object({
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
  year: z.number().int().nullable().default(null),
  venue: z.string().nullable().default(null),
  bibtex: z.string().nullable().default(null),
  topic: z
    .string()
    .min(1)
    .describe("kebab-case topic folder, existing preferred"),
  tags: z.array(z.string()).max(8).default([]),
  summary: z.string().min(1),
  related: z.array(z.string()).default([]),
  starterQuestions: z.array(z.string()).min(1).max(5),
});

export type Analysis = z.infer<typeof analysisSchema>;

function analysisPrompt(
  sourceUrl: string,
  text: string,
): {
  system: string;
  prompt: string;
} {
  const topics = listTopics();
  const library = listPapers()
    .slice(0, 200)
    .map((p) => `${p.slug}: ${p.meta.title}`)
    .join("\n");
  const system =
    "You are the librarian of a personal research-paper library. " +
    "Respond with ONLY a JSON object, no markdown fences, matching exactly: " +
    '{"title": string, "authors": string[], "year": number|null, "venue": string|null, ' +
    '"bibtex": string|null, "topic": string, "tags": string[], "summary": string, ' +
    '"related": string[], "starterQuestions": string[]}. ' +
    "topic is a kebab-case folder name: strongly prefer an existing folder when one fits. " +
    "tags: 2-6 short kebab-case tags. summary: 3-5 sentences (TL;DR + key contributions), plain text. " +
    "related: slugs from the existing library that are genuinely related (empty if none). " +
    "starterQuestions: 3-5 questions a reader should ask to truly understand this paper.";
  const prompt =
    `Source URL: ${sourceUrl}\n\n` +
    `Existing topic folders: ${topics.length ? topics.join(", ") : "(none yet)"}\n\n` +
    `Existing library:\n${library || "(empty)"}\n\n` +
    `Paper text (may be truncated):\n${text.slice(0, 60_000)}`;
  return { system, prompt };
}

/** Strip accidental markdown fences and pull the outermost JSON object. */
export function extractJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`Agent returned no JSON: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Parse the librarian's analysis JSON. */
export function parseAnalysis(raw: string): Analysis {
  return analysisSchema.parse(extractJson(raw));
}

export async function analyzePaper(
  sourceUrl: string,
  text: string,
): Promise<Analysis> {
  const { system, prompt } = analysisPrompt(sourceUrl, text);
  const raw = await getProvider().execute({ system, prompt });
  return parseAnalysis(raw);
}
