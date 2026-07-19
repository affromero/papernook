export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScanner } = await import("./lib/library/scanner");
    startScanner();
    const { startZoteroSync } = await import("./lib/capture/zotero");
    startZoteroSync();
  }
}
