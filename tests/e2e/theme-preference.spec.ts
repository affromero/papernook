import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page
    .getByRole("textbox", { name: "Password" })
    .fill("admin-created-password");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
}

test("system theme follows device changes and can be restored after a manual choice", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  const select = page.getByRole("combobox", { name: "Color theme" });
  const html = page.locator("html");
  await expect(select).toHaveValue("system");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
  await select.selectOption("dark");
  await page.reload();
  await expect(select).toHaveValue("dark");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await select.selectOption("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "light");
  await select.selectOption("system");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(select).toHaveValue("system");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("theme preference changes and clearing overrides synchronize across tabs", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  const other = await context.newPage();
  await other.emulateMedia({ colorScheme: "dark" });
  await other.goto("/");
  const select = page.getByRole("combobox", { name: "Color theme" });
  const otherSelect = other.getByRole("combobox", { name: "Color theme" });
  await select.selectOption("light");
  await expect(otherSelect).toHaveValue("light");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
  await otherSelect.selectOption("system");
  await expect(select).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await select.selectOption("light");
  await expect(otherSelect).toHaveValue("light");
  await other.evaluate(() => localStorage.clear());
  await expect(select).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await other.close();
});

test("theme controls still work when browser storage is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage denied", "SecurityError");
      },
    });
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  const select = page.getByRole("combobox", { name: "Color theme" });
  await expect(select).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await select.selectOption("light");
  await expect(select).toHaveValue("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await select.selectOption("system");
  await expect(select).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
