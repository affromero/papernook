import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
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
  let source = fs.readFileSync(path.join(root, src), "utf8");
  if (dest === "three.module.min.js") {
    source = source.replaceAll("./three.core.js", "./three.core.min.js");
  }
  const result = await minify(source, {
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
const runtimeBuild = await build({
  stdin: {
    contents: `
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
if (!THREE.WebGLRenderer) throw new Error("Three.js runtime is incomplete.");
(() => {
  globalThis.THREE = THREE;
  globalThis.OrbitControls = OrbitControls;
  globalThis.papernookThreeRuntimeReady = true;
  globalThis.dispatchEvent(new Event("papernook-three-runtime-ready"));
})();
`,
    resolveDir: root,
    sourcefile: "three-sandbox-runtime.js",
    loader: "js",
  },
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  supported: { "template-literal": false },
  target: ["es2022"],
  write: false,
});
const bundledRuntime = runtimeBuild.outputFiles?.[0]?.text;
if (!bundledRuntime)
  throw new Error("Could not bundle the Three sandbox runtime.");
const minifiedRuntime = await minify(bundledRuntime, {
  compress: true,
  mangle: true,
});
if (!minifiedRuntime.code)
  throw new Error("Could not minify the Three sandbox runtime.");

const sandboxTemplatePath = path.join(
  root,
  "scripts/three-sandbox.template.html",
);
const sandboxPath = path.join(root, "public/vendor/three-sandbox.html");
const sandbox = fs.readFileSync(sandboxTemplatePath, "utf8");
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
let generated =
  sandbox.slice(0, startIndex) +
  `${start}\n${minifiedRuntime.code}\n${end}` +
  sandbox.slice(endIndex + end.length);
const executionStart = "/* SCENE_EXECUTION_START */";
const executionEnd = "/* SCENE_EXECUTION_END */";
if (!generated.includes(executionStart) || !generated.includes(executionEnd)) {
  throw new Error("Three sandbox execution markers are missing.");
}
generated = generated.replace(
  `${executionStart}\n            ${executionEnd}`,
  `${executionStart}\n            // Scene code runs only in this sandboxed opaque-origin frame.\n            script.textContent = compatibleSceneCode(code);\n            ${executionEnd}`,
);
fs.mkdirSync(path.dirname(sandboxPath), { recursive: true });
fs.writeFileSync(sandboxPath, generated);
