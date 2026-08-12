import { expect, test, type Page } from "@playwright/test";

const password = "admin-created-password";
const pasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+V";
const copyShortcut = process.platform === "darwin" ? "Meta+C" : "Control+C";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
}

const highlightedCode = [
  "def project(points: torch.Tensor) -> torch.Tensor:",
  "    # points: [batch, xyz]",
  "    return points[:, :2]",
].join("\n");

async function showCodeReply(page: Page): Promise<void> {
  await page.route(
    "**/api/v1/papers/**/chats/0123456789abcdef",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          chat: {
            messages: [
              { role: "user", content: "Show the projection." },
              {
                role: "assistant",
                content: `\`\`\`python\n${highlightedCode}\n\`\`\``,
              },
            ],
          },
        }),
      });
    },
  );
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
}

test("highlighted code copies exact indentation and punctuation", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await showCodeReply(page);

  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(highlightedCode);
});

test("paper header copies the original source link", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");

  await page.getByRole("button", { name: "Copy original paper link" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("https://arxiv.org/abs/1706.03762");
});

test("code copy reports when clipboard access fails", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("clipboard denied")),
      },
    });
  });
  await login(page);
  await showCodeReply(page);

  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByText("Copy failed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Code could not be copied." }),
  ).toHaveText("Code could not be copied.");
});

test("PDF text can be copied and the chat draft stays editable while answering", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  await expect(page.getByText("Page 1 of 3")).toBeVisible();
  await expect(page).toHaveTitle("Attention Is All You Need");

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
