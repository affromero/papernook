import fs from "node:fs";
import path from "node:path";
import { loadBindings, minify } from "next/dist/build/swc/index.js";

/**
 * Vendor the Three.js runtime used by the chat sandbox into public/vendor/.
 * The result is committed (like public/sw.js) because the Docker deps stage
 * has no public/ directory. Re-running postinstall keeps it synchronized with
 * the installed Three version.
 */

const root = new URL("..", import.meta.url).pathname;
const out = path.join(root, "public/vendor/three");
const assets = [
  ["node_modules/three/build/three.module.js", "three.module.min.js", true],
  ["node_modules/three/build/three.core.js", "three.core.min.js", true],
  [
    "node_modules/three/examples/jsm/controls/OrbitControls.js",
    "addons/controls/OrbitControls.js",
    false,
  ],
];

await loadBindings();
for (const [src, dest, shouldMinify] of assets) {
  const target = path.join(out, dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!shouldMinify) {
    fs.copyFileSync(path.join(root, src), target);
    continue;
  }
  const result = await minify(fs.readFileSync(path.join(root, src), "utf8"), {
    compress: true,
    mangle: true,
    module: true,
  });
  if (!result.code) throw new Error(`Could not minify ${src}.`);
  fs.writeFileSync(target, `${result.code}\n`);
}

// Safari rejects external ES modules inside an opaque-origin sandbox. Build
// Three and OrbitControls into a classic inline runtime so scene execution has
// no module or network boundary. The committed HTML is regenerated on every
// install to stay synchronized with the installed Three version.
const threeCjs = fs.readFileSync(
  path.join(root, "node_modules/three/build/three.cjs"),
  "utf8",
);
const controlsModule = fs.readFileSync(
  path.join(root, "node_modules/three/examples/jsm/controls/OrbitControls.js"),
  "utf8",
);
const controlsClassic = controlsModule
  .replace(
    /import\s*\{([\s\S]*?)\}\s*from\s*['"]three['"];?/,
    "const {$1} = THREE;",
  )
  .replace(/export\s*\{\s*OrbitControls\s*\};?/, "");
const runtimeSource = `
(() => {
  const exports = {};
  ((exports) => { ${threeCjs} })(exports);
  const THREE = exports;
  ${controlsClassic}
  globalThis.THREE = THREE;
  globalThis.OrbitControls = OrbitControls;
  globalThis.papernookThreeRuntimeReady = true;
  globalThis.dispatchEvent(new Event("papernook-three-runtime-ready"));
})();
`;
const minified = await minify(runtimeSource, {
  compress: true,
  mangle: true,
});
if (!minified.code)
  throw new Error("Could not build the Three sandbox runtime.");

const sandboxPath = path.join(root, "public/vendor/three-sandbox.html");
const sandbox = fs.readFileSync(sandboxPath, "utf8");
const start = "/* THREE_RUNTIME_START */";
const end = "/* THREE_RUNTIME_END */";
if (!sandbox.includes(start) || !sandbox.includes(end)) {
  throw new Error("Three sandbox runtime markers are missing.");
}
const startIndex = sandbox.indexOf(start);
const endIndex = sandbox.indexOf(end, startIndex + start.length);
if (startIndex === -1 || endIndex === -1) {
  throw new Error("Three sandbox runtime markers are malformed.");
}
const generated =
  sandbox.slice(0, startIndex) +
  `${start}\n${minified.code}\n${end}` +
  sandbox.slice(endIndex + end.length);
fs.writeFileSync(sandboxPath, generated);
