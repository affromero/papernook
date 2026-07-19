import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-disc-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  const { closeIndex } = await import("@/lib/library/index-db");
  closeIndex();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const suggestion = {
  title: "Scaling Laws for Neural Language Models",
  authors: ["Kaplan", "McCandlish"],
  year: 2020,
  url: "https://arxiv.org/abs/2001.08361",
  why: "Grounds the transformer papers already in the library.",
};

async function seedPaper(): Promise<void> {
  const { ensureDataDirs } = await import("@/lib/data-dir");
  ensureDataDirs();
  const papers = await import("@/lib/library/papers");
  const pdf = papers.pdfPath("transformers", "attention-is-all-you-need");
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, "%PDF-1.4 fake pdf");
  papers.writeMeta("transformers", "attention-is-all-you-need", {
    title: "Attention Is All You Need",
    authors: ["Vaswani"],
    year: 2017,
    venue: "NeurIPS",
    arxivId: null,
    bibtex: null,
    tags: ["attention"],
    related: [],
    sourceUrl: "https://arxiv.org/abs/1706.03762",
    addedAt: new Date().toISOString(),
    addedBy: "andres",
  });
  papers.writeSummary(
    "transformers",
    "attention-is-all-you-need",
    "Introduces the transformer architecture.",
  );
}

describe("related-work discovery (mocked agent)", () => {
  it("grounds the prompt in the library and returns parsed suggestions", async () => {
    await seedPaper();
    let seenPrompt = "";
    vi.doMock("@/lib/agent/registry", () => ({
      getProvider: () => ({
        id: "claude-code",
        execute: async ({ prompt }: { prompt: string }) => {
          seenPrompt = prompt;
          return (
            "```json\n" +
            JSON.stringify({ suggestions: [suggestion] }) +
            "\n```"
          );
        },
        stream: async function* () {},
      }),
    }));

    const { discoverRelated } = await import("@/lib/capture/discover");
    const result = await discoverRelated({
      slug: "attention-is-all-you-need",
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].title).toBe(suggestion.title);
    expect(result.suggestions[0].url).toBe(suggestion.url);
    // The agent must see what the library holds and the focus paper's summary.
    expect(seenPrompt).toContain("Attention Is All You Need");
    expect(seenPrompt).toContain("Introduces the transformer architecture.");
  });

  it("rejects suggestions with malformed URLs", async () => {
    vi.doMock("@/lib/agent/registry", () => ({
      getProvider: () => ({
        id: "claude-code",
        execute: async () =>
          JSON.stringify({
            suggestions: [{ ...suggestion, url: "not a link" }],
          }),
        stream: async function* () {},
      }),
    }));

    const { discoverRelated } = await import("@/lib/capture/discover");
    await expect(discoverRelated()).rejects.toThrow();
  });
});
