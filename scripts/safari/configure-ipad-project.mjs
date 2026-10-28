// The converter regenerates its project on every build. Set target-specific
// signing profiles after conversion so the app and extension sign separately.
import { readFile, writeFile } from "node:fs/promises";

const project = process.argv[2];
if (!project)
  throw new Error("usage: configure-ipad-project.mjs <project.pbxproj>");
let contents = await readFile(project, "utf8");
for (const [bundle, profile] of [
  ["co.afromero.papernook", "papernook iOS App Store"],
  ["co.afromero.papernook.Extension", "papernook Extension iOS App Store"],
]) {
  let changed = 0;
  contents = contents.replace(
    /buildSettings = \{[\s\S]*?\n\s*\};/g,
    (settings) => {
      if (!settings.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${bundle};`))
        return settings;
      if (!settings.includes("CODE_SIGN_STYLE = Automatic;"))
        throw new Error(`Unexpected signing settings for ${bundle}`);
      changed++;
      return settings.replace(
        "CODE_SIGN_STYLE = Automatic;",
        `CODE_SIGN_STYLE = Manual;\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "${profile}";`,
      );
    },
  );
  if (changed !== 2)
    throw new Error(
      `Expected two build configurations for ${bundle}, found ${changed}`,
    );
}
await writeFile(project, contents);
