// Mac App Store screenshots: boot the seeded e2e papernook server, load
// extension/ into Chromium, drive the real flow — options-page save builds the
// DNR rules, arxiv.org/pdf/… actually redirects into /viewer, a citation
// hover opens the reference preview — and capture the viewport. Two sizes:
//   1280x800       build/screenshots/<name>.png
//   2560x1600 @2x  build/screenshots/<name>@2x.png
//
//   node scripts/store-screenshots.mjs
//
// The viewer shot proxies a real arXiv PDF (one polite fetch per run); the
// library shots are the hermetic seed data. Captures are viewport-only, so no
// browser chrome or URL bar appears.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "build", "screenshots");
const BASE = "http://127.0.0.1:3107";
// Hyperref'd arXiv PDF (BERT) NOT captured in the seed library — a seeded
// arxivId would redirect the viewer to the library copy instead.
const ARXIV_PDF = "https://arxiv.org/pdf/1810.04805";

execFileSync("node", ["tests/e2e/seed.mjs"], { cwd: ROOT, stdio: "inherit" });
const server = spawn(
  "npm",
  ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3107"],
  {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PAPERNOOK_DATA_DIR: join(ROOT, ".playwright-data"),
      SESSION_SECRET:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_EXPOSURE: "true",
      PAPERNOOK_PUBLIC_HOST: "127.0.0.1",
      PAPERNOOK_PUBLIC_REQUEST_LIMIT: "1000",
      PAPERNOOK_PASSWORD: "admin-created-password",
      AI_PROVIDER: "codex",
      WEBDAV_USER: "papers",
      WEBDAV_PASS: "annotate-locally",
      PATH: `${join(ROOT, "tests", "e2e", "bin")}:${process.env.PATH}`,
    },
  },
);
const stop = () => server.kill("SIGTERM");
process.on("exit", stop);

const deadline = Date.now() + 120_000;
for (;;) {
  try {
    if ((await fetch(`${BASE}/login`)).ok) break;
  } catch {
    /* not up yet */
  }
  if (Date.now() > deadline) throw new Error("dev server never came up");
  await new Promise((resolve) => setTimeout(resolve, 500));
}

await mkdir(OUT, { recursive: true });
for (const dsf of [1, 2]) {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: dsf,
    args: [
      `--disable-extensions-except=${join(ROOT, "extension")}`,
      `--load-extension=${join(ROOT, "extension")}`,
    ],
  });
  const shot = async (page, name) => {
    const path = join(OUT, `${name}${dsf === 2 ? "@2x" : ""}.png`);
    await page.screenshot({ path });
    console.log(`✓ ${path}`);
  };

  const page = await ctx.newPage();

  // Sign in (password gate, then the Maya profile from the seed).
  await page.goto(`${BASE}/login`);
  await page
    .getByRole("textbox", { name: "Password" })
    .fill("admin-created-password");
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await page.getByLabel("Profile password").fill("maya-profile-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE}/`);

  // Point the extension at the server through its own options page — the
  // save path is what builds the DNR redirect rules.
  let [worker] = ctx.serviceWorkers();
  worker ??= await ctx.waitForEvent("serviceworker");
  const extId = new URL(worker.url()).host;
  const options = await ctx.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.locator("#base-url").fill(BASE);
  await options.locator("#save").click();
  await options.locator("#status").filter({ hasText: "Saved" }).waitFor();
  await options.close();

  // The extension redirects the arXiv PDF navigation into the viewer.
  await page.goto(ARXIV_PDF, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.href.startsWith(`${BASE}/viewer`), {
    timeout: 15_000,
  });
  await page.locator(".annotationLayer canvas, .page canvas").first().waitFor({
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);

  // Hover a citation (any internal GoTo link as fallback) for the preview.
  const links = page.locator("section[data-internal-link] a");
  await links.first().waitFor({ timeout: 30_000 });
  const cites = page.locator('section[data-internal-link] a[href*="cite"]');
  const target = (await cites.count()) ? cites.first() : links.first();
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  await page.locator("[data-reference-preview]").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await shot(page, "viewer-preview");

  // The library the capture lands in, and a captured paper's page.
  await page.goto(`${BASE}/`);
  await page.getByText("Attention Is All You Need").first().waitFor();
  await page.waitForTimeout(800);
  await shot(page, "library");

  await page.goto(`${BASE}/paper/machine-learning/attention-is-all-you-need`);
  await page.locator(".page canvas, canvas").first().waitFor({
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);
  await shot(page, "paper");

  await ctx.close();
}
stop();
console.log("screenshots in build/screenshots/");
