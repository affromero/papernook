import { expect, test } from "@playwright/test";

test("a saved passkey signs in without offering enrollment", async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  await page.goto("/login");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-owner-password-phrase");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Use a passkey next time" }).click();
  await expect(
    page.getByRole("heading", { name: "Who’s reading?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");

  // A synced passkey can exist before this browser has any local preference.
  await page.evaluate(() => localStorage.clear());
  await context.clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(
    page.getByRole("heading", { name: "Who’s reading?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use a passkey next time" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("button", { name: "Use a passkey next time" }),
  ).toHaveCount(0);
});
