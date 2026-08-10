import fs from "node:fs";
import path from "node:path";

/**
 * Copy the three.js runtime the chat ThreeSandbox iframe imports into
 * public/vendor/. The result is COMMITTED (like public/sw.js): the Docker
 * deps stage has no public/, so a postinstall-only copy would silently
 * ship an image without it. Re-runs on postinstall to pick up upgrades.
 * three.module.min.js re-exports from ./three.core.min.js, so both ship.
 */

const root = new URL("..", import.meta.url).pathname;
const out = path.join(root, "public/vendor/three");
const copies = [
  ["node_modules/three/build/three.module.min.js", "three.module.min.js"],
  ["node_modules/three/build/three.core.min.js", "three.core.min.js"],
  [
    "node_modules/three/examples/jsm/controls/OrbitControls.js",
    "addons/controls/OrbitControls.js",
  ],
];

for (const [src, dest] of copies) {
  const target = path.join(out, dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, src), target);
}
