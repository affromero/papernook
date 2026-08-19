// Chrome Web Store small promo tile (440x280, required for the listing).
// Renders the app mark on the same warm paper gradient as the macOS app icon
// (scripts/safari/appicon.mjs) so the store tile and the installed icon match.
//
//   node scripts/store/promo-tile.mjs
//
// Writes build/screenshots/promo-tile-440x280.png. Google shows this tile at
// small sizes in search results, so it stays to a mark, the wordmark, and one
// short line — no paragraph text, no transparency.
import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = join(ROOT, "build", "screenshots");
const W = 440;
const H = 280;

const svg = await readFile(join(ROOT, "src", "app", "icon.svg"), "utf8");
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});
await page.setContent(
  `<style>
     *{margin:0;box-sizing:border-box}
     html,body{width:${W}px;height:${H}px}
     .tile{width:${W}px;height:${H}px;padding:0 40px;
       background:linear-gradient(160deg,#f7f2e8,#ece1cc);
       display:flex;align-items:center;gap:28px;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
     .mark{width:104px;height:104px;flex:none;display:block}
     .name{font-size:38px;font-weight:600;letter-spacing:-0.02em;color:#2D2721;line-height:1}
     .rule{width:48px;height:4px;border-radius:2px;background:#DD9A3C;margin:14px 0 12px}
     .tag{font-size:17px;line-height:1.35;color:#6d5c45}
   </style>
   <div class="tile">
     <div class="mark">${svg}</div>
     <div>
       <div class="name">papernook</div>
       <div class="rule"></div>
       <div class="tag">Read research PDFs<br>in your own library</div>
     </div>
   </div>`,
);
await writeFile(
  join(OUT, "promo-tile-440x280.png"),
  await page.screenshot({ type: "png" }),
);
await browser.close();
console.log(`promo tile: ${join(OUT, "promo-tile-440x280.png")} (${W}x${H})`);
