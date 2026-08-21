import { expect, test, type Page } from "@playwright/test";

/**
 * WebKit smoke test for the PDF reader. The library runs on iPads and Macs,
 * so a browser API Chromium has and Safari does not — requestIdleCallback
 * was the one that shipped — must fail here rather than in production.
 */

const password = "admin-created-password";

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  const field = page.getByRole("textbox", { name: "Password" });
  const enter = page.getByRole("button", { name: "Enter" });
  // A fill() that lands before React hydrates sets the native value without
  // the component ever seeing it, so the gate's Enter — disabled while its
  // state holds an empty password — never enables. WebKit on CI loses that
  // race often enough to matter; retry the fill until the button reacts.
  await expect(async () => {
    await field.fill(password);
    await expect(enter).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
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
