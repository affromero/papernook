import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataRoot } from "../data-dir";

const licenseKeySchema = z.string().trim().min(1).max(10_000);
const configSchema = z
  .object({
    tldrawLicenseKey: licenseKeySchema,
  })
  .strict();

export type CanvasLicenseSource = "file" | "environment" | null;

export interface CanvasLicenseConfig {
  licenseKey: string | null;
  source: CanvasLicenseSource;
}

export class CanvasConfigError extends Error {}

const FILE = () => path.join(dataRoot(), "canvas-config.json");

function storedLicenseKey(): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(FILE(), "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw new CanvasConfigError("The canvas configuration could not be read.");
  }

  const parsed = configSchema.safeParse(
    (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success) {
    throw new CanvasConfigError("The saved canvas configuration is invalid.");
  }
  return parsed.data.tldrawLicenseKey;
}

function environmentLicenseKey(): string | null {
  const value = process.env.TLDRAW_LICENSE_KEY?.trim();
  if (!value) return null;
  const parsed = licenseKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new CanvasConfigError(
      "The TLDRAW_LICENSE_KEY environment value is invalid.",
    );
  }
  return parsed.data;
}

export function configuredCanvasLicense(): CanvasLicenseConfig {
  const stored = storedLicenseKey();
  if (stored) return { licenseKey: stored, source: "file" };
  const environment = environmentLicenseKey();
  if (environment) {
    return { licenseKey: environment, source: "environment" };
  }
  return { licenseKey: null, source: null };
}

export function setCanvasLicenseKey(licenseKey: string | null): void {
  if (licenseKey === null) {
    try {
      fs.rmSync(FILE());
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw new CanvasConfigError(
          "The canvas configuration could not be removed.",
        );
      }
    }
    return;
  }

  const parsed = licenseKeySchema.safeParse(licenseKey);
  if (!parsed.success) {
    throw new CanvasConfigError("Enter a valid tldraw license key.");
  }
  fs.mkdirSync(dataRoot(), { recursive: true });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ tldrawLicenseKey: parsed.data }, null, 2),
    { mode: 0o600 },
  );
  fs.renameSync(tmp, FILE());
}

export function tldrawLicenseRequired(
  protocol: string,
  hostname: string,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  const lowerHost = hostname.toLowerCase();
  const normalizedHost = lowerHost.startsWith("[")
    ? lowerHost.slice(1, lowerHost.indexOf("]"))
    : lowerHost.split(":")[0];
  const loopback =
    normalizedHost === "localhost" ||
    normalizedHost === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalizedHost);
  return nodeEnv === "production" && protocol === "https" && !loopback;
}
