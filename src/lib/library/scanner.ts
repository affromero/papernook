import chokidar, { type FSWatcher } from "chokidar";
import { papersRoot, libraryRoot, ensureDataDirs } from "../data-dir";
import { rebuildIndex } from "./index-db";
import { recoverInterruptedMoves } from "./papers";
import { recoverInterruptedCaptures } from "../capture/jobs";

/**
 * Keeps the SQLite index in sync with disk: full rescan on boot, then a
 * debounced full rebuild only for files that affect the index. Chat, crop,
 * canvas, share, and exercise writes do not trigger an expensive rescan.
 */

const DEBOUNCE_MS = 1_500;

let watcher: FSWatcher | null = null;
let timer: NodeJS.Timeout | null = null;

export function affectsIndex(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const name = normalized.split("/").pop() ?? "";
  if (name === "meta.json" || name === "summary.md" || name === "text.txt") {
    return true;
  }
  if (name.endsWith(".exercises.pdf")) return false;
  return name.endsWith(".pdf");
}

function scheduleRebuild(filePath: string): void {
  if (!affectsIndex(filePath)) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      rebuildIndex();
    } catch (err) {
      console.error("papernook scanner: rebuild failed", err);
    }
  }, DEBOUNCE_MS);
}

export function startScanner(): void {
  if (watcher) return;
  ensureDataDirs();
  recoverInterruptedMoves();
  recoverInterruptedCaptures();
  rebuildIndex();
  watcher = chokidar.watch([papersRoot(), libraryRoot()], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
  });
  watcher.on("all", (_event, filePath) => scheduleRebuild(filePath));
}

export async function stopScanner(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await watcher?.close();
  watcher = null;
}
