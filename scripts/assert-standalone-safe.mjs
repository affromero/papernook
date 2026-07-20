import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".next/runtime");
const forbidden = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)data\//,
  /(^|\/)docs\//,
  /(^|\/)src\//,
  /(^|\/)tests\//,
  /(^|\/)(AGENTS|CLAUDE)\.md$/,
];

if (!fs.existsSync(root)) {
  throw new Error(`Missing runtime artifact: ${root}`);
}

const leaked = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (forbidden.some((pattern) => pattern.test(relative)))
      leaked.push(relative);
    if (entry.isDirectory()) walk(absolute);
  }
}
walk(root);

if (leaked.length > 0) {
  throw new Error(`Unsafe standalone files:\n${leaked.join("\n")}`);
}
console.log(
  "Standalone artifact contains no private data or repository source.",
);
