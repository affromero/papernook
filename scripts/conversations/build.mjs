import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const directory = new URL(
  "../../public/vendor/conversations/",
  import.meta.url,
);
const result = await build({
  entryPoints: [new URL("sandbox.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  splitting: true,
  metafile: true,
  entryNames: "[name]-[hash]",
  minify: true,
  platform: "browser",
  target: ["es2022"],
  outdir: directory.pathname,
  define: {
    PAPERNOOK_ARTIFACT_CSS: JSON.stringify(
      fs.readFileSync(
        new URL("../../node_modules/tailwindcss/theme.css", import.meta.url),
        "utf8",
      ) +
        fs.readFileSync(
          new URL(
            "../../node_modules/tailwindcss/preflight.css",
            import.meta.url,
          ),
          "utf8",
        ) +
        "\n@tailwind utilities;\n",
    ),
  },
});
const entry = Object.entries(result.metafile.outputs).find(
  ([, output]) => output.entryPoint === "scripts/conversations/sandbox.ts",
);
if (!entry) throw new Error("Conversation preview runtime was not built.");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
  new URL("sandbox.html", directory),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light}body{margin:0;padding:16px;font:16px/1.5 system-ui;color:#171717;background:#fff}img,svg,canvas{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%;overflow:auto}td,th{border:1px solid #ccc;padding:8px}output{margin-left:12px}meter{display:block;width:100%;margin:8px 0}</style></head><body><script type="module" src="./${path.basename(entry[0])}"></script></body></html>`,
);
