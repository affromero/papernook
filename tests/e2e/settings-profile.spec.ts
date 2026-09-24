import { expect, test, type Page } from "@playwright/test";
import {
  enterHousehold,
  finishHouseholdAdmission,
  selectHouseholdProfile,
} from "./support/household-access";

async function loginAsAdmin(page: Page): Promise<void> {
  await enterHousehold(page);
  await selectHouseholdProfile(page, "Fixture Owner");
}

test.afterEach(async ({ page }) => {
  await page.request.patch("/api/v1/profiles/fixture-owner", {
    data: { avatarSlug: "hummingbird" },
  });
  const response = await page.request.get("/api/v1/agent/model");
  if (response.ok()) {
    const state = await response.json();
    if (state.admin)
      await page.request.put("/api/v1/agent/model", {
        data: { revision: state.revision, provider: "codex", model: null },
      });
  }
});

test("owner saves write-only credentials and explicitly removes them", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/v1/agent/model?probe=1", async (route) => {
    const response = await page.request.get("/api/v1/agent/model");
    await route.fulfill({ response });
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: /^openai:/ }).click();
  const key = page.getByLabel("API key", { exact: true });
  await expect(key).toBeVisible();
  await key.fill("browser-fixture-secret");
  await page
    .getByRole("button", { name: "Save credentials", exact: true })
    .click();
  await expect(key).toHaveValue("");
  const saved = await (await page.request.get("/api/v1/agent/model")).json();
  expect(JSON.stringify(saved)).not.toContain("browser-fixture-secret");
  expect(saved.credentialFields).toContainEqual(
    expect.objectContaining({
      id: "apiKey",
      configured: true,
      source: "stored",
    }),
  );
  await page
    .getByRole("checkbox", {
      name: /Remove all saved settings and credentials/,
    })
    .check();
  await page
    .getByRole("button", { name: "Save credentials", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", {
      name: /Remove all saved settings and credentials/,
    }),
  ).not.toBeChecked();
  const removed = await (await page.request.get("/api/v1/agent/model")).json();
  expect(removed.credentialFields).toContainEqual(
    expect.objectContaining({
      id: "apiKey",
      configured: false,
      source: "unset",
    }),
  );
});

test("household admission preserves Maya's library without granting owner controls", async ({
  page,
}) => {
  await page.goto("/login");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-owner-password-phrase");
  await page
    .locator("form")
    .getByRole("button", { name: "Enter household", exact: true })
    .click();
  await finishHouseholdAdmission(page);
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: "Test selected model" }),
  ).toHaveCount(0);
  const settings = await page.request.get("/api/v1/agent/model");
  expect(settings.status()).toBe(200);
  const body = await settings.json();
  expect(body.admin).toBe(false);
  expect(body).not.toHaveProperty("credentialFields");
});

test("stale owner edits cannot overwrite a change from another session", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: "Test selected model" }),
  ).toBeVisible();
  const before = await (await page.request.get("/api/v1/agent/model")).json();
  const changed = await page.request.put("/api/v1/agent/model", {
    data: { revision: before.revision, model: "other-session-model" },
  });
  expect(changed.status()).toBe(200);
  await page
    .getByRole("switch", { name: "Allow chats to search the web" })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Settings changed in another session" }),
  ).toBeVisible();
  const after = await (await page.request.get("/api/v1/agent/model")).json();
  expect(after.model).toBe("other-session-model");
  expect(after.webAccess).toBe(before.webAccess);
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
  await expect(maya).toContainText("Maya");
  await expect(maya).not.toContainText("admin");

  const jaguar = page.getByRole("radio", { name: "Jaguar" });
  await jaguar.click();
  await expect(jaguar).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save avatar" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Avatar saved." }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: "Account menu for Fixture Owner" })
      .locator("img"),
  ).toHaveAttribute("src", /jaguar\.png/);

  await page.reload();
  await expect(page.getByRole("radio", { name: "Jaguar" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
