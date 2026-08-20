import { defineConfig, devices } from "@playwright/test";

const dataDir = `${process.cwd()}/.playwright-data`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "line",
  snapshotPathTemplate: "{testDir}/../../docs/images/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:3107",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "**/safari-reader.spec.ts",
    },
    {
      // Safari-only smoke test for the reader; the screenshot journeys stay
      // on chromium because their snapshots are engine-specific.
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: "**/safari-reader.spec.ts",
    },
  ],
  webServer: {
    command:
      `node tests/e2e/seed.mjs && ` +
      `PAPERNOOK_DATA_DIR="${dataDir}" ` +
      `SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ` +
      `PAPERNOOK_PUBLIC_REQUEST_LIMIT=1000 ` +
      `PAPERNOOK_PASSWORD=admin-created-password ` +
      `PATH="${process.cwd()}/tests/e2e/bin:$PATH" AI_PROVIDER=codex ` +
      `WEBDAV_USER=papers WEBDAV_PASS=annotate-locally ` +
      `npm run dev -- --hostname 127.0.0.1 --port 3107`,
    url: "http://127.0.0.1:3107/login",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
