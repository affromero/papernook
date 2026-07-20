import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-canvas-config-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", tmpDir);
  vi.stubEnv("TLDRAW_LICENSE_KEY", "");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("canvas license configuration", () => {
  it("uses a stored key before the environment and reveals the environment after removal", async () => {
    vi.stubEnv("TLDRAW_LICENSE_KEY", "tldraw-environment-key");
    const config = await import("@/lib/canvas/config");

    config.setCanvasLicenseKey("tldraw-stored-key");
    expect(config.configuredCanvasLicense()).toEqual({
      licenseKey: "tldraw-stored-key",
      source: "file",
    });

    config.setCanvasLicenseKey(null);
    expect(config.configuredCanvasLicense()).toEqual({
      licenseKey: "tldraw-environment-key",
      source: "environment",
    });
  });

  it("surfaces corrupt filesystem configuration instead of falling back", async () => {
    vi.stubEnv("TLDRAW_LICENSE_KEY", "tldraw-environment-key");
    fs.writeFileSync(path.join(tmpDir, "canvas-config.json"), "{broken");
    const config = await import("@/lib/canvas/config");

    expect(() => config.configuredCanvasLicense()).toThrow(
      "The saved canvas configuration is invalid.",
    );
  });

  it("matches tldraw production-origin license requirements", async () => {
    const { tldrawLicenseRequired } = await import("@/lib/canvas/config");

    expect(
      tldrawLicenseRequired("https", "papernook.example", "production"),
    ).toBe(true);
    expect(
      tldrawLicenseRequired("http", "papernook.example", "production"),
    ).toBe(false);
    expect(tldrawLicenseRequired("https", "127.0.0.1:3000", "production")).toBe(
      false,
    );
    expect(tldrawLicenseRequired("https", "[::1]:3000", "production")).toBe(
      false,
    );
    expect(
      tldrawLicenseRequired("https", "papernook.example", "development"),
    ).toBe(false);
  });
});
