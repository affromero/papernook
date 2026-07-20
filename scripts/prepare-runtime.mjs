import fs from "node:fs";
import path from "node:path";

const standalone = path.resolve(".next/standalone");
const runtime = path.resolve(".next/runtime");
const required = ["server.js", "package.json", ".next", "node_modules"];

if (!fs.existsSync(standalone)) {
  throw new Error("Missing .next/standalone; run next build first.");
}

fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(runtime, { recursive: true });

for (const entry of required) {
  const source = path.join(standalone, entry);
  if (!fs.existsSync(source)) {
    throw new Error(`Standalone output is missing required entry: ${entry}`);
  }
  fs.cpSync(source, path.join(runtime, entry), {
    recursive: true,
    verbatimSymlinks: true,
  });
}

console.log("Prepared allowlisted runtime artifact.");
