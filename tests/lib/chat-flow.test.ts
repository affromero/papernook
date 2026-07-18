import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-chat-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function placePaper() {
  const { ensureDataDirs } = await import("@/lib/data-dir");
  ensureDataDirs();
  const papers = await import("@/lib/library/papers");
  papers.writeMeta("nlp", "attention", {
    title: "Attention Is All You Need",
    authors: ["Vaswani"],
    year: 2017,
    venue: "NeurIPS",
    arxivId: "1706.03762",
    bibtex: null,
    tags: ["transformers"],
    related: [],
    sourceUrl: "https://arxiv.org/abs/1706.03762",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
  });
  papers.writeSummary("nlp", "attention", "The transformer paper.");
  papers.writeText("nlp", "attention", "x".repeat(80_000));
  const pdf = papers.pdfPath("nlp", "attention");
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4 fake");
  return papers.getPaper("nlp", "attention")!;
}

describe("chat context", () => {
  it("injects metadata + summary and windows huge text", async () => {
    const paper = await placePaper();
    const { buildChatSystem } = await import("@/lib/library/chat-context");
    const system = buildChatSystem(paper);
    expect(system).toContain("Attention Is All You Need");
    expect(system).toContain("The transformer paper.");
    expect(system).toContain("[...text truncated...]");
    expect(system.length).toBeLessThan(60_000);
  });

  it("flattens history into a resumable prompt", async () => {
    const { buildChatPrompt } = await import("@/lib/library/chat-context");
    const prompt = buildChatPrompt(
      [
        { role: "user", content: "Why attention?" },
        { role: "assistant", content: "Because recurrence is slow." },
      ],
      "Elaborate.",
    );
    expect(prompt).toContain("User: Why attention?");
    expect(prompt).toContain("Assistant: Because recurrence is slow.");
    expect(prompt.endsWith("Assistant:")).toBe(true);
  });
});

describe("exercises", () => {
  it("saves markdown files with increasing names and lists them", async () => {
    await placePaper();
    const ex = await import("@/lib/library/exercises");
    expect(ex.saveExercise("nlp", "attention", "# Practice\n- Q1")).toBe(
      "practice-1.md",
    );
    expect(ex.saveExercise("nlp", "attention", "# More\n- Q2")).toBe(
      "practice-2.md",
    );
    expect(ex.listExercises("nlp", "attention")).toEqual([
      "practice-1.md",
      "practice-2.md",
    ]);
  });

  it("renders all exercises into one valid PDF in the papers tree", async () => {
    const paper = await placePaper();
    const ex = await import("@/lib/library/exercises");
    ex.saveExercise(
      "nlp",
      "attention",
      "# Session 1\n\n1. Derive the attention formula.\n2. " +
        "long ".repeat(200),
    );
    const out = await ex.renderExercisesPdf(
      "nlp",
      "attention",
      paper.meta.title,
    );
    expect(out).toBeTruthy();
    const bytes = fs.readFileSync(out as string);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(out).toContain(
      path.join("papers", "nlp", "attention.exercises.pdf"),
    );
  });

  it("returns null when there is nothing to render", async () => {
    await placePaper();
    const ex = await import("@/lib/library/exercises");
    expect(await ex.renderExercisesPdf("nlp", "attention", "t")).toBeNull();
  });
});
