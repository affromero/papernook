import fs from "node:fs";
import path from "node:path";

const files = [
  "node_modules/@tldraw/editor/dist-esm/lib/editor/managers/FontManager/FontManager.mjs",
  "node_modules/@tldraw/editor/dist-cjs/lib/editor/managers/FontManager/FontManager.js",
];

const methodLine = "  setFontState(font, state) {";
const updateLine =
  "    this.fontStates.update(font, (s) => ({ ...s, state }));";
const updateBlock = [methodLine, updateLine].join("\n");
const guard =
  "    if (this.editor.isDisposed || !this.fontStates.has(font)) return;";
const guardedBlock = [methodLine, guard, updateLine].join("\n");

for (const relativeFile of files) {
  const file = path.join(process.cwd(), relativeFile);
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(guardedBlock)) continue;
  if (!source.includes(updateBlock)) {
    throw new Error(`Unsupported tldraw FontManager build: ${relativeFile}`);
  }
  const patched = source.replaceAll(updateBlock, guardedBlock);
  fs.writeFileSync(file, patched);
}
