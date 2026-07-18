import fs from "node:fs";
import path from "node:path";
import { slugify } from "../library/slug";
import { ensureDataDirs } from "../data-dir";
import {
  companionDir,
  pdfPath,
  writeMeta,
  writeSummary,
  writeText,
  uniqueSlug,
  type PaperMeta,
} from "../library/papers";
import { createChat, appendMessage } from "../library/chats";
import { rebuildIndex } from "../library/index-db";
import { downloadPdf } from "./download";
import { extractPdfText, analyzePaper, type Analysis } from "./analyze";

/**
 * Capture orchestration: URL → inbox paper with proposed filing.
 * The paper stays in data/library/_inbox/ (PDF inside the companion dir, so
 * nothing unconfirmed ever shows over WebDAV) until the user accepts the
 * proposed topic/tags on the confirmation page.
 */

export interface CaptureResult {
  slug: string;
  proposedTopic: string;
  analysis: Analysis;
}

export async function capture(
  url: string,
  username: string,
): Promise<CaptureResult> {
  ensureDataDirs();
  const pdf = await downloadPdf(url);

  // Slug from the analyzed title once we have it; provisional from URL now.
  const provisional = uniqueSlug(
    slugify(path.basename(new URL(pdf.finalUrl).pathname)) || "paper",
  );
  const inboxPdf = pdfPath(null, provisional);
  fs.mkdirSync(path.dirname(inboxPdf), { recursive: true });
  fs.writeFileSync(inboxPdf, pdf.bytes);

  const text = await extractPdfText(inboxPdf);
  const analysis = await analyzePaper(url, text);

  // Rename to a title-based slug now that the title is known.
  const finalSlug = retargetSlug(provisional, analysis.title);

  const meta: PaperMeta = {
    title: analysis.title,
    authors: analysis.authors,
    year: analysis.year,
    venue: analysis.venue,
    arxivId: pdf.arxivId,
    bibtex: analysis.bibtex,
    tags: analysis.tags,
    related: analysis.related,
    sourceUrl: url,
    addedAt: new Date().toISOString(),
    addedBy: username,
  };
  writeMeta(null, finalSlug, meta);
  writeSummary(null, finalSlug, analysis.summary);
  if (text) writeText(null, finalSlug, text);

  // Seed the capturing profile's first chat with the starter questions.
  const chat = createChat(null, finalSlug, username, "Starter questions");
  appendMessage(null, finalSlug, username, chat.id, {
    role: "assistant",
    content:
      "Some questions to start studying this paper:\n\n" +
      analysis.starterQuestions.map((q) => `- ${q}`).join("\n"),
    at: new Date().toISOString(),
  });

  rebuildIndex();
  return {
    slug: finalSlug,
    proposedTopic: slugify(analysis.topic) || "unsorted",
    analysis,
  };
}

/** Move the provisional inbox capture onto a title-derived slug. */
function retargetSlug(provisional: string, title: string): string {
  const wanted = slugify(title);
  if (!wanted || wanted === provisional) return provisional;
  const finalSlug = uniqueSlug(wanted);
  const fromDir = companionDir(null, provisional);
  const toDir = companionDir(null, finalSlug);
  if (fs.existsSync(fromDir)) {
    fs.renameSync(fromDir, toDir);
  } else {
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(pdfPath(null, provisional), pdfPath(null, finalSlug));
  }
  return finalSlug;
}
