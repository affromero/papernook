import fs from "node:fs";
import { build } from "esbuild";

const directory = new URL(
  "../../public/vendor/conversations/",
  import.meta.url,
);
const result = await build({
  entryPoints: [new URL("sandbox.ts", import.meta.url).pathname],
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: ["es2022"],
  write: false,
});
const runtime = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
  new URL("sandbox.html", directory),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light}body{margin:0;padding:16px;font:16px/1.5 system-ui;color:#171717;background:#fff}img,svg,canvas{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><script>${runtime}</script></body></html>`,
);
