import fs from "node:fs";
import path from "node:path";

const files = [
  "node_modules/@tldraw/editor/dist-esm/lib/editor/managers/FontManager/FontManager.mjs",
  "node_modules/@tldraw/editor/dist-cjs/lib/editor/managers/FontManager/FontManager.js",
];

const readyLine =
  '        this.fontStates.update(font, (s) => ({ ...s, state: "ready" }));';
const errorLine =
  '        this.fontStates.update(font, (s) => ({ ...s, state: "error" }));';
const guard =
  "        if (this.editor.isDisposed || !this.fontStates.has(font)) return;";

for (const relativeFile of files) {
  const file = path.join(process.cwd(), relativeFile);
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(`${guard}\n${readyLine}`)) continue;
  if (!source.includes(readyLine) || !source.includes(errorLine)) {
    throw new Error(`Unsupported tldraw FontManager build: ${relativeFile}`);
  }
  const patched = source
    .replace(readyLine, `${guard}\n${readyLine}`)
    .replace(errorLine, `${guard}\n${errorLine}`);
  fs.writeFileSync(file, patched);
}
