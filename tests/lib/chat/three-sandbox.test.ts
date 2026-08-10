import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { threeSandboxUrl } from "@/components/chat/ThreeSandbox";

const vendorDir = path.join(process.cwd(), "public/vendor");

describe("threejs sandbox", () => {
  it("round-trips arbitrary scene code through the fragment", () => {
    const code =
      "import * as THREE from 'three';\n" +
      'const s = "</script>#%&?"; // ε ≠ noise\n';
    const url = threeSandboxUrl(code);
    expect(url.startsWith("/vendor/three-sandbox.html#")).toBe(true);
    const [, fragment] = url.split("#");
    expect(decodeURIComponent(fragment)).toBe(code);
    // Nothing may leak unencoded past the fragment marker.
    expect(fragment).not.toContain("<");
    expect(fragment).not.toContain("#");
  });

  it("ships a sandbox page whose importmap stays on relative vendor paths", () => {
    const html = fs.readFileSync(
      path.join(vendorDir, "three-sandbox.html"),
      "utf8",
    );
    expect(html).toContain('"three": "./three/three.module.min.js"');
    expect(html).toContain('"three/addons/": "./three/addons/"');
    expect(html).not.toContain("https://");
  });

  it("vendors the split three build the importmap points at", () => {
    const moduleSource = fs.readFileSync(
      path.join(vendorDir, "three/three.module.min.js"),
      "utf8",
    );
    // three.module re-exports from the core file; both must ship together.
    expect(moduleSource).toContain("three.core.min.js");
    expect(fs.existsSync(path.join(vendorDir, "three/three.core.min.js"))).toBe(
      true,
    );
    expect(
      fs.existsSync(
        path.join(vendorDir, "three/addons/controls/OrbitControls.js"),
      ),
    ).toBe(true);
  });
});
