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

const operator = path.resolve(".next/operator");
const dependencies = JSON.parse(
  fs.readFileSync(path.join(operator, "dependencies.json"), "utf8"),
);
for (const relative of dependencies) {
  if (
    typeof relative !== "string" ||
    !relative.startsWith("node_modules/") ||
    relative.split("/").includes("..")
  )
    throw new Error("Invalid operator dependency path");
  const target = path.join(runtime, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.resolve(relative), target);
}
fs.mkdirSync(path.join(runtime, "scripts"), { recursive: true });
fs.copyFileSync(
  path.join(operator, "access.cjs"),
  path.join(runtime, "scripts/access.cjs"),
);

console.log("Prepared allowlisted runtime artifact.");
