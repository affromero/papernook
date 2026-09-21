import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProfileCapability } from "../../auth/profile-capability";
import { isValidSlug } from "../../library/slug";

const ownerSchema = z
  .object({
    username: z.string().refine(isValidSlug),
    generation: z.number().int().nonnegative(),
  })
  .strict();
const OWNER_FILE = "capture-owner.json";

/** Publish ownership durably before any private bytes enter a capture directory. */
export function writeCaptureOwner(
  directory: string,
  capability: ProfileCapability,
): void {
  const owner = ownerSchema.parse(capability);
  fs.writeFileSync(path.join(directory, OWNER_FILE), JSON.stringify(owner), {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  for (const target of [directory, path.dirname(directory)]) {
    const descriptor = fs.openSync(target, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

/** The record travels with title and topic renames, including incomplete captures. */
export function readCaptureOwner(directory: string): ProfileCapability | null {
  try {
    return ownerSchema.parse(
      JSON.parse(fs.readFileSync(path.join(directory, OWNER_FILE), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export function clearCaptureOwner(directory: string): void {
  fs.rmSync(path.join(directory, OWNER_FILE), { force: true });
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
