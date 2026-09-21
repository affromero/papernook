import { validateAccessOrigins } from "thesidedoor-core/access/http";

export function accessOrigins() {
  let aliases: unknown = [];
  try {
    if (process.env.SIDEDOOR_PASSWORD_ORIGINS)
      aliases = JSON.parse(process.env.SIDEDOOR_PASSWORD_ORIGINS);
  } catch {
    throw new Error(
      "SIDEDOOR_PASSWORD_ORIGINS must be a JSON array of origins",
    );
  }
  if (
    !Array.isArray(aliases) ||
    !aliases.every((origin) => typeof origin === "string")
  )
    throw new Error(
      "SIDEDOOR_PASSWORD_ORIGINS must be a JSON array of origins",
    );
  return validateAccessOrigins({
    origin: process.env.PAPERNOOK_URL || "http://localhost:3000",
    passwordOrigins: aliases,
  });
}
