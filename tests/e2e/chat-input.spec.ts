import { expect, test, type Page } from "@playwright/test";

const password = "admin-created-password";
const profilePassword = "maya-profile-password";
const pasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+V";
const copyShortcut = process.platform === "darwin" ? "Meta+C" : "Control+C";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await page.getByLabel("Profile password").fill(profilePassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

test("PDF text can be copied and the chat draft stays editable while answering", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  await expect(page.getByText("Page 1 of 3")).toBeVisible();

  const textLayer = page.locator(".textLayer").first();
  await expect(textLayer).toContainText("Attention Is All You Need");
  await textLayer.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press(copyShortcut);
  const copiedPdfText = await page.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(copiedPdfText).toContain("Attention Is All You Need");

  let releaseResponse: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/api/v1/papers/**/chats/*", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await waitForRelease;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "deliberate test delay" }),
    });
  });

  const input = page.getByPlaceholder(/Ask about the paper/);
  await input.fill("First question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(input).toBeEnabled();

  await input.fill("draftx");
  await input.press("Backspace");
  await expect(input).toHaveValue("draft");
  await page.evaluate(() => navigator.clipboard.writeText(" pasted text"));
  await input.press(pasteShortcut);
  await expect(input).toHaveValue("draft pasted text");

  releaseResponse?.();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});
