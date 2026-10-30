import fs from "node:fs";
import path from "node:path";
import { withShareFiles, type PaperShare } from "../../library/shares";
import { companionDir } from "../../library/papers";
import { emptyArtifacts, type ArtifactSnapshot } from "./schema";
import { validateArtifacts } from "./snapshot";
import { SharingError } from "../protocol/values";

export function readPublishedArtifacts(share: PaperShare): ArtifactSnapshot {
  if (!share.includeArtifacts) return emptyArtifacts();
  return withShareFiles(share, () => {
    const file = path.join(
      companionDir(share.topic, share.slug),
      "collaboration",
      share.id,
      "artifacts.json",
    );
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024)
      throw new SharingError(
        "The shared artifact snapshot is unavailable.",
        503,
      );
    return validateArtifacts(JSON.parse(fs.readFileSync(file, "utf8")));
  });
}
