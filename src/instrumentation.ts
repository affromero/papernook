export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScanner } = await import("./lib/scanner");
    startScanner();
  }
}
