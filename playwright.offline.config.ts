import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: "**/offline-library.spec.ts",
  projects: [
    {
      name: "offline-android",
      use: { ...devices["Pixel 7"], serviceWorkers: "allow" },
    },
    {
      name: "offline-iphone",
      use: { ...devices["iPhone 13"], serviceWorkers: "allow" },
    },
  ],
});
