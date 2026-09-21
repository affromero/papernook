export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { startErasureWorker } =
        await import("./lib/auth/platform/erasure-worker");
      startErasureWorker();
      const { startMetricRetention } =
        await import("./lib/agent/platform/metric-retention");
      startMetricRetention();
    }
    const { startScanner } = await import("./lib/library/scanner");
    startScanner();
    const { startZoteroSync } = await import("./lib/capture/zotero");
    startZoteroSync();
  }
}
