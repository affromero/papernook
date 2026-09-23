import { expect, test, type Page } from "@playwright/test";
import {
  enterHousehold,
  selectHouseholdProfile,
} from "./support/household-access";

/**
 * WebKit smoke test for the PDF reader. The library runs on iPads and Macs,
 * so a browser API Chromium has and Safari does not — requestIdleCallback
 * was the one that shipped — must fail here rather than in production.
 */

async function loginAsMaya(page: Page): Promise<void> {
  await enterHousehold(page);
  await selectHouseholdProfile(page, "Maya");
}

test("the reader renders a paper in WebKit without page errors", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await loginAsMaya(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");

  await expect(page.locator(".page canvas").first()).toBeVisible({
    timeout: 60_000,
  });
  // The citation-hotspot scan is scheduled off the render path; give it time
  // to run so a failure inside it counts against this test.
  await page.waitForTimeout(2_000);
  expect(pageErrors).toEqual([]);
});
