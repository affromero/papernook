// Populate the macOS AppIcon.appiconset in the (regenerated) Safari wrapper.
// safari-web-extension-converter leaves the icon slots empty, which App Store
// review rejects, so scripts/safari/build.sh calls this after the converter
// and before the archive. Renders src/app/icon.svg on a warm paper tile at
// every required size using the repo's Playwright Chromium.
//   node scripts/safari/appicon.mjs <path-to-AppIcon.appiconset>
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const iconset = process.argv[2];
if (!iconset) throw new Error("usage: appicon.mjs <AppIcon.appiconset dir>");

const svg = await readFile(join(ROOT, "src", "app", "icon.svg"), "utf8");

// macOS icon slots: size (pt) x scale -> pixel side. The system icon grid
// insets the glyph, so the logo fills ~62% of a rounded tile (Apple's ~22.37%
// corner radius superellipse, approximated with border-radius).
const SLOTS = [
  [16, 1],
  [16, 2],
  [32, 1],
  [32, 2],
  [128, 1],
  [128, 2],
  [256, 1],
  [256, 2],
  [512, 1],
  [512, 2],
];
const pixels = [...new Set(SLOTS.map(([s, sc]) => s * sc))];

const page = await (await chromium.launch()).newPage();
const render = async (px) => {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(
    `<style>*{margin:0}html,body{width:${px}px;height:${px}px}
     .tile{width:${px}px;height:${px}px;border-radius:${Math.round(px * 0.2237)}px;
       background:linear-gradient(160deg,#f7f2e8,#ece1cc);
       display:flex;align-items:center;justify-content:center;overflow:hidden}
     .tile svg{width:${Math.round(px * 0.62)}px;height:${Math.round(px * 0.62)}px;display:block}</style>
     <div class="tile">${svg}</div>`,
  );
  await writeFile(
    join(iconset, `icon_${px}.png`),
    await page.screenshot({ omitBackground: true }),
  );
};
for (const px of pixels) await render(px);
await page.context().browser().close();

// Rewrite Contents.json to reference the generated files.
const images = SLOTS.map(([size, scale]) => ({
  idiom: "mac",
  size: `${size}x${size}`,
  scale: `${scale}x`,
  filename: `icon_${size * scale}.png`,
}));
await writeFile(
  join(iconset, "Contents.json"),
  JSON.stringify({ images, info: { version: 1, author: "xcode" } }, null, 2) +
    "\n",
);
console.log(
  `app icon: wrote ${pixels.length} PNGs + Contents.json to ${iconset}`,
);
