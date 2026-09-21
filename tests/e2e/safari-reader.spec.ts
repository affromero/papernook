import { expect, test, type Page } from "@playwright/test";

/**
 * WebKit smoke test for the PDF reader. The library runs on iPads and Macs,
 * so a browser API Chromium has and Safari does not — requestIdleCallback
 * was the one that shipped — must fail here rather than in production.
 */

const password = "browser-owner-password-phrase";

async function loginAsAdmin(page: Page): Promise<void> {
  const capabilities = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/access/capabilities") && response.ok(),
  );
  await page.goto("/login");
  await capabilities;
  const field = page.getByLabel("Password", { exact: true });
  const enter = page
    .locator("form")
    .getByRole("button", { name: "Enter household", exact: true });
  await field.fill(password);
  await expect(field).toHaveValue(password);
  await enter.click();
  await expect(
    page.getByRole("heading", { name: "Who’s reading?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
}

test("the reader renders a paper in WebKit without page errors", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await loginAsAdmin(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");

  await expect(page.locator(".page canvas").first()).toBeVisible({
    timeout: 60_000,
  });
  // The citation-hotspot scan is scheduled off the render path; give it time
  // to run so a failure inside it counts against this test.
  await page.waitForTimeout(2_000);
  expect(pageErrors).toEqual([]);
});
