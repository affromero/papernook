// Demo video of the extension flow for App Review notes and the README GIF:
// arxiv.org PDF navigation → extension redirect into /viewer → hover a
// citation for the reference preview → "+ Add to papernook" → inbox review →
// file it. Runs the seeded e2e server WITHOUT an AI provider — the same
// no-AI mode store/REVIEWERS.md tells reviewers to install — so capture uses
// the arXiv-metadata fallback and the flow needs no agent.
//
//   node scripts/store/demo-video.mjs
//
// Outputs build/demo/extension-demo.mp4 (attach to review notes) and
// docs/images/product/extension-demo.gif (embedded in README.md). A fake
// cursor is injected because recorded videos have no OS pointer.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const BASE = "http://127.0.0.1:3107";
const ARXIV_PDF = "https://arxiv.org/pdf/1810.04805";
const W = 1280;
const H = 800;

execFileSync("node", ["tests/e2e/seed.mjs"], { cwd: ROOT, stdio: "inherit" });
const env = {
  ...process.env,
  PAPERNOOK_DATA_DIR: join(ROOT, ".playwright-data"),
  SESSION_SECRET:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  PAPERNOOK_PUBLIC_HOST: "127.0.0.1",
  PAPERNOOK_PUBLIC_REQUEST_LIMIT: "1000",
  PAPERNOOK_PASSWORD: "admin-created-password",
  WEBDAV_USER: "papers",
  WEBDAV_PASS: "annotate-locally",
};
delete env.AI_PROVIDER;
const server = spawn(
  "npm",
  ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3107"],
  { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env },
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

const videos = await mkdtemp(join(tmpdir(), "papernook-demo-"));
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  viewport: { width: W, height: H },
  recordVideo: { dir: videos, size: { width: W, height: H } },
  args: [
    `--disable-extensions-except=${join(ROOT, "extension")}`,
    `--load-extension=${join(ROOT, "extension")}`,
  ],
});
// Recorded video has no OS cursor — draw one that follows the mouse events.
await ctx.addInitScript(() => {
  const mount = () => {
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:fixed;left:-99px;top:-99px;z-index:2147483647;width:18px;" +
      "height:18px;border-radius:50%;background:rgba(20,20,20,.5);" +
      "border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);" +
      "pointer-events:none;transform:translate(-50%,-50%);" +
      "transition:width .12s,height .12s";
    document.documentElement.appendChild(dot);
    addEventListener(
      "mousemove",
      (event) => {
        dot.style.left = `${event.clientX}px`;
        dot.style.top = `${event.clientY}px`;
      },
      true,
    );
    addEventListener(
      "mousedown",
      () => {
        dot.style.width = "27px";
        dot.style.height = "27px";
      },
      true,
    );
    addEventListener(
      "mouseup",
      () => {
        dot.style.width = "18px";
        dot.style.height = "18px";
      },
      true,
    );
  };
  if (document.readyState === "loading")
    addEventListener("DOMContentLoaded", mount);
  else mount();
});

// Setup happens on a throwaway page so its video file can be discarded and
// the demo page's recording starts exactly at the arXiv navigation.
const setup = await ctx.newPage();
await setup.goto(`${BASE}/login`);
await setup
  .getByRole("textbox", { name: "Password" })
  .fill("admin-created-password");
await setup.getByRole("button", { name: "Enter" }).click();
await setup.getByRole("button", { name: "Switch to Maya" }).click();
await setup.getByLabel("Profile password").fill("maya-profile-password");
await setup.getByRole("button", { name: "Sign in" }).click();
await setup.waitForURL(`${BASE}/`);
let [worker] = ctx.serviceWorkers();
worker ??= await ctx.waitForEvent("serviceworker");
const extId = new URL(worker.url()).host;
await setup.goto(`chrome-extension://${extId}/options.html`);
await setup.locator("#base-url").fill(BASE);
await setup.locator("#save").click();
await setup.locator("#status").filter({ hasText: "Saved" }).waitFor();
await setup.close();

const page = await ctx.newPage();
const glide = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("target not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 45,
  });
};

// 1. A PDF navigation on arXiv is redirected into the papernook reader.
await page.goto(ARXIV_PDF, { waitUntil: "domcontentloaded" });
await page.waitForURL((url) => url.href.startsWith(`${BASE}/viewer`), {
  timeout: 15_000,
});
await page.locator(".annotationLayer canvas, .page canvas").first().waitFor({
  timeout: 60_000,
});
await page.waitForTimeout(2500);

// 2. Hover a citation → reference preview.
const links = page.locator("section[data-internal-link] a");
await links.first().waitFor({ timeout: 30_000 });
const cites = page.locator('section[data-internal-link] a[href*="cite"]');
const cite = (await cites.count()) ? cites.first() : links.first();
await glide(cite);
await page.locator("[data-reference-preview]").waitFor({ timeout: 15_000 });
await page.waitForTimeout(3500);
await glide(page.getByRole("button", { name: "Close reference preview" }));
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(600);

// 3. Capture it: "+ Add to papernook" → inbox review of the proposed filing.
await glide(page.getByRole("button", { name: "+ Add to papernook" }));
await page.mouse.down();
await page.mouse.up();
await page.waitForURL((url) => url.pathname.startsWith("/inbox/"), {
  timeout: 120_000,
});
await page.waitForTimeout(2500);

// 4. Confirm — the paper files into the shared library.
await glide(page.getByRole("button", { name: "Add to papernook" }).first());
await page.mouse.down();
await page.mouse.up();
await page.waitForURL((url) => url.pathname.startsWith("/paper/"), {
  timeout: 60_000,
});
await page.locator(".page canvas, canvas").first().waitFor({
  timeout: 60_000,
});
await page.waitForTimeout(3000);

const recording = page.video();
await ctx.close();
const webm = await recording.path();

const outDir = join(ROOT, "build", "demo");
await mkdir(outDir, { recursive: true });
const mp4 = join(outDir, "extension-demo.mp4");
execFileSync("ffmpeg", [
  "-y",
  "-i",
  webm,
  "-c:v",
  "libx264",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  mp4,
]);

// README GIF: palette-optimized, narrower and slightly sped up to keep the
// repo-committed file small.
const gif = join(ROOT, "docs", "images", "product", "extension-demo.gif");
const palette = join(videos, "palette.png");
const filters = "setpts=PTS/1.5,fps=9,scale=840:-1:flags=lanczos";
execFileSync("ffmpeg", [
  "-y",
  "-i",
  webm,
  "-vf",
  `${filters},palettegen=stats_mode=diff`,
  palette,
]);
execFileSync("ffmpeg", [
  "-y",
  "-i",
  webm,
  "-i",
  palette,
  "-lavfi",
  `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`,
  gif,
]);
await rm(videos, { recursive: true, force: true });
stop();

for (const file of [mp4, gif]) {
  const { size } = await stat(file);
  console.log(`${file} ${(size / 1024 / 1024).toFixed(1)} MB`);
}
