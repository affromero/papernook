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
    },
  ],
  webServer: {
    command:
      `node tests/e2e/seed.mjs && ` +
      `PAPERNOOK_DATA_DIR="${dataDir}" ` +
      `SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ` +
      `PUBLIC_EXPOSURE=true PAPERNOOK_PUBLIC_HOST=127.0.0.1 ` +
      `PAPERNOOK_PASSWORD=admin-created-password ` +
      `WEBDAV_USER=papers WEBDAV_PASS=annotate-locally ` +
      `npm run dev -- --hostname 127.0.0.1 --port 3107`,
    url: "http://127.0.0.1:3107/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
