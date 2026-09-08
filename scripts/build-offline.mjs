import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { build } from "esbuild";

const destination = path.resolve("public/offline");
await fs.mkdir(destination, { recursive: true });
await build({
  entryPoints: ["src/lib/offline/app.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: path.join(destination, "app.js"),
  minify: true,
});
await fs.copyFile(
  "src/lib/offline/shell.html",
  path.join(destination, "index.html"),
);
await fs.copyFile(
  "src/lib/offline/shell.css",
  path.join(destination, "app.css"),
);
await fs.mkdir(path.join(destination, "pdf"), { recursive: true });
for (const filename of ["pdf.mjs", "pdf.worker.mjs"])
  await fs.copyFile(
    `node_modules/pdfjs-dist/build/${filename}`,
    path.join(destination, "pdf", filename),
  );
for (const folder of ["cmaps", "standard_fonts", "wasm"])
  await fs.cp(
    `node_modules/pdfjs-dist/${folder}`,
    path.join(destination, "pdf", folder),
    { recursive: true },
  );
const files = (
  await fs.readdir(destination, { recursive: true, withFileTypes: true })
)
  .filter((entry) => entry.isFile() && entry.name !== "precache.json")
  .map((entry) =>
    path
      .relative(destination, path.join(entry.parentPath, entry.name))
      .replaceAll(path.sep, "/"),
  )
  .sort();
const hash = crypto.createHash("sha256");
for (const filename of files)
  hash.update(await fs.readFile(path.join(destination, filename)));
const version = hash.digest("hex").slice(0, 16);
await fs.writeFile(
  path.join(destination, "precache.json"),
  JSON.stringify({
    version,
    urls: files.map((filename) => `/offline/${filename}`),
  }),
);
const worker = await fs.readFile("src/lib/offline/worker.js", "utf8");
await fs.writeFile(
  "public/sw.js",
  worker.replaceAll("__OFFLINE_VERSION__", version),
);
