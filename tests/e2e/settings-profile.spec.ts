import { expect, test, type Page } from "@playwright/test";

const password = "admin-created-password";

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
}

test.afterEach(async ({ page }) => {
  await page.request.patch("/api/v1/profiles/maya", {
    data: { avatarSlug: "hummingbird" },
  });
});

test("external setup links open separately while internal tools stay in place", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.goto("/settings");

  const extensionGuide = page.getByRole("link", {
    name: /Set up extension/,
  });
  await expect(extensionGuide).toHaveAttribute("target", "_blank");
  await expect(extensionGuide).toHaveAttribute("rel", "noopener noreferrer");
  const shortcut = page.getByRole("link", { name: /Get the Shortcut/ });
  await expect(shortcut).toHaveAttribute("href", "/api/v1/shortcut");
  await expect(shortcut).not.toHaveAttribute("target", "_blank");

  await page.goto("/welcome");
  const welcomeGuide = page.getByRole("link", { name: /Chrome extension/ });
  await expect(welcomeGuide).toHaveAttribute("target", "_blank");
  await expect(welcomeGuide).toHaveAttribute("rel", "noopener noreferrer");
  const welcomeShortcut = page.getByRole("link", {
    name: /Get the Shortcut/,
  });
  await expect(welcomeShortcut).toHaveAttribute("href", "/api/v1/shortcut");
  await expect(welcomeShortcut).not.toHaveAttribute("target", "_blank");
});

test("settings surface model failures, concise member names, and avatar selection", async ({
  page,
}) => {
  await loginAsAdmin(page);
  let testBody: unknown;
  await page.route("**/api/v1/agent/test", async (route) => {
    testBody = route.request().postDataJSON();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "The selected model did not answer." }),
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Test selected model" }).click();
  const modelError = page.getByRole("alert").filter({
    hasText: "Model test failed",
  });
  await expect(modelError).toContainText("The selected model did not answer.");
  expect(testBody).toEqual({});

  const maya = page
    .locator("#people")
    .getByRole("listitem")
    .filter({ hasText: "Maya" });
  await expect(maya).toHaveText("Maya (admin)");

  const jaguar = page.getByRole("radio", { name: "Jaguar" });
  await jaguar.click();
  await expect(jaguar).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save avatar" }).click();
  await expect(page.getByRole("status")).toContainText("Avatar saved.");
  await expect(
    page.getByRole("button", { name: "Account menu for Maya" }).locator("img"),
  ).toHaveAttribute("src", /jaguar\.png/);

  await page.reload();
  await expect(page.getByRole("radio", { name: "Jaguar" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
