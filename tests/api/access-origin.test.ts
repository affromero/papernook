import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-access-origin-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.stubEnv("PAPERNOOK_URL", "https://papers.example");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("offers passkeys through the configured HTTPS reverse proxy origin", async () => {
  const { accessHandler } = await import("@/lib/auth/access");
  const response = await accessHandler()(
    new Request("http://app:3000/api/v1/access/capabilities", {
      headers: {
        Host: "app:3000",
        "X-Sidedoor-Origin": "https://papers.example",
      },
    }),
    "capabilities",
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    password: true,
    passkeys: true,
  });
});
