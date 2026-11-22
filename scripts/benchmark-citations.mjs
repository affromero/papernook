import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const [sizeArg = "1000", runsArg = "15"] = process.argv.slice(2);
const size = Number(sizeArg);
const runs = Number(runsArg);
if (
  !Number.isSafeInteger(size) ||
  size < 2 ||
  !Number.isSafeInteger(runs) ||
  runs < 1
) {
  throw new Error("Pass a paper count of at least 2 and a positive run count.");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-citations-"));
process.env.NODE_ENV = "development";
process.env.PAPERNOOK_DATA_DIR = dataDir;
const load = (name) => server.ssrLoadModule(`/src/lib/library/${name}.ts`);
const digest = createHash("sha256");
let server;
let closeIndex;

function measure(label, run) {
  const start = performance.now();
  const result = run();
  const coldMs = performance.now() - start;
  digest.update(JSON.stringify(result));
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const percentile = (fraction) => samples[Math.ceil(fraction * runs) - 1];
  console.log(
    JSON.stringify({
      label,
      coldMs,
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
    }),
  );
}

try {
  server = await createServer({
    root,
    configFile: false,
    resolve: { alias: { "@": path.join(root, "src") } },
    server: { middlewareMode: true, ws: false },
  });
  const { writeMeta, writeText, pdfPath } = await load("papers");
  const index = await load("index-db");
  closeIndex = index.closeIndex;
  const { ensureDataDirs } = await server.ssrLoadModule("/src/lib/data-dir.ts");
  ensureDataDirs();

  const title = (i) =>
    i % 11 === 0
      ? `Short topic${i}`
      : `Analysis of method${i} across dataset${i % 97} and domain${i % 31}`;

  for (let i = 0; i < size; i++) {
    const topic = "benchmark";
    const slug = `paper-${i}`;
    const entries = Array.from({ length: 12 + (i % 24) }, (_, j) =>
      j % 4 === 0
        ? `[${j + 1}] Smith, A. ${title((i + 17 * j + 1) % size)}. Journal, 2020.`
        : `[${j + 1}] Lee, J. External investigation missing${i} result${j}. Journal, 2019.`,
    );
    writeMeta(topic, slug, {
      title: title(i),
      authors: ["Ada Lovelace"],
      year: 2024,
      venue: null,
      arxivId: null,
      bibtex: null,
      tags: [],
      related: [],
      sourceUrl: `https://example.com/${slug}.pdf`,
      addedAt: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(),
      addedBy: "benchmark",
    });
    writeText(
      topic,
      slug,
      `Abstract.\n\nReferences\n\n${entries.join("\n\n")}`,
    );
    const pdf = pdfPath(topic, slug);
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    fs.writeFileSync(pdf, "%PDF-1.4");
  }

  const { buildLibraryGraph } = await load("graph");
  const { buildReadingList } = await load("bibliography/reading-list");
  const { prunePaperBibliographyCache } = await load("bibliography/entries");
  const { findPaperByReference } = await load("context/reference-match");
  console.log(
    JSON.stringify({
      size,
      runs,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
    }),
  );
  measure("graph", buildLibraryGraph);
  prunePaperBibliographyCache([]);
  measure("reading list", buildReadingList);
  index.rebuildIndex();
  measure("SQLite row materialization", index.allIndexed);
  measure("lookup early hit", () => findPaperByReference(title(size - 1)));
  measure("lookup late hit", () => findPaperByReference(title(0)));
  measure("lookup miss", () =>
    findPaperByReference("Unrelated publication on quantum particles"),
  );
  console.log(
    JSON.stringify({
      outputSha256: digest.digest("hex"),
      peakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  closeIndex?.();
  try {
    await server?.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
