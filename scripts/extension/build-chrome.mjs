// Build the Chrome Web Store package from the shared Safari/Chrome extension.
// Only runtime files are copied, and manifest.json stays at the zip root so the
// same output works for both "Load unpacked" and Web Store upload.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const SOURCE = join(ROOT, "extension");
const OUT = join(ROOT, "build", "chrome");
const ZIP = join(ROOT, "build", "papernook-chrome.zip");
const RUNTIME_FILES = [
  "background.js",
  "manifest.json",
  "options.html",
  "options.js",
];

const manifest = JSON.parse(
  await readFile(join(SOURCE, "manifest.json"), "utf8"),
);
const packageJson = JSON.parse(
  await readFile(join(ROOT, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(join(ROOT, "package-lock.json"), "utf8"),
);

if (manifest.manifest_version !== 3) {
  throw new Error("Chrome package requires a Manifest V3 extension");
}
if (manifest.version !== packageJson.version) {
  throw new Error(
    `version mismatch: extension ${manifest.version}, package ${packageJson.version}`,
  );
}
if (
  manifest.version !== packageLock.version ||
  manifest.version !== packageLock.packages?.[""]?.version
) {
  throw new Error(
    `version mismatch: extension ${manifest.version}, package lock ${packageLock.version}`,
  );
}
const releaseVersion = process.env.PAPERNOOK_RELEASE_VERSION;
if (releaseVersion && manifest.version !== releaseVersion) {
  throw new Error(
    `release tag v${releaseVersion} does not match extension ${manifest.version}`,
  );
}

const iconPaths = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
];
const requiredFiles = [
  ...RUNTIME_FILES,
  manifest.background?.service_worker,
  manifest.options_ui?.page,
  ...iconPaths,
].filter(Boolean);
for (const relative of new Set(requiredFiles)) {
  const file = join(SOURCE, relative);
  if (!(await stat(file)).isFile()) {
    throw new Error(`manifest runtime file is missing: ${relative}`);
  }
}

await rm(OUT, { recursive: true, force: true });
await rm(ZIP, { force: true });
await mkdir(join(OUT, "icons"), { recursive: true });
for (const file of RUNTIME_FILES) {
  await cp(join(SOURCE, file), join(OUT, file));
}
for (const icon of new Set(iconPaths)) {
  await cp(join(SOURCE, icon), join(OUT, icon));
}

// Normalize generated JSON and guarantee a newline in the store artifact.
await writeFile(
  join(OUT, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
execFileSync("zip", ["-qr", ZIP, "."], { cwd: OUT });

console.log(`built ${OUT}`);
console.log(`built ${ZIP}`);
