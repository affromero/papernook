// Load the packaged extension in Chromium, configure it through the real
// options page, and prove its declarative redirect reaches Papernook.
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTENSION = join(ROOT, "build", "chrome");
const SOURCE_PDF = "https://arxiv.org/pdf/2401.00001";

const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url ?? "");
  if (request.url === "/api/v1/health") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ status: "ok", version: "test" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><title>papernook test reader</title><h1>Reader</h1>",
  );
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("test server did not bind to a TCP port");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

// Headless Chromium cannot answer the optional host-permission prompt. Grant
// only the loopback test host in the disposable build output before loading it.
const manifestPath = join(EXTENSION, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!manifest.host_permissions.includes("http://127.0.0.1/*")) {
  manifest.host_permissions.push("http://127.0.0.1/*");
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
  ],
});

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator("#base-url").fill(baseUrl);
  await options.locator("#save").click();
  const status = options.locator("#status");
  await status.filter({ hasText: "Saved" }).waitFor();
  const statusText = await status.textContent();
  if (statusText !== "Saved. Connection successful.") {
    throw new Error(`extension connection test failed: ${statusText}`);
  }
  if (!requests.includes("/api/v1/health")) {
    throw new Error("saving extension options did not test Papernook health");
  }

  const paper = await context.newPage();
  await paper.goto(SOURCE_PDF, { waitUntil: "domcontentloaded" });
  await paper.waitForURL(
    (url) => url.origin === baseUrl && url.pathname === "/viewer",
  );

  const redirected = new URL(paper.url());
  if (redirected.searchParams.get("src") !== SOURCE_PDF) {
    throw new Error(`redirect lost source URL: ${paper.url()}`);
  }
  if (!requests.some((request) => request.startsWith("/viewer?src="))) {
    throw new Error("Papernook test server never received the viewer request");
  }
  console.log("chrome extension options + PDF redirect passed ✓");
} finally {
  await context.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
