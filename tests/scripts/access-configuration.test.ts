import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

let directory: string;
const root = path.resolve(import.meta.dirname, "../..");
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-config-"));
  buildSync({
    entryPoints: [path.join(root, "scripts/sidedoor/access.ts")],
    outfile: path.join(directory, "access.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    packages: "external",
  });
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function run(args: string[], origin: string, aliases = "[]") {
  return spawnSync(
    process.execPath,
    [path.join(directory, "access.cjs"), ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_PATH: path.join(root, "node_modules"),
        PAPERNOOK_DATA_DIR: path.join(directory, "untouched-data"),
        PAPERNOOK_URL: origin,
        SIDEDOOR_PASSWORD_ORIGINS: aliases,
      },
    },
  );
}

it("validates canonical and password-only origins without creating identity storage", () => {
  const result = run(
    ["validate-config"],
    "https://papers.example/",
    '["http://192.168.1.5:3000"]',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("Access origin configuration is valid.\n");
  expect(fs.existsSync(path.join(directory, "untouched-data"))).toBe(false);
});

it.each(["validate-config", "initialize"])(
  "rejects invalid origins before %s can write identity state",
  (command) => {
    for (const [origin, aliases] of [
      ["https://papers.example/private", "[]"],
      ["https://papers.example", '["https://papers.example:443/"]'],
      ["https://papers.example", '["https://user:password@alias.example"]'],
      ["https://papers.example", '{"invalid":true}'],
    ]) {
      const result = run([command], origin!, aliases!);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Access command failed:");
      expect(result.stderr).not.toContain("user:password");
      expect(fs.existsSync(path.join(directory, "untouched-data"))).toBe(false);
    }
  },
);

it("rejects extra preflight arguments before accessing configuration or storage", () => {
  const result = run(["validate-config", "extra"], "not-a-url");
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(fs.existsSync(path.join(directory, "untouched-data"))).toBe(false);
});
