import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const server = base.webServer;
if (!server || Array.isArray(server)) {
  throw new Error("Expected one browser fixture server");
}

export default defineConfig({
  ...base,
  testDir: "./tests/e2e",
  testMatch: "**/passkey.integration.ts",
  projects: [{ name: "chromium" }],
  use: { ...base.use, baseURL: "http://localhost:3107" },
  webServer: {
    ...server,
    command: "node tests/e2e/support/server.mjs",
    env: { ...server.env, PAPERNOOK_URL: "http://localhost:3107" },
  },
});
