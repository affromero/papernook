import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const docsDir = path.join(root, "docs");
const markdownFiles = [
  path.join(root, "README.md"),
  path.join(root, "SECURITY.md"),
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
      expect(fs.statSync(screenshot).size).toBeGreaterThan(10_000);
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
});
