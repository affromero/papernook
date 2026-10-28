import { expect, test } from "@playwright/test";
import {
  enterHousehold,
  selectHouseholdProfile,
} from "../support/household-access";

test("logging out returns directly to the access gate after switching profiles", async ({
  page,
}) => {
  await enterHousehold(page);
  await selectHouseholdProfile(page, "Maya");
  await page.getByRole("button", { name: "Account menu for Maya" }).click();
  await page.getByRole("link", { name: "Switch profile" }).click();
  await expect(
    page.getByRole("heading", { name: "Who’s reading?" }),
  ).toBeVisible();
  await selectHouseholdProfile(page, "Maya");
  await page.getByRole("button", { name: "Account menu for Maya" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL("/login");
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Who’s reading?" }),
  ).toHaveCount(0);
});

test("a failed logout leaves the user signed in and shows an error", async ({
  page,
}) => {
  await enterHousehold(page);
  await selectHouseholdProfile(page, "Maya");
  await page.route("**/api/v1/session", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 503, body: "Unavailable" });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Account menu for Maya" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Could not log out. Try again." }),
  ).toBeVisible();
  await expect(page).toHaveURL("/");
  const response = await page.request.get("/api/v1/session");
  expect((await response.json()).profile.username).toBe("maya");
});
