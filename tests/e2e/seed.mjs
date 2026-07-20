import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const root = path.join(process.cwd(), ".playwright-data");
fs.rmSync(root, { recursive: true, force: true });

function profilePasswordHash(password) {
  const salt = Buffer.from("papernook-e2e-salt");
  const derived = crypto.scryptSync(password, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    16_384,
    8,
    1,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function wrap(text, font, size, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function academicPdf() {
  const pdf = await PDFDocument.create();
  const times = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const body =
    "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new, simple network architecture based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments show that these models are more parallelizable and require significantly less time to train.";

  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const page = pdf.addPage([612, 792]);
    const { width, height } = page.getSize();
    page.drawText(String(pageIndex + 1), {
      x: width / 2,
      y: 24,
      size: 9,
      font: times,
      color: rgb(0.25, 0.25, 0.25),
    });
    if (pageIndex === 0) {
      page.drawText("Attention Is All You Need", {
        x: 112,
        y: height - 74,
        size: 24,
        font: bold,
      });
      page.drawText(
        "Ashish Vaswani  ·  Noam Shazeer  ·  Niki Parmar  ·  2017",
        { x: 116, y: height - 104, size: 11, font: italic },
      );
      page.drawText("Abstract", {
        x: 48,
        y: height - 146,
        size: 12,
        font: bold,
      });
      let abstractY = height - 164;
      for (const line of wrap(body, times, 9.5, 516)) {
        page.drawText(line, { x: 48, y: abstractY, size: 9.5, font: times });
        abstractY -= 12;
      }
    }

    const headings =
      pageIndex === 0
        ? ["1  Introduction", "2  Background"]
        : pageIndex === 1
          ? ["3  Model Architecture", "3.2  Attention"]
          : ["5  Training", "6  Results and References"];
    const top = pageIndex === 0 ? height - 248 : height - 54;
    const gap = 18;
    const columnWidth = (width - 96 - gap) / 2;
    for (let column = 0; column < 2; column += 1) {
      const x = 48 + column * (columnWidth + gap);
      let y = top;
      page.drawText(headings[column], { x, y, size: 12, font: bold });
      y -= 18;
      const paragraphs = Array.from({ length: 6 }, (_, index) =>
        index % 2 === 0
          ? body
          : "An attention function maps a query and a set of key-value pairs to an output. The output is computed as a weighted sum of the values, where each weight describes the compatibility of the query with the corresponding key.",
      );
      for (const paragraph of paragraphs) {
        for (const line of wrap(paragraph, times, 9, columnWidth)) {
          if (y < 45) break;
          page.drawText(line, { x, y, size: 9, font: times });
          y -= 11;
        }
        y -= 7;
      }
    }
  }
  return pdf.save();
}

const profile = {
  username: "maya",
  displayName: "Maya",
  avatarSlug: "hummingbird",
  role: "admin",
  captureToken: "a".repeat(48),
  passwordHash: profilePasswordHash("maya-profile-password"),
  wizardDone: true,
  createdAt: "2026-07-19T09:00:00.000Z",
};
writeJson(path.join(root, "users", "maya", "profile.json"), profile);

const topic = "machine-learning";
const slug = "attention-is-all-you-need";
const companion = path.join(root, "library", topic, slug);
const paperDir = path.join(root, "papers", topic);
fs.mkdirSync(companion, { recursive: true });
fs.mkdirSync(paperDir, { recursive: true });
fs.writeFileSync(path.join(paperDir, `${slug}.pdf`), await academicPdf());
writeJson(path.join(companion, "meta.json"), {
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
  year: 2017,
  venue: "NeurIPS",
  arxivId: "1706.03762",
  bibtex: null,
  tags: ["machine-learning", "transformers", "attention"],
  related: [],
  sourceUrl: "https://arxiv.org/abs/1706.03762",
  addedAt: "2026-07-18T12:00:00.000Z",
  addedBy: "maya",
});
fs.writeFileSync(
  path.join(companion, "summary.md"),
  "The Transformer replaces recurrence with self-attention, shortening paths between distant tokens and improving training parallelism.",
);
fs.writeFileSync(path.join(companion, "text.txt"), "Attention transformer");

const chatDir = path.join(companion, "chats", "maya");
fs.mkdirSync(chatDir, { recursive: true });
fs.writeFileSync(
  path.join(chatDir, "0123456789abcdef.jsonl"),
  [
    JSON.stringify({
      id: "0123456789abcdef",
      title: "Why attention replaced recurrence",
      username: "maya",
      createdAt: "2026-07-18T12:30:00.000Z",
    }),
    JSON.stringify({
      role: "user",
      content: "Why was removing recurrence such a big deal?",
      at: "2026-07-18T12:31:00.000Z",
    }),
    JSON.stringify({
      role: "assistant",
      content:
        "Every token can connect directly to every other token, so long-range relationships need fewer sequential steps and training parallelizes across positions.",
      at: "2026-07-18T12:31:10.000Z",
    }),
  ].join("\n") + "\n",
);

for (const [extraSlug, title, year, tags] of [
  [
    "bert",
    "BERT: Pre-training of Deep Bidirectional Transformers",
    2019,
    ["transformers"],
  ],
  [
    "deep-residual-learning",
    "Deep Residual Learning for Image Recognition",
    2016,
    ["computer-vision"],
  ],
]) {
  const dir = path.join(root, "library", topic, extraSlug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(paperDir, `${extraSlug}.pdf`),
    await academicPdf(),
  );
  writeJson(path.join(dir, "meta.json"), {
    title,
    authors: ["Research Team"],
    year,
    venue: "Conference paper",
    arxivId: null,
    bibtex: null,
    tags,
    related: [slug],
    sourceUrl: "https://example.test/paper.pdf",
    addedAt: `2026-07-${year === 2019 ? "17" : "16"}T12:00:00.000Z`,
    addedBy: "maya",
  });
  fs.writeFileSync(
    path.join(dir, "summary.md"),
    "A concise summary of the paper and its relationship to the library.",
  );
  fs.writeFileSync(path.join(dir, "text.txt"), title);
}
