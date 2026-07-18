import chokidar, { type FSWatcher } from 'chokidar';
import { papersRoot, libraryRoot, ensureDataDirs } from './data-dir';
import { rebuildIndex } from './index-db';

/**
 * Keeps the SQLite index in sync with disk: full rescan on boot, then a
 * debounced full rebuild on any change under either tree (covers WebDAV
 * writes, manual moves, and app writes alike — disk always wins).
 */

const DEBOUNCE_MS = 1_500;

let watcher: FSWatcher | null = null;
let timer: NodeJS.Timeout | null = null;

function scheduleRebuild(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      rebuildIndex();
    } catch (err) {
      console.error('papernook scanner: rebuild failed', err);
    }
  }, DEBOUNCE_MS);
}

export function startScanner(): void {
  if (watcher) return;
  ensureDataDirs();
  rebuildIndex();
  watcher = chokidar.watch([papersRoot(), libraryRoot()], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
  });
  watcher.on('all', scheduleRebuild);
}

export async function stopScanner(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await watcher?.close();
  watcher = null;
}
