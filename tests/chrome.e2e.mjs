// Load the packaged extension in Chromium, configure it through the real
// options page, and prove its declarative redirect reaches Papernook.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTENSION = join(ROOT, "build", "chrome");
const SOURCE_PDF = "https://arxiv.org/pdf/2401.00001";

const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url ?? "");
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
  await options.locator("#status").filter({ hasText: "Saved." }).waitFor();

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
