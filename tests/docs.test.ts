import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const docsDir = path.join(root, "docs");
const markdownFiles = [
  path.join(root, "README.md"),
  path.join(root, "PRIVACY.md"),
  path.join(root, "SECURITY.md"),
  path.join(root, "extension", "README.md"),
  path.join(root, "store", "listings.md"),
  path.join(root, "store", "REVIEWERS.md"),
  ...fs
    .readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(docsDir, name)),
];

function localTargets(markdown: string): string[] {
  const markdownTargets = [
    ...markdown.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
  ].map((match) => match[1]);
  const htmlImages = [...markdown.matchAll(/<img\s+[^>]*src="([^"]+)"/g)].map(
    (match) => match[1],
  );
  return [...markdownTargets, ...htmlImages].filter(
    (target) =>
      !target.startsWith("#") &&
      !target.startsWith("http://") &&
      !target.startsWith("https://") &&
      !target.startsWith("mailto:"),
  );
}

function targetPath(markdownFile: string, target: string): string {
  const withoutAnchor = target.split("#", 1)[0].split("?", 1)[0];
  if (!withoutAnchor) return markdownFile;
  return path.resolve(
    path.dirname(markdownFile),
    decodeURIComponent(withoutAnchor),
  );
}

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    anchors.add(
      match[1]
        .trim()
        .toLowerCase()
        .replace(/[`*_~]/g, "")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-"),
    );
  }
  return anchors;
}

function pngDimensions(file: string): { width: number; height: number } {
  const header = fs.readFileSync(file).subarray(0, 24);
  expect(header.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function filesBelow(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(resolved) : [resolved];
  });
}

describe("documentation", () => {
  it("keeps every local link and image reference valid", () => {
    const missing: string[] = [];
    for (const markdownFile of markdownFiles) {
      const markdown = fs.readFileSync(markdownFile, "utf8");
      for (const target of localTargets(markdown)) {
        const resolved = targetPath(markdownFile, target);
        if (!fs.existsSync(resolved)) {
          missing.push(
            `${path.relative(root, markdownFile)} -> ${path.relative(root, resolved)}`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps local heading links attached to real sections", () => {
    const invalid: string[] = [];
    for (const markdownFile of markdownFiles) {
      const markdown = fs.readFileSync(markdownFile, "utf8");
      const targets = [...markdown.matchAll(/\[[^\]]*]\(([^)\s]+)\)/g)].map(
        (match) => match[1],
      );
      for (const target of targets) {
        if (
          !target.includes("#") ||
          target.startsWith("http://") ||
          target.startsWith("https://")
        ) {
          continue;
        }
        const [fileTarget, anchor] = target.split("#", 2);
        const resolved = targetPath(markdownFile, fileTarget);
        if (
          !fs.existsSync(resolved) ||
          !headingAnchors(fs.readFileSync(resolved, "utf8")).has(anchor)
        ) {
          invalid.push(`${path.relative(root, markdownFile)} -> ${target}`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });

  it("lists every user guide on the documentation home", () => {
    const home = fs.readFileSync(path.join(docsDir, "README.md"), "utf8");
    const guides = fs
      .readdirSync(docsDir)
      .filter((name) => name.endsWith(".md") && name !== "README.md");

    expect(guides.length).toBeGreaterThan(0);
    for (const guide of guides) expect(home).toContain(`](${guide}`);
  });

  it("ships a substantial gallery of readable product screenshots", () => {
    const home = fs.readFileSync(path.join(docsDir, "README.md"), "utf8");
    const screenshots = [
      ...home.matchAll(/!\[[^\]]+]\((images\/[^)]+\.png)\)/g),
    ].map((match) => path.join(docsDir, match[1]));

    expect(new Set(screenshots).size).toBeGreaterThanOrEqual(8);
    for (const screenshot of screenshots) {
      const { width, height } = pngDimensions(screenshot);
      expect(fs.statSync(screenshot).size).toBeGreaterThan(2_500);
      expect(width).toBeGreaterThanOrEqual(500);
      expect(height).toBeGreaterThanOrEqual(350);
    }
  });

  it("does not leave orphaned screenshot assets", () => {
    const allDocumentation = markdownFiles
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const screenshots = filesBelow(path.join(docsDir, "images"))
      .filter((file) => file.endsWith(".png"))
      .map((file) => path.relative(docsDir, file));

    expect(screenshots.length).toBeGreaterThanOrEqual(8);
    for (const screenshot of screenshots) {
      expect(allDocumentation).toContain(screenshot);
    }
  });

  it("backs every documentation screenshot with a Playwright snapshot", () => {
    const spec = fs.readFileSync(
      path.join(root, "tests", "e2e", "docs-screenshots.spec.ts"),
      "utf8",
    );
    const asserted = new Set(
      [
        ...spec.matchAll(
          /toHaveScreenshot\(\s*\["([^"]+)",\s*"([^"]+\.png)"\]/g,
        ),
      ].map((match) => `${match[1]}/${match[2]}`),
    );
    const screenshots = filesBelow(path.join(docsDir, "images"))
      .filter((file) => file.endsWith(".png"))
      .map((file) => path.relative(path.join(docsDir, "images"), file));

    expect(asserted).toEqual(new Set(screenshots));
  });

  it("clones the current release tag in the install instructions", () => {
    // The README pins a tag so the documented install is reproducible, which
    // means it goes stale on every release unless something fails loudly.
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const { version } = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );

    expect(readme).toContain(`git clone --branch v${version} --depth 1`);
  });

  it("serves the same privacy policy at both published URLs", () => {
    // The live Mac App Store listing points at store/PRIVACY.md and the
    // Chrome listing at the root copy; Apple locks the privacy URL until a
    // new app version, so both paths must resolve until 0.2.0 repoints
    // Apple at the root and this duplicate goes away.
    const rootPolicy = fs.readFileSync(path.join(root, "PRIVACY.md"), "utf8");
    const storePolicy = fs.readFileSync(
      path.join(root, "store", "PRIVACY.md"),
      "utf8",
    );
    expect(storePolicy).toBe(rootPolicy);
  });

  it("points Chrome users at the live store item and keeps the build path", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const extensionGuide = fs.readFileSync(
      path.join(root, "extension", "README.md"),
      "utf8",
    );
    const listing = fs.readFileSync(
      path.join(root, "store", "listings.md"),
      "utf8",
    );
    const settings = fs.readFileSync(
      path.join(root, "src", "app", "settings", "page.tsx"),
      "utf8",
    );

    expect(readme).toContain("logo=googlechrome");
    expect(readme).toContain("manifest-v3");
    // The listing is live: both guides must link the real item, not a guessed
    // slug URL, and must keep the load-unpacked path for unreleased builds.
    expect(readme).toContain(
      "chromewebstore.google.com/detail/cglnjlhkdgahafajfimnaonnlapecpfh",
    );
    expect(extensionGuide).toContain(
      "chromewebstore.google.com/detail/cglnjlhkdgahafajfimnaonnlapecpfh",
    );
    expect(extensionGuide).toContain("Load unpacked");
    expect(extensionGuide).toContain("npm run test:chrome");
    expect(extensionGuide).toContain("The first submission was manual");
    expect(listing).toContain("## Chrome Web Store");
    expect(listing).toContain("web-browsing activity");
    expect(settings).toContain("Set up extension");
    expect(settings).toContain("Bookmarklet fallback");
  });
});
