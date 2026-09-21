import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
const directory = path.resolve(".next/operator");
const output = path.join(directory, "access.cjs");
await build({
  entryPoints: ["scripts/sidedoor/access.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  packages: "external",
});
const { fileList } = await nodeFileTrace([output], { base: process.cwd() });
const dependencies = [...fileList].filter((file) =>
  file.startsWith("node_modules/"),
);
await fs.writeFile(
  path.join(directory, "dependencies.json"),
  JSON.stringify(dependencies),
);
