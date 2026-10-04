import { expect, type Page } from "@playwright/test";

const password = "browser-owner-password-phrase";

export async function finishHouseholdAdmission(page: Page): Promise<void> {
  const picker = page.getByRole("heading", { name: "Who’s reading?" });
  const skip = page.getByRole("button", {
    name: "Continue without a passkey",
  });
  await expect(picker.or(skip)).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await expect(picker).toBeVisible();
}

export async function enterHousehold(page: Page): Promise<void> {
  await page.goto("/login");
  const continueButton = page
    .locator("form")
    .getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeEnabled();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await continueButton.click();
  await finishHouseholdAdmission(page);
}

export async function selectHouseholdProfile(
  page: Page,
  name: string,
): Promise<void> {
  await page.getByRole("button", { name: `Switch to ${name}` }).click();
  await expect(page).toHaveURL("/");
}
